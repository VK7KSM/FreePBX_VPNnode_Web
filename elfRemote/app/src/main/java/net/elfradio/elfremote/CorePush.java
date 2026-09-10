package net.elfradio.elfremote;

import android.content.Context;
import android.net.*;
import android.os.*;
import org.eclipse.paho.client.mqttv3.*;
import org.eclipse.paho.client.mqttv3.internal.ClientComms;
import org.eclipse.paho.client.mqttv3.persist.MqttDefaultFilePersistence;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.HttpsURLConnection;

/** 单一MQTT连接由独立核心持有，主应用只负责数据采集与已有任务流程。 */
final class CorePush implements Closeable {
    private final CorePushState state;
    private final File directory;
    private final HandlerThread thread;
    private final Handler worker;
    private final CoreWake wake;
    private final ConnectivityManager network;
    private final ConnectivityManager.NetworkCallback callback;
    private MqttAsyncClient client;
    private Ping ping;
    private volatile boolean connected,closed;
    private boolean connecting;
    private volatile String activeKey="";
    private String activeNetwork="";
    private int failures;
    CorePush(File root)throws Exception {
        directory=new File(root,"push");if(!directory.isDirectory()&&!directory.mkdir())throw new IOException("推送目录不可用");
        android.system.Os.chmod(directory.getPath(),0700);
        state=new CorePushState(new File(directory,"state.json"));
        Context system=CoreWake.systemContext();
        network=(ConnectivityManager)system.getSystemService(Context.CONNECTIVITY_SERVICE);
        if(network==null)throw new IOException("系统网络服务尚未就绪");
        callback=new ConnectivityManager.NetworkCallback(){public void onAvailable(Network n){hint();}public void onLost(Network n){hint();}};
        thread=new HandlerThread("elfremote-core-push");thread.start();worker=new Handler(thread.getLooper());
        wake=new CoreWake(system,worker);
        try { network.registerDefaultNetworkCallback(callback,worker);worker.post(this::ensure); }
        catch(Exception error){try{network.unregisterNetworkCallback(callback);}catch(Exception ignored){}wake.close();thread.quitSafely();throw error;}
    }
    JSONObject configure(JSONObject request)throws Exception {
        boolean changed=state.configure(request);if(changed){connected=false;worker.post(()->{dispose();failures=0;ensure();});}else worker.post(this::ensure);
        return status();
    }
    JSONObject status()throws Exception {
        JSONObject snapshot=state.snapshot();return new JSONObject().put("owned",!snapshot.optString("device_id").isEmpty())
                .put("connected",connected&&activeKey.equals(CorePushState.key(snapshot))).put("notification",state.pending(System.currentTimeMillis()));
    }
    void disable()throws Exception {state.clear();connected=false;worker.post(this::dispose);}
    void hint(){worker.post(()->{String next=networkId();if(!next.equals(activeNetwork)){dispose();failures=0;ensure();}else if(!connecting&&!connected&&failures==0)ensure();});}
    private String networkId(){Network n=network.getActiveNetwork();return n==null?"":n.toString();}
    private void ensure(){
        if(closed||connecting||connected)return;
        try {
            JSONObject identity=state.snapshot();if(identity.optString("device_id").isEmpty())return;
            activeNetwork=networkId();if(activeNetwork.isEmpty())return;
            activeKey=CorePushState.key(identity);String expectedKey=activeKey;
            connecting=true;wake.hold("connect",60000);wake.cancel("retry");wake.schedule("connect-timeout",45000,()->retry(new IOException("connect timeout")));
            JSONObject config=identity.optJSONObject("connection");
            if(config==null){config=post(Protocol.pushConfigPath(),identityBody(identity)).getJSONObject("connection");state.connection(expectedKey,config);}
            CorePushState.validateConnection(config);
            if(closed||!expectedKey.equals(CorePushState.key(state.snapshot()))){dispose();ensure();return;}
            final String topic=config.getString("topic");
            File persistence=new File(directory,PairingStore.sha256Hex(expectedKey));if(!persistence.isDirectory()&&!persistence.mkdir())throw new IOException("MQTT目录不可用");
            ping=new Ping();
            client=new MqttAsyncClient("ssl://"+config.getString("host")+":"+config.getInt("port"),config.getString("client_id"),
                    new MqttDefaultFilePersistence(persistence.getPath()),ping,null,SystemClock::elapsedRealtimeNanos);
            final MqttAsyncClient source=client;client.setManualAcks(true);
            client.setCallback(new MqttCallback(){
                public void deliveryComplete(IMqttDeliveryToken token){}
                public void connectionLost(Throwable error){worker.post(()->{if(client==source)retry(error);});}
                public void messageArrived(String received,MqttMessage message){
                    wake.hold("notice",30000);byte[] bytes=message.getPayload();
                    worker.post(()->{try{
                        if(client!=source)return;
                        if(topic.equals(received)&&bytes.length<=4096){
                            JSONObject notice=null;try{notice=new JSONObject(new String(bytes,StandardCharsets.UTF_8));}catch(Exception malformed){RuntimeLog.event("core_push_invalid_notice");}
                            if(notice!=null)state.notice(expectedKey,notice,System.currentTimeMillis());
                        }
                        source.messageArrivedComplete(message.getId(),message.getQos());deliver();
                    }catch(Exception error){retry(error);}finally{wake.release("notice");}});
                }
            });
            MqttConnectOptions options=new MqttConnectOptions();options.setMqttVersion(MqttConnectOptions.MQTT_VERSION_3_1_1);
            options.setCleanSession(false);options.setAutomaticReconnect(false);options.setConnectionTimeout(15);
            options.setKeepAliveInterval(Math.max(60,Math.min(1800,config.optInt("keepalive_seconds",900))));options.setMaxInflight(4);
            options.setUserName(config.getString("username"));options.setPassword(config.getString("password").toCharArray());
            options.setSocketFactory(CoreTraffic.factory());options.setHttpsHostnameVerificationEnabled(true);
            RuntimeLog.event("core_mqtt_connect");
            client.connect(options,null,new IMqttActionListener(){
                public void onSuccess(IMqttToken token){worker.post(()->{if(client!=source)return;try{source.subscribe(topic,1,null,new IMqttActionListener(){
                    public void onSuccess(IMqttToken result){worker.post(()->{if(client!=source)return;
                        if(result.getGrantedQos().length!=1||result.getGrantedQos()[0]==128){retry(new IOException("subscription refused"));return;}
                        connecting=false;connected=true;failures=0;wake.cancel("connect-timeout");wake.release("connect");RuntimeLog.event("core_mqtt_subscribed");sync();});}
                    public void onFailure(IMqttToken result,Throwable error){worker.post(()->{if(client==source)retry(error);});}
                });}catch(Exception error){retry(error);}});}
                public void onFailure(IMqttToken result,Throwable error){worker.post(()->{if(client!=source)return;
                    if(error instanceof MqttException&&(((MqttException)error).getReasonCode()==4||((MqttException)error).getReasonCode()==5))try{state.connection(expectedKey,null);}catch(Exception persistence){RuntimeLog.error("core_config_save_failed",persistence);}
                    retry(error);});}
            });
        }catch(Exception error){retry(error);}
    }
    private void sync(){
        if(closed)return;
        wake.hold("sync",45000);
        try{JSONObject identity=state.snapshot(),reply=post(Protocol.pushSyncPath(),identityBody(identity));JSONObject notice=reply.optJSONObject("status_request");
            if(notice!=null)state.notice(CorePushState.key(identity),notice,System.currentTimeMillis());deliver();RuntimeLog.event("core_push_sync_ok");
        }catch(Exception error){RuntimeLog.error("core_push_sync_failed",error);if(!closed&&connected)wake.schedule("sync",60000,this::sync);}
        finally{wake.release("sync");}
    }
    private void deliver(){
        try {
            if(closed||state.pending(System.currentTimeMillis())==null){wake.cancel("deliver");return;}
            wake.hold("deliver",15000);
            java.lang.Process process=new ProcessBuilder("/system/bin/am","start-foreground-service","--user","0","-n","net.elfradio.elfremote/.ReportService",
                    "-a",WakeScheduler.ACTION,"--es","wake_key","core-push").redirectErrorStream(true).redirectOutput(new File(directory,"last-delivery.out")).start();
            boolean done=process.waitFor(10,TimeUnit.SECONDS);if(!done)process.destroy();
            RuntimeLog.event("core_notice_delivery exit="+(done?process.exitValue():-1));
            wake.schedule("deliver",30000,this::deliver);
        }catch(Exception error){RuntimeLog.error("core_notice_delivery_failed",error);wake.schedule("deliver",30000,this::deliver);}
        finally{wake.release("deliver");}
    }
    private void retry(Throwable error){
        dispose();if(closed)return;long delay=PushPolicy.retryDelay(failures++,Math.random());
        RuntimeLog.error("core_mqtt_failed",error);RuntimeLog.event("core_mqtt_retry delay_ms="+delay);wake.schedule("retry",delay,this::ensure);
    }
    private void dispose(){
        connected=false;connecting=false;wake.cancel("connect-timeout");wake.cancel("retry");wake.cancel("sync");wake.release("connect");
        if(ping!=null){ping.stop();ping=null;}MqttAsyncClient old=client;client=null;
        if(old!=null){try{old.disconnectForcibly(0,500,false);}catch(Exception ignored){}try{old.close(true);}catch(Exception ignored){}}
    }
    public void close(){closed=true;try{network.unregisterNetworkCallback(callback);}catch(Exception ignored){}dispose();wake.close();thread.quitSafely();}
    JSONObject logs()throws Exception {
        StringBuilder text=new StringBuilder();
        for(int n=1;n>=0;n--){File file=new File(directory.getParentFile(),"runtime-log/runtime-"+n+".log");if(!file.isFile())continue;
            try(RandomAccessFile in=new RandomAccessFile(file,"r")){int length=(int)Math.min(98304,in.length());byte[] bytes=new byte[length];in.seek(in.length()-length);in.readFully(bytes);text.append(new String(bytes,StandardCharsets.UTF_8));}}
        return new JSONObject().put("text",text.toString());
    }
    private static JSONObject identityBody(JSONObject identity)throws Exception{return new JSONObject().put("device_id",identity.getString("device_id")).put("token",identity.getString("token"));}
    private static JSONObject post(String url,JSONObject body)throws Exception {
        HttpsURLConnection c=(HttpsURLConnection)Protocol.requireHttpsUrl(url).openConnection();c.setSSLSocketFactory(CoreTraffic.factory());
        try{c.setConnectTimeout(15000);c.setReadTimeout(20000);c.setInstanceFollowRedirects(false);c.setRequestMethod("POST");c.setDoOutput(true);
            c.setRequestProperty("Content-Type","application/json");byte[] bytes=body.toString().getBytes(StandardCharsets.UTF_8);c.setFixedLengthStreamingMode(bytes.length);
            try(OutputStream out=c.getOutputStream()){out.write(bytes);}if(c.getResponseCode()!=200)throw new IOException("核心推送HTTP状态="+c.getResponseCode());
            try(InputStream in=c.getInputStream();ByteArrayOutputStream out=new ByteArrayOutputStream()){byte[] buffer=new byte[2048];int n;while((n=in.read(buffer))!=-1){if(out.size()+n>16384)throw new IOException("核心推送响应过大");out.write(buffer,0,n);}JSONObject reply=new JSONObject(new String(out.toByteArray(),StandardCharsets.UTF_8));if(!reply.optBoolean("ok"))throw new IOException("核心推送请求被拒绝");return reply;}
        }finally{c.disconnect();}
    }
    private final class Ping implements MqttPingSender {
        private ClientComms comms;private boolean running;
        public void init(ClientComms value){comms=value;}
        public void start(){running=true;schedule(comms.getKeepAlive());}
        public void stop(){running=false;wake.cancel("ping");wake.release("ping");}
        public void schedule(long delay){if(running)wake.schedule("ping",delay,this::fire);}
        private void fire(){if(!running)return;wake.hold("ping",30000);RuntimeLog.event("core_mqtt_ping_wake");
            try{MqttToken token=comms.checkForActivity(new IMqttActionListener(){public void onSuccess(IMqttToken t){wake.release("ping");RuntimeLog.event("core_mqtt_ping_ok");}public void onFailure(IMqttToken t,Throwable error){wake.release("ping");}});if(token==null)wake.release("ping");}
            catch(Exception error){wake.release("ping");retry(error);}
        }
    }
}
