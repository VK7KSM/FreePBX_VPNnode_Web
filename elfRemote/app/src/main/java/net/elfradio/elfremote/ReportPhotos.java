package net.elfradio.elfremote;

import android.content.Context;
import android.graphics.SurfaceTexture;
import android.hardware.Camera;
import android.net.*;
import android.os.*;
import org.json.*;
import java.io.*;
import java.net.HttpURLConnection;
import java.util.*;

/** 文字确认后才进入独立照片队列；相机失败与上传失败不阻塞报告线程。 */
final class ReportPhotos {
    private final Context context;
    private final PairingStore store;
    private final File directory;
    private final HandlerThread thread=new HandlerThread("elfremote-report-photo");
    private final Handler handler;
    private final WakeScheduler wake;
    private final android.hardware.camera2.CameraManager cameraManager;
    private final Map<String,Boolean> available=new HashMap<>();
    private final android.hardware.camera2.CameraManager.AvailabilityCallback availability=new android.hardware.camera2.CameraManager.AvailabilityCallback(){
        @Override public void onCameraAvailable(String id){available.put(id,true);}
        @Override public void onCameraUnavailable(String id){available.put(id,false);}
    };
    interface ManualResult { void complete(JSONObject result,Exception error); }
    private final Map<String,ManualResult> callbacks=new java.util.concurrent.ConcurrentHashMap<>();
    void manual(String id,String deviceId,String facing,ManualResult callback)throws Exception {
        if(!id.matches("[a-zA-Z0-9-]{1,96}")||!java.util.Arrays.asList("front","back").contains(facing))throw new IOException("拍照请求无效");
        if(!directory.isDirectory()&&!directory.mkdirs())throw new IOException("照片队列不可用");
        JSONObject job=new JSONObject().put("report_id",id).put("device_id",deviceId).put("manual",true).put("camera",facing).put("created_at",System.currentTimeMillis()).put("attempts",0);
        callbacks.put(id,callback);RescueFiles.write(jobFile(id),job.toString());resume();
    }
    private volatile boolean stopped;
    private volatile HttpURLConnection connection;
    private boolean busy;
    private Camera camera;
    private SurfaceTexture texture;
    private Runnable cameraTimeout;
    private long captureGeneration;

