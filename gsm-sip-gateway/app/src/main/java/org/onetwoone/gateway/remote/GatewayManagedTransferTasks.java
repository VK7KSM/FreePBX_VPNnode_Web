package org.onetwoone.gateway.remote;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

/** Persistent D22-compatible send_file/get_file executor for the Pixel gateway. */
final class GatewayManagedTransferTasks {
    private static final int CHUNK=8*1024*1024;
    private final Context context;private final GatewayRemoteStore store;private final Runnable changed;
    private final File activeFile,base;private volatile boolean running,stopped;private volatile HttpURLConnection connection;
    GatewayManagedTransferTasks(Context context,GatewayRemoteStore store,Runnable changed){
        this.context=context.getApplicationContext();this.store=store;this.changed=changed;
        base=new File(context.getFilesDir(),"gateway-transfer-tasks");
        activeFile=new File(context.getFilesDir(),"gateway-transfer-active-"+hashDevice(store.deviceId())+".json");
    }
    synchronized void accept(JSONObject envelope){
        JSONObject offer=envelope==null?null:envelope.optJSONObject("managed_task");if(offer==null)return;
        String type=offer.optString("type");boolean compatible="send_file".equals(type)&&offer.optBoolean("managed_file_v1")
                ||"get_file".equals(type)&&offer.optBoolean("managed_file_return_v1");if(!compatible)return;
        try{
            JSONObject task=validate(offer),saved=receipts().read(task.getString("id"));
            if(saved!=null){if(!saved.optBoolean("acknowledged"))post(saved);clearIfSame(task.getString("id"));return;}
            if(activeFile.exists()){
                JSONObject active=GatewayUpdateProgress.read(activeFile);
                if(!task.getString("id").equals(active.getJSONObject("task").getString("id")))return;
                active.put("task",task);GatewayUpdateProgress.write(activeFile,active);
            }else GatewayUpdateProgress.write(activeFile,new JSONObject().put("task",task).put("phase","queued"));
            if(task.optBoolean("cancel_requested"))cancel(task.getString("id"));start();
        }catch(Exception ignored){}
    }
    synchronized void tick(){if(activeFile.exists())start();}
    synchronized void close(){stopped=true;HttpURLConnection current=connection;if(current!=null)current.disconnect();}
    private synchronized void start(){if(running||stopped)return;running=true;new Thread(()->{try{execute();}finally{synchronized(this){running=false;}}},"gateway-file-transfer").start();}

