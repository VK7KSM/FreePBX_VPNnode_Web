package net.elfradio.elfremote;
import android.content.Context;
import android.net.*;
import org.json.*;
import java.io.*;
import java.net.HttpURLConnection;

final class FileReturn {
    private final Context context;
    private final FileTransfer.Reporter reporter;
    private final TaskReceipts receipts;
    private volatile boolean busy,stopped,cancelled;
    private volatile HttpURLConnection connection;
    private String current;
    FileReturn(Context context,FileTransfer.Reporter reporter,TaskReceipts receipts){this.context=context;this.reporter=reporter;this.receipts=receipts;}
    synchronized void receive(JSONObject offer,String device,String token)throws Exception{
        String id=offer.getString("id");if(!id.matches("[a-zA-Z0-9-]{1,64}"))throw new IOException("文件任务编号无效");
        if(busy){if(id.equals(current)&&offer.optBoolean("cancel_requested")){cancelled=true;if(connection!=null)connection.disconnect();}return;}
        if(offer.has("local_device")&&!device.equals(offer.optString("local_device")))throw new IOException("旧设备实例文件任务");
        offer.put("local_device",device);File active=new File(context.getFilesDir(),"file-return-active.json");RescueFiles.write(active,offer.toString());
        busy=true;current=id;cancelled=offer.optBoolean("cancel_requested");
        new Thread(()->{
            File dir=new File(context.getFilesDir(),"file-return/"+id),snapshot=new File(dir,"snapshot.bin");
            try{
                JSONObject saved=receipts.read(id);if(saved!=null){if(!saved.optBoolean("acknowledged"))reporter.send(id,saved.getString("state"),saved.optString("detail"),saved.optJSONObject("result"));cleanup(active,dir);return;}
                check(offer);if(!dir.isDirectory()&&!dir.mkdirs())throw new IOException("无法创建文件快照目录");
                JSONObject p=offer.getJSONObject("params");if(network(p)==null)throw new Paused();
                WakeScheduler.hold(context,"file-return",1800000L);
                reporter.send(id,"claimed","设备已接收取回文件任务",null);reporter.send(id,"running","正在准备文件快照",null);
                JSONObject core=CoreClient.request("/jobs/"+id,null);
                if(core==null)core=CoreClient.request("/file-snapshot",new JSONObject().put("id",id).put("params",new JSONObject().put("source",p.getString("path")).put("target",snapshot.getPath()).put("uid",android.os.Process.myUid())));
                long end=android.os.SystemClock.elapsedRealtime()+1800000L;
                while("running".equals(core.optString("state"))){
                    if(cancelled)CoreClient.request("/jobs/"+id+"/cancel",new JSONObject());
                    check(offer);if(android.os.SystemClock.elapsedRealtime()>end)throw new IOException("等待文件快照超时");Thread.sleep(1000);core=CoreClient.request("/jobs/"+id,null);
                }
                if(!"snapshot".equals(core.optString("action")))throw new Permanent(core.optString("error","文件快照失败"));
                long size=core.getLong("bytes");String hash=core.getString("sha256");if(!snapshot.isFile()||snapshot.length()!=size)throw new Permanent("文件快照不可用");
                String url=Protocol.BASE_URL+"/api/elfremote/file-return?device_id="+java.net.URLEncoder.encode(device,"UTF-8")+"&task_id="+id;
                JSONObject m=json(url,token,p,new JSONObject().put("action","init").put("size",size).put("sha256",hash)).getJSONObject("file");
                if(m.getLong("size")!=size||!hash.equals(m.getString("sha256")))throw new Permanent("服务器文件快照不一致");
                long sent=0,last=0;java.security.MessageDigest complete=java.security.MessageDigest.getInstance("SHA-256");
                try(InputStream in=new FileInputStream(snapshot)){
                    for(int index=0;sent<size;index++){
                        check(offer);int count=(int)Math.min(8*1024*1024,size-sent);byte[] bytes=new byte[count];int at=0,n;
                        while(at<count&&(n=in.read(bytes,at,count-at))!=-1)at+=n;if(at!=count)throw new Permanent("文件快照长度变化");
                        complete.update(bytes);String partHash=FileCommit.hex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
                        JSONObject old=m.getJSONObject("parts").optJSONObject(String.valueOf(index));
                        if(old!=null&&!partHash.equals(old.optString("sha256")))throw new Permanent("已上传分块与快照不一致");
                        if(old==null)upload(url+"&part="+index+"&sha256="+partHash,token,p,bytes,offer);
                        sent+=count;if(System.currentTimeMillis()-last>30000){reporter.send(id,"running","上传到服务器 "+sent*100/Math.max(1,size)+"%",null);last=System.currentTimeMillis();}
                    }
                }
                check(offer);if(!hash.equals(FileCommit.hex(complete.digest())))throw new Permanent("文件快照完整校验失败");
                JSONObject done=json(url,token,p,new JSONObject().put("action","complete")).getJSONObject("file");
                if(!"ready".equals(done.optString("state"))||!hash.equals(done.optString("sha256")))throw new IOException("文件取回回执不匹配");
                reporter.send(id,"success","文件已取回，可下载",new JSONObject().put("action","uploaded").put("bytes",size).put("sha256",hash));cleanup(active,dir);
            }catch(Paused e){try{reporter.send(id,"running","已暂停，等待 Wi-Fi 后继续取回",null);}catch(Exception ignored){}new WakeScheduler(context).schedule("file-return",900000L);
            }catch(Exception error){RuntimeLog.error("file_return_pending",error);if(stopped)return;
                try{
                    if(receipts.read(id)!=null){new WakeScheduler(context).schedule("file-return",60000L);return;}
                    File failures=new File(dir,"failures");int count=failures.isFile()?Integer.parseInt(RescueFiles.read(failures,20)):0;count++;if(dir.isDirectory())RescueFiles.write(failures,String.valueOf(count));
                    if(cancelled||error instanceof Permanent||count>=3||offer.optLong("expires_at")<=System.currentTimeMillis()){
                        reporter.send(id,"failed",cancelled?"文件取回已停止":error.getMessage(),null);cleanup(active,dir);
                    }else{reporter.send(id,"running","上传中断，稍后继续取回",null);new WakeScheduler(context).schedule("file-return",count*60000L);}
                }catch(Exception pending){RuntimeLog.error("file_return_result_pending",pending);new WakeScheduler(context).schedule("file-return",60000L);}
            }finally{busy=false;HttpURLConnection c=connection;connection=null;if(c!=null)c.disconnect();WakeScheduler.release("file-return");}
        },"elfremote-file-return").start();
    }
    private Network network(JSONObject p){ConnectivityManager cm=(ConnectivityManager)context.getSystemService(Context.CONNECTIVITY_SERVICE);Network n=cm.getActiveNetwork();NetworkCapabilities caps=n==null?null:cm.getNetworkCapabilities(n);return caps!=null&&(p.optBoolean("allow_cellular")||caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)||caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))?n:null;}
    private HttpURLConnection open(String url,String token,JSONObject p,String method,long size)throws Exception{
        Network n=network(p);if(n==null)throw new Paused();HttpURLConnection c=(HttpURLConnection)n.openConnection(Protocol.requireHttpsUrl(url));connection=c;c.setConnectTimeout(15000);c.setReadTimeout(20000);c.setInstanceFollowRedirects(false);c.setRequestMethod(method);c.setDoOutput(true);c.setFixedLengthStreamingMode(size);c.setRequestProperty("Authorization","Bearer "+token);return c;
    }
    private JSONObject response(HttpURLConnection c)throws Exception{
        int code=c.getResponseCode();if(code>=400&&code<500&&code!=429)throw new Permanent("文件服务拒绝请求 HTTP "+code);if(code!=200)throw new IOException("文件服务暂不可用");
        try(InputStream in=c.getInputStream();ByteArrayOutputStream out=new ByteArrayOutputStream()){byte[] buf=new byte[4096];int n;while((n=in.read(buf))!=-1){if(out.size()+n>150000)throw new IOException("文件回执过大");out.write(buf,0,n);}JSONObject r=new JSONObject(out.toString("UTF-8"));if(!r.optBoolean("ok"))throw new IOException("文件操作未确认");return r;}
    }
    private JSONObject json(String url,String token,JSONObject p,JSONObject body)throws Exception{
        byte[] bytes=body.toString().getBytes("UTF-8");HttpURLConnection c=open(url,token,p,"POST",bytes.length);try{c.setRequestProperty("Content-Type","application/json");try(OutputStream out=c.getOutputStream()){out.write(bytes);}return response(c);}finally{c.disconnect();connection=null;}
    }
    private void upload(String url,String token,JSONObject p,byte[] bytes,JSONObject offer)throws Exception{
        Network n=network(p);HttpURLConnection c=open(url,token,p,"PUT",bytes.length);try{c.setRequestProperty("Content-Type","application/octet-stream");try(OutputStream out=c.getOutputStream()){for(int offset=0;offset<bytes.length;offset+=8192){check(offer);if(n==null||!n.equals(network(p)))throw new Paused();out.write(bytes,offset,Math.min(8192,bytes.length-offset));}}response(c);}finally{c.disconnect();connection=null;}
    }
    private void check(JSONObject offer)throws Exception{if(stopped)throw new IOException("客户端正在退出");if(cancelled)throw new Permanent("文件取回已停止");if(offer.getLong("expires_at")<=System.currentTimeMillis())throw new Permanent("文件取回任务已过期");}
    private void cleanup(File active,File dir){active.delete();File[] files=dir.listFiles();if(files!=null)for(File f:files)f.delete();dir.delete();}
    void stop(){stopped=true;HttpURLConnection c=connection;if(c!=null)c.disconnect();}
    private static final class Paused extends IOException{}
    private static final class Permanent extends IOException{Permanent(String text){super(text);}}
}