    ReportPhotos(Context context,PairingStore store){
        this.context=context.getApplicationContext();this.store=store;
        directory=new File(context.getFilesDir(),"report-photos");wake=new WakeScheduler(context);
        thread.start();handler=new Handler(thread.getLooper());
        cameraManager=(android.hardware.camera2.CameraManager)context.getSystemService(Context.CAMERA_SERVICE);
        if(cameraManager!=null)cameraManager.registerAvailabilityCallback(availability,handler);
    }
    private File jobFile(String id){return new File(directory,id+".json");}
    private File imageFile(String id){return new File(directory,id+".jpg");}
    private boolean completed(String id){return context.getSharedPreferences("report-photo-done",0).contains(id);}
    private synchronized void remember(String id){
        android.content.SharedPreferences prefs=context.getSharedPreferences("report-photo-done",0);
        android.content.SharedPreferences.Editor editor=prefs.edit().putLong(id,System.currentTimeMillis());
        List<Map.Entry<String,?>> entries=new ArrayList<>(prefs.getAll().entrySet());
        entries.sort((a,b)->Long.compare(((Number)a.getValue()).longValue(),((Number)b.getValue()).longValue()));
        for(int i=0;i<entries.size()-127;i++)editor.remove(entries.get(i).getKey());
        if(!editor.commit())RuntimeLog.event("report_photo_completion_save_failed");
    }
    synchronized void acknowledged(JSONObject report)throws Exception{
        if(!PhotoPolicy.wanted(report))return;
        String id=report.getString("report_id");if(!id.matches("[a-zA-Z0-9-]{1,96}"))throw new IOException("照片报告编号无效");
        if(completed(id)||jobFile(id).isFile())return;
        long now=System.currentTimeMillis();boolean critical=PhotoPolicy.critical(report);
        android.content.SharedPreferences cadence=context.getSharedPreferences("report-photo-cadence",0);
        if(!critical&&(!PhotoPolicy.recent(now,PhotoPolicy.sampledAt(report))
                ||!PhotoPolicy.due(now,Math.max(cadence.getLong("queued",0),cadence.getLong("captured",0))))){remember(id);return;}
        if(!directory.isDirectory()&&!directory.mkdirs())throw new IOException("照片队列不可用");
        File[] queued=directory.listFiles((dir,name)->name.endsWith(".json"));
        if(queued!=null&&queued.length>=16){RuntimeLog.event("report_photo_skipped reason=queue_full");remember(id);return;}
        JSONObject job=new JSONObject().put("report_id",id).put("device_id",report.getString("device_id"))
                .put("critical",PhotoPolicy.critical(report)).put("created_at",System.currentTimeMillis()).put("attempts",0);
        RescueFiles.write(jobFile(id),job.toString());
        if(!critical&&!cadence.edit().putLong("queued",now).commit())throw new IOException("拍照间隔保存失败");
        RuntimeLog.event("report_photo_queued critical="+job.getBoolean("critical"));resume();
    }
    void resume(){if(!stopped)handler.post(this::process);}
    private void process(){
        if(stopped||busy)return;
        try{
            File[] files=directory.listFiles((dir,name)->name.endsWith(".json"));if(files==null||files.length==0)return;
            List<JSONObject> jobs=new ArrayList<>();long now=System.currentTimeMillis(),next=Long.MAX_VALUE;
            for(File file:files){
                JSONObject job;
                try{job=new JSONObject(RescueFiles.read(file,4096));}
                catch(Exception error){RuntimeLog.error("report_photo_queue_invalid",error);file.renameTo(new File(file.getPath()+".invalid"));continue;}
                String id=job.getString("report_id");
                if(completed(id)||!store.deviceId().equals(job.optString("device_id"))||now-job.optLong("created_at")>86400000L){discard(job);continue;}
                if(job.optLong("next_at")>now){next=Math.min(next,job.getLong("next_at")-now);continue;}
                jobs.add(job);
            }
            if(jobs.isEmpty()){if(next<Long.MAX_VALUE)wake.schedule("report-photo",next);return;}
            jobs.sort((a,b)->a.optBoolean("critical")!=b.optBoolean("critical")?(a.optBoolean("critical")?-1:1):Long.compare(a.optLong("created_at"),b.optLong("created_at")));
            JSONObject job=jobs.get(0);busy=true;
            if(allowedNetwork(job)==null){failed(job,new Paused());return;}
            WakeScheduler.hold(context,"report-photo",60000L);
            if(imageFile(job.getString("report_id")).isFile())upload(job);
            else if(!job.optBoolean("manual")&&!job.optBoolean("critical")&&(!PhotoPolicy.recent(now,job.optLong("created_at"))
                    ||!PhotoPolicy.due(now,context.getSharedPreferences("report-photo-cadence",0).getLong("captured",0)))){discard(job);finished();}
            else capture(job);
        }catch(Exception error){RuntimeLog.error("report_photo_queue_failed",error);busy=false;WakeScheduler.release("report-photo");wake.schedule("report-photo",60000L);}
    }
    private Network allowedNetwork(JSONObject job){
        ConnectivityManager cm=(ConnectivityManager)context.getSystemService(Context.CONNECTIVITY_SERVICE);
        Network n=cm.getActiveNetwork();NetworkCapabilities caps=n==null?null:cm.getNetworkCapabilities(n);
        return caps!=null&&(job.optBoolean("manual")||PhotoPolicy.networkAllowed(caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI),true,job.optBoolean("critical")))?n:null;
    }
    private void cameraPermission()throws Exception{
        if(context.checkSelfPermission(android.Manifest.permission.CAMERA)==android.content.pm.PackageManager.PERMISSION_GRANTED)return;
        throw new IOException("相机权限初始化尚未完成");
    }
    private void capture(JSONObject job){
        final long generation=++captureGeneration;
        try{
            cameraPermission();int id=-1;Camera.CameraInfo info=new Camera.CameraInfo();
            for(int i=0;i<Camera.getNumberOfCameras();i++){Camera.getCameraInfo(i,info);if(info.facing==("back".equals(job.optString("camera"))?Camera.CameraInfo.CAMERA_FACING_BACK:Camera.CameraInfo.CAMERA_FACING_FRONT)){id=i;break;}}
            if(id<0&&job.optBoolean("manual")&&Camera.getNumberOfCameras()>0){id=0;Camera.getCameraInfo(id,info);}
            if(id<0)throw new Permanent("没有可用摄像头");
            if(Boolean.FALSE.equals(available.get(String.valueOf(id))))throw new IOException("前置摄像头正在使用");
            camera=Camera.open(id);
            Camera.Parameters p=camera.getParameters();
            List<Camera.Size> sizes=p.getSupportedPictureSizes();sizes.sort((a,b)->Integer.compare(a.width*a.height,b.width*b.height));
            Camera.Size chosen=sizes.get(0);for(Camera.Size size:sizes)if(size.width*size.height<=640*480)chosen=size;
            p.setPictureSize(chosen.width,chosen.height);p.setJpegQuality(70);p.setRotation(info.orientation);
            camera.setParameters(p);texture=new SurfaceTexture(0);camera.setPreviewTexture(texture);camera.startPreview();
            cameraTimeout=()->{if(generation!=captureGeneration)return;releaseCamera();failed(job,new IOException("拍照超时"));};handler.postDelayed(cameraTimeout,8000L);
            handler.postDelayed(()->{
                if(stopped||camera==null||generation!=captureGeneration)return;
                try{camera.takePicture(null,null,(bytes,ignored)->{
                    if(generation!=captureGeneration)return;
                    releaseCamera();
                    try{
                        if(stopped)return;
                        if(bytes==null||bytes.length<4||bytes.length>PhotoPolicy.MAX_BYTES)throw new Permanent("照片大小无效");
                        File file=imageFile(job.getString("report_id"));
                        File temporary=new File(file.getPath()+".tmp");
                        try(FileOutputStream out=new FileOutputStream(temporary)){out.write(bytes);out.getFD().sync();}
                        if(!temporary.renameTo(file))throw new IOException("照片缓存提交失败");
                        long captured=System.currentTimeMillis();
                        if(!job.optBoolean("manual")&&!context.getSharedPreferences("report-photo-cadence",0).edit().putLong("captured",captured).commit())throw new IOException("拍摄时间保存失败");
                        job.put("captured_at",captured);RescueFiles.write(jobFile(job.getString("report_id")),job.toString());
                        RuntimeLog.event("report_photo_captured bytes="+bytes.length);upload(job);
                    }catch(Exception error){failed(job,error);}
                });}catch(Exception error){releaseCamera();failed(job,error);}
            },600L);
        }catch(Exception error){releaseCamera();failed(job,error);}
    }
    private void upload(JSONObject job){
        try{
            Network network=allowedNetwork(job);if(network==null)throw new Paused();
            String id=job.getString("report_id");File file=imageFile(id);
            long captured=job.optLong("captured_at",file.lastModified());String sha=RescueFiles.sha256(file);
            String url=Protocol.BASE_URL+"/api/elfremote/report-photo?device_id="+java.net.URLEncoder.encode(store.deviceId(),"UTF-8")
                    +"&report_id="+id+"&captured_at="+captured;
            HttpURLConnection c=(HttpURLConnection)network.openConnection(Protocol.requireHttpsUrl(url));connection=c;
            c.setRequestMethod("POST");c.setDoOutput(true);c.setInstanceFollowRedirects(false);c.setConnectTimeout(15000);c.setReadTimeout(20000);
            c.setRequestProperty("Authorization","Bearer "+store.token());c.setRequestProperty("Content-Type","image/jpeg");c.setFixedLengthStreamingMode(file.length());
            try(InputStream in=new FileInputStream(file);OutputStream out=c.getOutputStream()){
                byte[] buf=new byte[8192];int n;while((n=in.read(buf))!=-1){if(stopped)return;if(!network.equals(allowedNetwork(job)))throw new Paused();out.write(buf,0,n);}
            }
            int status=c.getResponseCode();if(status>=400&&status<500&&status!=429)throw new Permanent("照片上传被拒绝 HTTP "+status);
            if(status!=200)throw new IOException("照片服务暂不可用");
            try(InputStream in=c.getInputStream();ByteArrayOutputStream out=new ByteArrayOutputStream()){
                byte[] buf=new byte[1024];int n;while((n=in.read(buf))!=-1){if(out.size()+n>4096)throw new IOException("照片回执过大");out.write(buf,0,n);}
                JSONObject result=new JSONObject(out.toString("UTF-8"));
                if(!result.optBoolean("ok")||!sha.equals(result.optString("sha256"))||file.length()!=result.optLong("bytes"))throw new IOException("照片回执不匹配");
            }
            RuntimeLog.event("report_photo_uploaded bytes="+file.length());
            ManualResult callback=callbacks.remove(id);if(callback!=null)callback.complete(new JSONObject().put("type","result").put("report_id",id).put("captured_at",captured).put("message","照片已保存"),null);
            discard(job);finished();
        }catch(Exception error){failed(job,error);}
        finally{HttpURLConnection c=connection;connection=null;if(c!=null)c.disconnect();}
    }
    private void failed(JSONObject job,Exception error){
        if(stopped)return;
        try{
            if(error instanceof Paused){job.put("next_at",System.currentTimeMillis()+900000L);RuntimeLog.event("report_photo_waiting_wifi");}
            else{
                int n=job.optInt("attempts")+1;job.put("attempts",n);RuntimeLog.error("report_photo_failed attempt="+n,error);
                if(error instanceof Permanent||n>=3){ManualResult callback=callbacks.remove(job.getString("report_id"));if(callback!=null)callback.complete(null,error);discard(job);finished();return;}
                job.put("next_at",System.currentTimeMillis()+(n==1?30000L:120000L));
            }
            RescueFiles.write(jobFile(job.getString("report_id")),job.toString());
        }catch(Exception failed){RuntimeLog.error("report_photo_retry_save_failed",failed);busy=false;WakeScheduler.release("report-photo");wake.schedule("report-photo",60000L);return;}
        finished();
    }
    private void discard(JSONObject job)throws Exception{
        String id=job.getString("report_id");remember(id);jobFile(id).delete();imageFile(id).delete();new File(imageFile(id).getPath()+".tmp").delete();
    }
    private void finished(){busy=false;WakeScheduler.release("report-photo");if(!stopped)handler.post(this::process);}
    private void releaseCamera(){
        captureGeneration++;
        if(cameraTimeout!=null)handler.removeCallbacks(cameraTimeout);cameraTimeout=null;
        if(camera!=null){Camera current=camera;camera=null;
            try{current.stopPreview();}catch(Exception error){RuntimeLog.error("report_photo_preview_stop_failed",error);}
            try{current.release();}catch(Exception error){RuntimeLog.error("report_photo_camera_release_failed",error);}
        }
        if(texture!=null){texture.release();texture=null;}
    }
    void close(){stopped=true;HttpURLConnection c=connection;if(c!=null)c.disconnect();
        if(cameraManager!=null)cameraManager.unregisterAvailabilityCallback(availability);
        handler.post(()->{releaseCamera();WakeScheduler.release("report-photo");thread.quitSafely();});}
    private static final class Paused extends IOException {}
    private static final class Permanent extends IOException {Permanent(String text){super(text);}}
}
