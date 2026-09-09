package net.elfradio.elfremote;

import android.content.Context;
import android.net.*;
import org.json.JSONObject;
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URLEncoder;
import java.security.MessageDigest;

/** 应用UID流式接收；分块续传、完整校验后交给独立核心提交。 */
final class FileTransfer {
    interface Reporter { void send(String id,String state,String detail,JSONObject result)throws Exception; }
    private final Context context;
    private final Reporter reporter;
    private final TaskReceipts receipts;
    private volatile boolean busy,cancelled,stopped;
    private String current="";
    private volatile HttpURLConnection connection;
    FileTransfer(Context context,Reporter reporter,TaskReceipts receipts){this.context=context;this.reporter=reporter;this.receipts=receipts;}
    synchronized void receive(JSONObject offer,String device,String token)throws Exception {
        String id=offer.getString("id");
        if(!id.matches("[a-zA-Z0-9-]{1,64}"))throw new IOException("文件任务编号无效");
        if(busy){if(id.equals(current)&&offer.optBoolean("cancel_requested")){cancelled=true;if(connection!=null)connection.disconnect();}return;}
        File active=new File(context.getFilesDir(),"file-active.json");
        if(offer.has("local_device")&&!device.equals(offer.optString("local_device")))throw new IOException("文件任务属于旧设备实例");
        offer.put("local_device",device);RescueFiles.write(active,offer.toString());
        current=id;cancelled=offer.optBoolean("cancel_requested");busy=true;
        new Thread(()->{
            File dir=new File(context.getFilesDir(),"file-transfer/"+id);
            try {
                JSONObject receipt=receipts.read(id);
                if(receipt!=null){if(!receipt.optBoolean("acknowledged"))reporter.send(id,receipt.getString("state"),receipt.optString("detail"),receipt.optJSONObject("result"));active.delete();return;}
                if(!dir.isDirectory()&&!dir.mkdirs())throw new IOException("无法创建接收目录");
                JSONObject p=offer.getJSONObject("params");
                if(offer.optLong("expires_at")<=System.currentTimeMillis())throw new IOException("文件接收任务已过期");
                if(cancelled)throw new IOException("文件接收已停止");
                WakeScheduler.hold(context,"file-transfer",30*60*1000L);
                reporter.send(id,"claimed","设备已接收文件任务",null);
                JSONObject core=CoreClient.request("/jobs/"+id,null);
                File payload=new File(dir,"payload.part");
                if(core==null){
                    Network network=allowedNetwork(p.optBoolean("allow_cellular"));
                    if(network==null)throw new Paused();
                    String base=Protocol.BASE_URL+"/api/elfremote/file-download?"+"id="+enc(p.getString("transfer_id"))+"&device_id="+enc(device)+"&task_id="+enc(id);
                    JSONObject m=manifest(base,token,network).getJSONObject("file");
                    long size=p.getLong("size");int chunk=m.getInt("chunk_size");
                    if(size<0||size>FileCommit.MAX_BYTES||size!=m.getLong("size")||!p.getString("sha256").equals(m.getString("sha256"))||chunk!=8*1024*1024)throw new IOException("文件信息不匹配");
                    if(payload.length()>size)throw new IOException("本地临时文件长度异常");
                    if(dir.getUsableSpace()<size-payload.length()+32L*1024*1024)throw new IOException("接收目录剩余空间不足");
                    reporter.send(id,"running","正在接收文件",null);
                    long lastProgress=0;
                    try(RandomAccessFile out=new RandomAccessFile(payload,"rw")){
                        for(int i=0;(long)i*chunk<size;i++){
                            check(offer);network=allowedNetwork(p.optBoolean("allow_cellular"));if(network==null)throw new Paused();
                            long begin=(long)i*chunk,bytes=Math.min(chunk,size-begin),have=Math.max(0,Math.min(bytes,out.length()-begin));
                            JSONObject part=m.getJSONObject("parts").getJSONObject(String.valueOf(i));
                            if(part.getLong("bytes")!=bytes)throw new IOException("分块长度不匹配");
                            if(have<bytes)download(base+"&part="+i,token,network,p.optBoolean("allow_cellular"),out,begin,have,bytes,offer);
                            if(!segmentHash(out,begin,bytes).equals(part.getString("sha256"))){out.setLength(begin);throw new IOException("分块校验失败，稍后重新接收");}
                            if(System.currentTimeMillis()-lastProgress>30000){reporter.send(id,"running","设备接收 "+((begin+bytes)*100/Math.max(1,size))+"%",null);lastProgress=System.currentTimeMillis();}
                        }
                        out.getFD().sync();
                    }
                    check(offer);
                    reporter.send(id,"running","接收完成，正在校验并保存文件",null);
                    if(!RescueFiles.sha256(payload).equals(p.getString("sha256")))throw new IOException("完整文件校验失败");
                    check(offer);
                    CoreClient.request("/file-commit",new JSONObject().put("id",id).put("params",new JSONObject(p.toString()).put("source",payload.getPath())));
                }
                long end=android.os.SystemClock.elapsedRealtime()+31*60*1000L;
                while(!stopped&&android.os.SystemClock.elapsedRealtime()<end){
                    if(cancelled)CoreClient.request("/jobs/"+id+"/cancel",new JSONObject());
                    core=CoreClient.request("/jobs/"+id,null);
                    if(core!=null&&!"running".equals(core.optString("state")))break;
                    Thread.sleep(1000);
                }
                if(core==null||"running".equals(core.optString("state")))throw new IOException("等待文件保存结果");
                if(!"committed".equals(core.optString("action")))throw new IOException(core.optString("error","文件保存中断，未自动重试覆盖"));
                JSONObject result=new JSONObject().put("action","committed").put("stage","file").put("bytes",core.getLong("bytes"))
                        .put("sha256",core.getString("sha256")).put("text",core.optString("output"));
                reporter.send(id,"success","文件已保存",result);active.delete();payload.delete();dir.delete();
            }catch(Paused pause){
                try{reporter.send(id,"running","已暂停，等待 Wi-Fi 后继续接收",null);}catch(Exception e){RuntimeLog.error("file_pause_report_pending",e);}
                new WakeScheduler(context).schedule("file-transfer",15*60*1000L);
            }catch(Exception error){
                RuntimeLog.error("file_receive_pending",error);
                if(stopped)return;
                try{
                    JSONObject saved=receipts.read(id);
                    if(saved!=null){new WakeScheduler(context).schedule("file-transfer",60000);return;}
                    File attempts=new File(dir,"failures");int count=attempts.isFile()?Integer.parseInt(RescueFiles.read(attempts,20).trim()):0;
                    count++;if(dir.isDirectory())RescueFiles.write(attempts,String.valueOf(count));
                    if(cancelled||count>=3||offer.optLong("expires_at")<=System.currentTimeMillis()){
                        reporter.send(id,"failed",cancelled?"文件接收已停止":error.getMessage(),null);active.delete();new File(dir,"payload.part").delete();
                    }else{reporter.send(id,"running","接收中断，稍后从断点继续",null);new WakeScheduler(context).schedule("file-transfer",60000L*count);}
                }catch(Exception pending){RuntimeLog.error("file_result_pending",pending);new WakeScheduler(context).schedule("file-transfer",60000);}
            }finally{busy=false;connection=null;WakeScheduler.release("file-transfer");}
        },"elfremote-file-receive").start();
    }
    private Network allowedNetwork(boolean cellular){
        ConnectivityManager cm=(ConnectivityManager)context.getSystemService(Context.CONNECTIVITY_SERVICE);
        Network n=cm.getActiveNetwork();NetworkCapabilities caps=n==null?null:cm.getNetworkCapabilities(n);
        return caps!=null&&(cellular||caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)||caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))?n:null;
    }
    private void check(JSONObject offer)throws Exception{if(stopped)throw new IOException("客户端正在退出");if(cancelled)throw new IOException("文件接收已停止");if(System.currentTimeMillis()>=offer.getLong("expires_at"))throw new IOException("文件接收任务已过期");}
    private HttpURLConnection open(String url,String token,Network n)throws Exception{
        HttpURLConnection c=(HttpURLConnection)n.openConnection(Protocol.requireHttpsUrl(url));connection=c;
        c.setConnectTimeout(15000);c.setReadTimeout(20000);c.setInstanceFollowRedirects(false);c.setRequestProperty("Authorization","Bearer "+token);c.setRequestProperty("Accept-Encoding","identity");return c;
    }
    private JSONObject manifest(String url,String token,Network n)throws Exception{
        HttpURLConnection c=open(url,token,n);
        try{if(c.getResponseCode()!=200)throw new IOException("文件访问失败 HTTP "+c.getResponseCode());
            try(InputStream in=c.getInputStream();ByteArrayOutputStream out=new ByteArrayOutputStream()){
                byte[] buf=new byte[4096];int read;while((read=in.read(buf))!=-1){if(out.size()+read>150000)throw new IOException("文件清单过大");out.write(buf,0,read);}
                return new JSONObject(out.toString("UTF-8"));}
        }finally{c.disconnect();connection=null;}
    }
    private void download(String url,String token,Network network,boolean cellular,RandomAccessFile out,long begin,long have,long bytes,JSONObject offer)throws Exception{
        HttpURLConnection c=open(url,token,network);if(have>0)c.setRequestProperty("Range","bytes="+have+"-");
        try{
            int code=c.getResponseCode();
            if(code!=(have>0?206:200)||c.getContentLengthLong()!=bytes-have)throw new IOException("分块响应长度或状态不匹配");
            if(have>0&&!("bytes "+have+"-"+(bytes-1)+"/"+bytes).equals(c.getHeaderField("Content-Range")))throw new IOException("断点位置不匹配");
            out.seek(begin+have);long received=have;
            try(InputStream in=c.getInputStream()){
                byte[] buf=new byte[65536];int n;
                while((n=in.read(buf))!=-1){check(offer);if(!network.equals(allowedNetwork(cellular)))throw new Paused();
                    received+=n;if(received>bytes)throw new IOException("分块超过预期长度");out.write(buf,0,n);}
            }
            if(received!=bytes)throw new IOException("分块下载中断");
        }finally{out.getFD().sync();c.disconnect();connection=null;}
    }
    static String segmentHash(RandomAccessFile file,long start,long count)throws Exception{
        MessageDigest hash=MessageDigest.getInstance("SHA-256");file.seek(start);byte[] bytes=new byte[65536];
        while(count>0){int n=file.read(bytes,0,(int)Math.min(bytes.length,count));if(n<0)throw new EOFException();hash.update(bytes,0,n);count-=n;}
        return FileCommit.hex(hash.digest());
    }
    void stop(){stopped=true;HttpURLConnection c=connection;if(c!=null)c.disconnect();}
    private static String enc(String s)throws Exception{return URLEncoder.encode(s,"UTF-8");}
    private static final class Paused extends IOException {}
}