    private void execute(){String id="";File dir=null;android.os.PowerManager.WakeLock wake=null;try{
        android.os.PowerManager power=context.getSystemService(android.os.PowerManager.class);if(power!=null){wake=power.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK,"elfRemote:gateway-file-transfer");wake.acquire(31*60*1000L);}
        JSONObject active=GatewayUpdateProgress.read(activeFile),task=validate(active.getJSONObject("task"));id=task.getString("id");dir=taskDir(id);
        if(!dir.isDirectory()&&!dir.mkdirs())throw new IOException("transfer directory unavailable");
        JSONObject saved=receipts().read(id);if(saved!=null){if(!saved.optBoolean("acknowledged"))post(saved);clear();cleanup(dir);return;}
        String phase=active.optString("phase","queued");check(task,dir);
        if("queued".equals(phase)){post(progress(id,"claimed","file-transfer-claimed",null));active.put("phase","claimed");GatewayUpdateProgress.write(activeFile,active);}
        post(progress(id,"running","file-transfer-running",null));active.put("phase","running");GatewayUpdateProgress.write(activeFile,active);
        JSONObject result="send_file".equals(task.getString("type"))?receive(task,dir):returnFile(task,dir);
        terminal(id,"success","file-transfer-complete",result);cleanup(dir);
    }catch(Permanent failure){finishFailure(id,dir,failure.getMessage());
    }catch(Exception unavailable){
        if(stopped)return;
        try{
            if(id.isEmpty()){clear();return;}
            JSONObject task=GatewayUpdateProgress.read(activeFile).getJSONObject("task");
            if(task.optBoolean("cancel_requested")||new File(dir,"cancel").exists())finishFailure(id,dir,"cancelled");
            else if(System.currentTimeMillis()>=task.getLong("expires_at"))finishFailure(id,dir,"expired");
            else {post(progress(id,"running","file-transfer-retry",null));changed.run();}
        }catch(Exception ignored){}
    }finally{connection=null;if(wake!=null&&wake.isHeld())wake.release();}}

    private JSONObject receive(JSONObject task,File dir)throws Exception {
        JSONObject p=task.getJSONObject("params");requireNetwork(true);String id=task.getString("id");
        String baseUrl=GatewayRemotePolicy.BASE_URL+"/api/elfremote/file-download?id="+enc(p.getString("transfer_id"))
                +"&device_id="+enc(store.deviceId())+"&task_id="+enc(id);
        JSONObject manifest=getJson(baseUrl,store.token()).getJSONObject("file");long size=p.getLong("size");
        if(size<0||size>GatewayFileCommit.MAX_BYTES||size!=manifest.getLong("size")||CHUNK!=manifest.getInt("chunk_size")
                ||!p.getString("sha256").equals(manifest.getString("sha256")))throw new Permanent("manifest-mismatch");
        File payload=new File(dir,"payload.part");if(payload.length()>size)throw new Permanent("local-size-invalid");
        if(dir.getUsableSpace()<size-payload.length()+GatewayFileCommit.SPACE_RESERVE)throw new Permanent("insufficient-space");
        try(RandomAccessFile out=new RandomAccessFile(payload,"rw")){
            for(int index=0;(long)index*CHUNK<size;index++){
                check(task,dir);long begin=(long)index*CHUNK,bytes=Math.min(CHUNK,size-begin),have=Math.max(0,Math.min(bytes,out.length()-begin));
                JSONObject part=manifest.getJSONObject("parts").getJSONObject(String.valueOf(index));
                if(part.getLong("bytes")!=bytes)throw new Permanent("chunk-size-mismatch");
                if(have<bytes)downloadPart(baseUrl+"&part="+index,store.token(),out,begin,have,bytes,task,dir);
                if(!segmentHash(out,begin,bytes).equals(part.getString("sha256"))){out.setLength(begin);throw new IOException("chunk verification failed");}
            }
            out.getFD().sync();
        }
        check(task,dir);if(!sha256(payload).equals(p.getString("sha256")))throw new Permanent("file-hash-mismatch");
        JSONObject commit=new JSONObject(p.toString()).put("source",payload.getCanonicalPath());
        JSONObject root=runRoot("commit",dir,commit,task);
        return new JSONObject().put("stage","file").put("action","committed").put("bytes",root.getLong("bytes"))
                .put("sha256",root.getString("sha256")).put("text","").put("truncated",false).put("exit_code",0);
    }

    private JSONObject returnFile(JSONObject task,File dir)throws Exception {
        JSONObject p=task.getJSONObject("params");requireNetwork(p.optBoolean("allow_cellular"));String id=task.getString("id");
        File snapshot=new File(dir,"snapshot.bin");JSONObject info;
        if(snapshot.isFile())info=new JSONObject().put("bytes",snapshot.length()).put("sha256",sha256(snapshot));
        else info=runRoot("snapshot",dir,new JSONObject().put("path",p.getString("path"))
                .put("target",snapshot.getCanonicalPath()).put("uid",android.os.Process.myUid()),task);
        long size=info.getLong("bytes");String hash=info.getString("sha256");
        if(size<0||size>GatewayFileCommit.MAX_BYTES||!snapshot.isFile()||snapshot.length()!=size)throw new Permanent("snapshot-invalid");
        String url=GatewayRemotePolicy.BASE_URL+"/api/elfremote/file-return?device_id="+enc(store.deviceId())+"&task_id="+enc(id);
        JSONObject remote=requestJson(url,store.token(),"POST",new JSONObject().put("action","init").put("size",size).put("sha256",hash).toString().getBytes(StandardCharsets.UTF_8),p.optBoolean("allow_cellular"),task,dir).getJSONObject("file");
        if(remote.getLong("size")!=size||!hash.equals(remote.getString("sha256")))throw new Permanent("snapshot-mismatch");
        long sent=0;MessageDigest complete=MessageDigest.getInstance("SHA-256");
        try(InputStream in=new FileInputStream(snapshot)){
            for(int index=0;sent<size;index++){
                check(task,dir);int count=(int)Math.min(CHUNK,size-sent);byte[] bytes=new byte[count];int at=0,n;
                while(at<count&&(n=in.read(bytes,at,count-at))!=-1)at+=n;if(at!=count)throw new Permanent("snapshot-changed");
                complete.update(bytes);String partHash=GatewayFileCommit.hex(MessageDigest.getInstance("SHA-256").digest(bytes));
                JSONObject old=remote.getJSONObject("parts").optJSONObject(String.valueOf(index));
                if(old!=null&&!partHash.equals(old.optString("sha256")))throw new Permanent("remote-chunk-mismatch");
                if(old==null)putBytes(url+"&part="+index+"&sha256="+partHash,store.token(),bytes,p.optBoolean("allow_cellular"),task,dir);
                sent+=count;
            }
        }
        if(!hash.equals(GatewayFileCommit.hex(complete.digest())))throw new Permanent("snapshot-hash-mismatch");
        JSONObject done=requestJson(url,store.token(),"POST",new JSONObject().put("action","complete").toString().getBytes(StandardCharsets.UTF_8),p.optBoolean("allow_cellular"),task,dir).getJSONObject("file");
        if(!"ready".equals(done.optString("state"))||!hash.equals(done.optString("sha256")))throw new IOException("completion not acknowledged");
        return new JSONObject().put("stage","file").put("action","uploaded").put("bytes",size).put("sha256",hash)
                .put("text","").put("truncated",false).put("exit_code",0);
    }

    private JSONObject runRoot(String operation,File dir,JSONObject params,JSONObject task)throws Exception {
        File request=new File(dir,"request.json");GatewayUpdateProgress.write(request,params);String token=GatewayWifiConnector.randomToken();Process process=null;
        long deadline=android.os.SystemClock.elapsedRealtime()+1_850_000L;
        try(ServerSocket server=new ServerSocket(0,1,InetAddress.getByName("127.0.0.1"))){
            server.setSoTimeout(1_850_000);String command="export CLASSPATH="+GatewayWifiConnector.quote(context.getApplicationInfo().sourceDir)
                    +"; exec /system/bin/app_process /system/bin org.onetwoone.gateway.remote.GatewayFileRootMain "+operation+" "
                    +GatewayWifiConnector.quote(request.getCanonicalPath())+" "+server.getLocalPort()+" "+token+" </dev/null >/dev/null 2>&1";
            process=new ProcessBuilder("su","-c",command).start();JSONObject reply;
            try(Socket socket=server.accept()){socket.setSoTimeout((int)Math.max(1,deadline-android.os.SystemClock.elapsedRealtime()));reply=GatewayWifiConnector.readRootResult(new DataInputStream(socket.getInputStream()),token);}
            long remaining=deadline-android.os.SystemClock.elapsedRealtime();
            if(remaining<=0||!process.waitFor(remaining,TimeUnit.MILLISECONDS)){process.destroy();throw new IOException("file helper timeout");}
            check(task,dir);if(process.exitValue()!=0||!reply.optBoolean("ok"))throw new Permanent(reply.optString("error","file-helper-rejected"));
            return reply.getJSONObject("result");
        }finally{if(process!=null&&process.isAlive())process.destroy();request.delete();}
    }

    private void downloadPart(String url,String token,RandomAccessFile out,long begin,long have,long size,JSONObject task,File dir)throws Exception {
        Exception last=null;for(Proxy route:GatewayProxyRoute.attempts())try{
            long current=Math.max(have,Math.max(0,Math.min(size,out.length()-begin)));
            HttpURLConnection c=open(url,route,"GET",token,-1);connection=c;if(current>0)c.setRequestProperty("Range","bytes="+current+"-");
            try{
                int code=c.getResponseCode();if(code!=(current>0?206:200)||c.getContentLengthLong()!=size-current)throw new IOException("range response mismatch");
                if(current>0&&!(("bytes "+current+"-"+(size-1)+"/"+size).equals(c.getHeaderField("Content-Range"))))throw new IOException("range position mismatch");
                out.seek(begin+current);long received=current;try(InputStream in=c.getInputStream()){byte[] buffer=new byte[65536];int count;
                    while((count=in.read(buffer))!=-1){check(task,dir);received+=count;if(received>size)throw new Permanent("chunk-overflow");out.write(buffer,0,count);}}
                out.getFD().sync();if(received!=size)throw new IOException("chunk interrupted");GatewayProxyRoute.succeeded(route);return;
            }finally{c.disconnect();connection=null;}
        }catch(Permanent rejected){throw rejected;}catch(IOException unavailable){last=unavailable;}
        throw last==null?new IOException("download unavailable"):last;
    }
    private JSONObject getJson(String url,String token)throws Exception{return requestJson(url,token,"GET",null,false,null,null);}
    private void putBytes(String url,String token,byte[] bytes,boolean cellular,JSONObject task,File dir)throws Exception {requestJson(url,token,"PUT",bytes,cellular,task,dir);}
    private JSONObject requestJson(String url,String token,String method,byte[] body,boolean cellular,JSONObject task,File dir)throws Exception {
        Exception last=null;for(Proxy route:GatewayProxyRoute.attempts())try{
            if(task!=null){requireNetwork(cellular);check(task,dir);}HttpURLConnection c=open(url,route,method,token,body==null?-1:body.length);connection=c;
            try{
                if(body!=null){c.setRequestProperty("Content-Type","PUT".equals(method)?"application/octet-stream":"application/json");try(OutputStream out=c.getOutputStream()){for(int at=0;at<body.length;at+=65536){if(task!=null){check(task,dir);requireNetwork(cellular);}out.write(body,at,Math.min(65536,body.length-at));}}}
                int code=c.getResponseCode();if(code>=400&&code<500&&code!=429)throw new Permanent("HTTP-"+code);if(code!=200)throw new IOException("HTTP-"+code);
                try(InputStream in=c.getInputStream();ByteArrayOutputStream out=new ByteArrayOutputStream()){byte[] buffer=new byte[4096];int count;while((count=in.read(buffer))!=-1){if(out.size()+count>150000)throw new IOException("response too large");out.write(buffer,0,count);}
                    JSONObject result=new JSONObject(out.toString("UTF-8"));if(!result.optBoolean("ok"))throw new IOException("operation not acknowledged");GatewayProxyRoute.succeeded(route);return result;}
            }finally{c.disconnect();connection=null;}
        }catch(Permanent rejected){throw rejected;}catch(IOException unavailable){last=unavailable;}
        throw last==null?new IOException("file service unavailable"):last;
    }
    private HttpURLConnection open(String value,Proxy route,String method,String token,long length)throws Exception {
        URL url=new URL(value);if(!"https".equals(url.getProtocol())||!"v.elfradio.net".equalsIgnoreCase(url.getHost())||url.getPort()!=-1)throw new SecurityException("invalid file URL");
        HttpURLConnection c=(HttpURLConnection)GatewayProxyRoute.open(url,route);c.setConnectTimeout(15000);c.setReadTimeout(30000);c.setInstanceFollowRedirects(false);c.setRequestMethod(method);c.setRequestProperty("Authorization","Bearer "+token);c.setRequestProperty("Accept-Encoding","identity");
        if(length>=0){c.setDoOutput(true);c.setFixedLengthStreamingMode(length);}return c;
    }
    private void requireNetwork(boolean cellular)throws IOException {
        ConnectivityManager cm=context.getSystemService(ConnectivityManager.class);NetworkCapabilities caps=cm==null?null:cm.getNetworkCapabilities(cm.getActiveNetwork());
        if(caps==null||(!cellular&&caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)))throw new IOException("network policy paused");
    }
    private void check(JSONObject task,File dir)throws Exception {
        if(stopped)throw new IOException("service stopping");if(task.optBoolean("cancel_requested")||new File(dir,"cancel").exists())throw new Permanent("cancelled");
        if(System.currentTimeMillis()>=task.getLong("expires_at"))throw new Permanent("expired");
    }
    private static JSONObject validate(JSONObject task)throws Exception {
        if(task==null||!task.optString("id").matches("[A-Za-z0-9-]{1,96}")||task.optLong("expires_at")<=0)throw new IOException("invalid task");
        String type=task.optString("type");JSONObject p=task.getJSONObject("params");
        if("send_file".equals(type)){
            if(!p.optString("transfer_id").matches("[a-f0-9]{32}")||p.optLong("size",-1)<0||p.optLong("size")>GatewayFileCommit.MAX_BYTES
                    ||!p.optString("sha256").matches("[a-f0-9]{64}")||p.optInt("chunk_size")!=CHUNK)throw new IOException("invalid send file task");
            path(p.getString("path"));
        }else if("get_file".equals(type))path(p.getString("path"));else throw new IOException("invalid transfer type");
        return task;
    }
    private static void path(String value)throws IOException {if(value==null||!value.startsWith("/")||value.endsWith("/")||value.length()>512||value.indexOf('\0')>=0)throw new IOException("invalid path");for(String part:value.split("/"))if(".".equals(part)||"..".equals(part))throw new IOException("invalid path");}
    private void cancel(String id)throws Exception {File dir=taskDir(id);if(!dir.isDirectory()&&!dir.mkdirs())throw new IOException("transfer directory unavailable");if(!new File(dir,"cancel").exists()&&!new File(dir,"cancel").createNewFile())throw new IOException("cancel unavailable");HttpURLConnection current=connection;if(current!=null)current.disconnect();}
    private void finishFailure(String id,File dir,String reason){try{terminal(id,"failed","file-transfer-"+reason,failure(reason));cleanup(dir);}catch(Exception ignored){}}
    private static JSONObject failure(String action)throws Exception{return new JSONObject().put("stage","file").put("action",action).put("exit_code",1).put("elapsed_ms",0).put("text","").put("truncated",false);}
    private void terminal(String id,String state,String detail,JSONObject result)throws Exception {JSONObject body=progress(id,state,detail,result);receipts().save(body);post(body);clear();changed.run();}
    private JSONObject progress(String id,String state,String detail,JSONObject result)throws Exception {JSONObject body=new JSONObject().put("device_id",store.deviceId()).put("task_id",id).put("state",state).put("detail",detail);if(result!=null)body.put("result",result);return body;}
    private void post(JSONObject body)throws Exception {JSONObject reply=GatewayRemoteHttp.request("/api/elfremote/task-progress",new JSONObject(body.toString()).put("token",store.token())),task=reply.optJSONObject("task");String state=body.getString("state"),id=body.getString("task_id");if(task==null||!id.equals(task.optString("id"))||!(state.equals(task.optString("state"))||("claimed".equals(state)&&"running".equals(task.optString("state")))))throw new IOException("task acknowledgement missing");if(GatewayTaskReceipts.terminal(state))receipts().acknowledge(id);}
    private File taskDir(String id)throws Exception{return new File(base,GatewayRemoteStore.hash(id));}
    private void clear()throws Exception {if(activeFile.exists()&&!activeFile.delete())throw new IOException("active transfer cleanup failed");}
    private void clearIfSame(String id)throws Exception {if(!activeFile.exists())return;JSONObject active=GatewayUpdateProgress.read(activeFile);if(id.equals(active.getJSONObject("task").optString("id")))clear();}
    private static void cleanup(File file){if(file==null||!file.exists())return;File[] children=file.listFiles();if(children!=null)for(File child:children)cleanup(child);file.delete();}
    private GatewayTaskReceipts receipts(){return new GatewayTaskReceipts(new File(context.getFilesDir(),"gateway-task-receipts/"+hashDevice(store.deviceId())));}
    private static String hashDevice(String id){try{return GatewayRemoteStore.hash(id);}catch(Exception ignored){return "unpaired";}}
    private static String enc(String value)throws Exception{return URLEncoder.encode(value,"UTF-8");}
    private static String sha256(File file)throws Exception {MessageDigest digest=MessageDigest.getInstance("SHA-256");try(InputStream in=new FileInputStream(file)){byte[] buffer=new byte[65536];int count;while((count=in.read(buffer))!=-1)digest.update(buffer,0,count);}return GatewayFileCommit.hex(digest.digest());}
    static String segmentHash(RandomAccessFile file,long start,long length)throws Exception {MessageDigest digest=MessageDigest.getInstance("SHA-256");file.seek(start);byte[] buffer=new byte[65536];while(length>0){int count=file.read(buffer,0,(int)Math.min(buffer.length,length));if(count<0)throw new EOFException();digest.update(buffer,0,count);length-=count;}return GatewayFileCommit.hex(digest.digest());}
    private static final class Permanent extends IOException{Permanent(String message){super(message);}}
}
