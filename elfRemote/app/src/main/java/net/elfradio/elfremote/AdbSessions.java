package net.elfradio.elfremote;

import java.io.*;
import java.net.*;
import java.util.*;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.SSLParameters;
import org.java_websocket.client.WebSocketClient;
import org.java_websocket.handshake.ServerHandshake;
import org.json.JSONObject;

/** 按需启动的云端ADB会话；凭据仅在内存中存在，不传给shell。 */
final class AdbSessions implements Closeable {
    private final RescueJobs jobs;
    private final RollingLog log;
    private Session current;
    AdbSessions(RescueJobs jobs,File root){this.jobs=jobs;log=new RollingLog(new File(root,"adb-log"),32768,2);}
    static URI validate(JSONObject request,long now)throws Exception {
        String id=request.getString("session_id"),token=request.getString("token");
        if(!id.matches("[a-f0-9-]{36}")||!token.matches("[a-f0-9]{64}"))throw new IOException("ADB会话参数无效");
        long expires=request.getLong("expires_at");if(expires<=now||expires>now+120000)throw new IOException("ADB连接请求已到期");
        URI uri=new URI(request.getString("url")),control=new URI(BuildConfig.CONTROL_URL);
        if(!"wss".equals(uri.getScheme())||!control.getHost().equals(uri.getHost())||uri.getUserInfo()!=null||uri.getFragment()!=null
                ||(uri.getPort()!=-1&&uri.getPort()!=443)||!"/api/elfremote/adb/device".equals(uri.getPath())||!("session_id="+id).equals(uri.getRawQuery()))
            throw new IOException("ADB中继地址不属于当前管理服务器");
        return uri;
    }
    synchronized JSONObject open(JSONObject request)throws Exception {
        if(LostProtection.edit(s->{}).optBoolean("enabled"))throw new IllegalStateException("丢失模式期间请使用已认证的通用终端");
        URI uri=validate(request,System.currentTimeMillis());String id=request.getString("session_id");
        if(current!=null&&current.id.equals(id))return new JSONObject().put("accepted",true);
        if(jobs.isBusy())throw new IllegalStateException("设备正在执行维护任务，请稍后连接ADB");
        if(current!=null)current.finish(null,"已打开新的ADB会话");
        current=new Session(id,uri,request.getString("token"));
        Thread thread=new Thread(current::connect,"elfremote-adb-connect");thread.setDaemon(true);thread.start();
        return new JSONObject().put("accepted",true);
    }
    public synchronized void close(){if(current!=null)current.finish(null,"维护核心正在更新，ADB已断开");}
    private final class Session {
        final String id;final WebSocketClient websocket;
        volatile AdbShell shell;volatile boolean ended;
        Object power;android.os.IBinder wakeToken;
        final java.util.Timer deadline=new java.util.Timer("elfremote-adb-deadline",true);
        Session(String id,URI uri,String token){
            this.id=id;
            websocket=new WebSocketClient(uri,Collections.singletonMap("Authorization","Bearer "+token)){
                @Override protected void onSetSSLParameters(SSLParameters parameters){parameters.setEndpointIdentificationAlgorithm("HTTPS");}
                public void onOpen(ServerHandshake handshake){}
                public void onMessage(String raw){try{
                    if(raw.length()>90000)throw new IOException("终端输入过大");
                    JSONObject data=new JSONObject(raw);String type=data.optString("type");
                    if("closed".equals(type)){finish(null,"管理端已断开ADB");return;}
                    AdbShell active=shell;if(active==null||ended)throw new IOException("ADB尚未连接");
                    if("input".equals(type))active.input(android.util.Base64.decode(data.getString("data"),android.util.Base64.DEFAULT));
                    else if("resize".equals(type))active.resize(data.getInt("rows"),data.getInt("columns"));
                    else throw new IOException("不支持的终端操作");
                }catch(Exception failure){finish(null,"ADB输入失败");}}
                public void onClose(int code,String reason,boolean remote){finish(null,"ADB连接已关闭");}
                public void onError(Exception error){finish(null,"ADB网络连接失败");}
            };
            websocket.setConnectionLostTimeout(30);
            websocket.setSocketFactory(CoreTraffic.factory());
        }
        void connect(){
            try{
                log.write(System.currentTimeMillis()+" ADB_CONNECT_BEGIN");
                holdAwake();deadline.schedule(new java.util.TimerTask(){public void run(){finish(null,"本次终端已到时");}},1800000);
                if(!websocket.connectBlocking(10,TimeUnit.SECONDS)||ended)throw new IOException("无法连接ADB中继");
                String taskId="adb-"+id;
                String reuse="[ \"$(getprop service.adb.tcp.port)\" = 5555 ] && [ \"$(getprop init.svc.adbd)\" = running ]"
                        + " && iptables -C INPUT ! -i lo -p tcp --dport 5555 -j DROP 2>/dev/null"
                        + " && ip6tables -C INPUT ! -i lo -p tcp --dport 5555 -j DROP 2>/dev/null"
                        + " && netstat -tln | grep -qE ':5555[[:space:]]'";
                jobs.submit(taskId,"if "+reuse+"; then echo ADBD_LOOPBACK_OK; else\n"+RepairPolicy.adbdCommand()+"fi\n",30);
                JSONObject task;long until=System.currentTimeMillis()+35000;
                do {if(ended)throw new IOException("ADB请求已取消");Thread.sleep(100);task=jobs.get(taskId);}while(task!=null&&"running".equals(task.optString("state"))&&System.currentTimeMillis()<until);
                if(task==null||!"completed".equals(task.optString("state"))||task.optInt("exit_code",-1)!=0||!task.optString("output").contains("ADBD_LOOPBACK_OK"))
                    throw new IOException("本机ADB未能启动，请查看维护日志");
                Socket connection=new Socket();connection.connect(new InetSocketAddress("127.0.0.1",5555),3000);
                shell=new AdbShell(connection,new AdbShell.Listener(){
                    public void output(int channel,byte[] bytes){
                        // 每条云消息有界；UTF-8的跨块拼接由浏览器解码器负责。
                        for(int at=0;at<bytes.length;at+=32768)try{send(new JSONObject().put("type","output").put("channel",channel)
                                .put("data",android.util.Base64.encodeToString(Arrays.copyOfRange(bytes,at,Math.min(bytes.length,at+32768)),android.util.Base64.NO_WRAP)));}
                        catch(Exception e){finish(null,"ADB输出连接中断");}
                    }
                    public void closed(Integer exit,String error){finish(exit,error.isEmpty()?"ADB 已断开":error);}
                });
                if(ended){shell.close();return;}
                send(new JSONObject().put("type","ready"));log.write(System.currentTimeMillis()+" ADB_CONNECTED");shell.start();
            }catch(Exception error){
                log.write(System.currentTimeMillis()+" ADB_FAILED "+error.getClass().getSimpleName()+" cause="+(error.getCause()==null?"none":error.getCause().getClass().getSimpleName())
                        + " at="+(error.getStackTrace().length==0?"none":error.getStackTrace()[0].toString()));
                finish(null,error instanceof IOException?error.getMessage():"ADB会话启动失败，请查看维护日志");
            }
        }
        void send(JSONObject data)throws IOException {
            if(ended||!websocket.isOpen())throw new IOException("ADB中继已关闭");
            if(websocket.getConnection() instanceof org.java_websocket.WebSocketImpl) {
                long pending=0;for(java.nio.ByteBuffer buffer:((org.java_websocket.WebSocketImpl)websocket.getConnection()).outQueue)pending+=buffer.remaining();
                if(pending>262144)throw new IOException("ADB输出积压，连接已关闭");
            }
            websocket.send(data.toString());
        }
        synchronized void holdAwake()throws Exception {
            if(ended)throw new IOException("ADB请求已取消");
            android.os.IBinder binder=(android.os.IBinder)Class.forName("android.os.ServiceManager").getMethod("getService",String.class).invoke(null,"power");
            power=Class.forName("android.os.IPowerManager$Stub").getMethod("asInterface",android.os.IBinder.class).invoke(null,binder);
            wakeToken=new android.os.Binder();
            Class.forName("android.os.IPowerManager").getMethod("acquireWakeLock",android.os.IBinder.class,int.class,String.class,String.class,android.os.WorkSource.class,String.class)
                    .invoke(power,wakeToken,1,"elfRemote:adb-session","net.elfradio.elfremote",null,null);
        }
        synchronized void finish(Integer exit,String reason){
            if(ended)return;ended=true;
            deadline.cancel();
            if(shell!=null)shell.close();
            try{if(power!=null&&wakeToken!=null)Class.forName("android.os.IPowerManager").getMethod("releaseWakeLock",android.os.IBinder.class,int.class).invoke(power,wakeToken,0);}catch(Exception ignored){}
            try{if(websocket.isOpen())websocket.send(new JSONObject().put("type","closed").put("exit",exit==null?JSONObject.NULL:exit).put("message",reason).toString());}catch(Exception ignored){}
            websocket.close();log.write(System.currentTimeMillis()+" ADB_CLOSED exit="+exit);
        }
    }
}
