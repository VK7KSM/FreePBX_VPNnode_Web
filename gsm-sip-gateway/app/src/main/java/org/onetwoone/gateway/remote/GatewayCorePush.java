package org.onetwoone.gateway.remote;

import android.content.Context;
import android.net.*;
import android.os.*;
import android.util.AtomicFile;
import java.io.*;
import java.nio.charset.StandardCharsets;
import org.eclipse.paho.client.mqttv3.*;
import org.eclipse.paho.client.mqttv3.persist.MqttDefaultFilePersistence;
import org.json.JSONObject;

/** A single root-owned MQTT connection persists notices before acknowledging them. */
final class GatewayCorePush implements Closeable {
    private final Context context;private final File root,stateFile,pendingFile,noticeFile;
    private final GatewayAdbSessions adb;private final GatewayAdbTunnel tunnel;
    private final HandlerThread thread;private final Handler worker;private final ConnectivityManager network;private final GatewayCoreWake wake;
    private final ConnectivityManager.NetworkCallback callback;
    private JSONObject state;private MqttAsyncClient client;private GatewayMqttHeartbeat ping;private boolean connected,connecting,closed,mqttProxyAttempt,connectedViaProxy,mqttDirectFallback;private int failures;private String activeNetwork="";
    GatewayCorePush(Context context,File coreRoot) throws Exception {
        this.context=context;root=new File(coreRoot,"push");if(!root.isDirectory()&&!root.mkdir())throw new IOException("push directory unavailable");
        android.system.Os.chmod(root.getPath(),0700);stateFile=new File(root,"state.json");pendingFile=new File(root,"pending.json");noticeFile=new File(root,"notice.json");
        adb=new GatewayAdbSessions(context,new File(coreRoot,"adb"));tunnel=new GatewayAdbTunnel(context,new File(coreRoot,"adb-tunnel"));
        state=stateFile.exists()?read(stateFile):new JSONObject();
        thread=new HandlerThread("gateway-core-push");thread.start();worker=new Handler(thread.getLooper());wake=new GatewayCoreWake(context,worker);
        network=context.getSystemService(ConnectivityManager.class);if(network==null)throw new IOException("network service unavailable");
        callback=new ConnectivityManager.NetworkCallback(){@Override public void onAvailable(Network n){hint();}@Override public void onLost(Network n){hint();}};
        network.registerDefaultNetworkCallback(callback,worker);worker.post(this::ensure);
    }
    synchronized JSONObject configure(JSONObject request) throws Exception {
        String device=request.optString("device_id"),token=request.optString("token");
        if(!device.matches("[A-Za-z0-9_-]{1,128}")||!token.matches("[A-Za-z0-9_-]{16,512}"))throw new IOException("invalid push identity");
        boolean changed=!device.equals(state.optString("device_id"))||!token.equals(state.optString("token"));
        if(changed){state=new JSONObject().put("device_id",device).put("token",token).put("queued_version",0);save(stateFile,state);dispose();}
        worker.post(this::ensure);return status();
    }
    synchronized JSONObject status() throws Exception {
        JSONObject result=new JSONObject().put("connected",connected).put("configured",!state.optString("device_id").isEmpty())
                .put("transport",connected?(connectedViaProxy?"proxy":"direct"):"none")
                .put("last_stage",state.optString("last_stage")).put("last_error_class",state.optString("last_error_class"))
                .put("last_attempt_at",state.optLong("last_attempt_at")).put("connected_at",state.optLong("connected_at"))
                .put("next_wake_delay_ms",wake.nextDelay());
        if(pendingFile.exists())result.put("pending",read(pendingFile));return result;
    }
    void tick(){worker.post(wake::runDue);}
    synchronized void acknowledge(String delivery) throws Exception {
        if(!delivery.matches("[a-f0-9-]{36}")||!pendingFile.exists())return;
        JSONObject pending=read(pendingFile);if(!delivery.equals(pending.optString("delivery_id")))return;
        long version=pending.optLong("notice_version",0);state.put("queued_version",Math.max(state.optLong("queued_version"),version));save(stateFile,state);
        if(!pendingFile.delete())throw new IOException("pending push cleanup failed");
        if(noticeFile.exists()&&!noticeFile.delete())throw new IOException("notice cleanup failed");
    }
    void hint(){worker.post(()->{String next=networkId();if(!next.equals(activeNetwork)){tunnel.close();dispose();failures=0;mqttDirectFallback=false;ensure();}else if(!connecting&&!connected&&failures==0)ensure();});}
    void routeChanged(){worker.post(()->{mqttDirectFallback=false;if(!connected&&!connecting){failures=0;ensure();}});}
    private String networkId(){Network value=network.getActiveNetwork();return value==null?"":value.toString();}
    private void ensure() {
        synchronized(this){if(closed||connected||connecting||state.optString("device_id").isEmpty())return;connecting=true;}
        try {
            activeNetwork=networkId();if(activeNetwork.isEmpty()){synchronized(this){connecting=false;}return;}
            wake.hold("connect",60000);wake.cancel("retry");wake.schedule("connect-timeout",45000,()->retry(new IOException("connect timeout")));
            diagnostic("connecting",null);
            JSONObject config=state.optJSONObject("connection");
            if(config==null){config=GatewayRemoteHttp.request("/api/devices/push-config",identity());GatewayPushPolicy.connection(config.getJSONObject("connection"));
                synchronized(this){state.put("connection",config.getJSONObject("connection"));save(stateFile,state);config=state.getJSONObject("connection");}}
            GatewayPushPolicy.connection(config);connect(config);
        } catch(Exception error){diagnostic("connect_failed",error);retry();}
    }
    private void connect(JSONObject config) throws Exception {
        final String topic=config.getString("topic");File persistence=new File(root,GatewayRemoteStore.hash(config.getString("client_id")));
        if(!persistence.isDirectory()&&!persistence.mkdir())throw new IOException("push persistence unavailable");
        ping=createHeartbeat();
        MqttAsyncClient next=new MqttAsyncClient("ssl://"+config.getString("host")+":"+config.getInt("port"),config.getString("client_id"),new MqttDefaultFilePersistence(persistence.getPath()),ping,null,SystemClock::elapsedRealtimeNanos);
        next.setManualAcks(true);next.setCallback(new MqttCallback(){public void deliveryComplete(IMqttDeliveryToken token){}
            public void connectionLost(Throwable error){worker.post(GatewayCorePush.this::retry);}
            public void messageArrived(String received,MqttMessage message){byte[] bytes=message.getPayload();worker.post(()->receive(next,topic,received,message,bytes));}});
        MqttConnectOptions options=new MqttConnectOptions();options.setMqttVersion(MqttConnectOptions.MQTT_VERSION_3_1_1);options.setCleanSession(false);
        options.setAutomaticReconnect(false);options.setConnectionTimeout(15);
        NetworkCapabilities capabilities=network.getNetworkCapabilities(network.getActiveNetwork());
        boolean wifi=capabilities!=null&&capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI);
        int keepalive=GatewayMqttHeartbeat.keepAliveSeconds(config.optInt("keepalive_seconds",900),wifi);
        options.setKeepAliveInterval(keepalive);options.setMaxInflight(4);diagnostic("mqtt_policy_"+keepalive,null);
        options.setUserName(config.getString("username"));options.setPassword(config.getString("password").toCharArray());options.setHttpsHostnameVerificationEnabled(true);
        mqttProxyAttempt=GatewayProxyRoute.preferred()&&!mqttDirectFallback;if(mqttProxyAttempt)options.setSocketFactory(GatewayProxyTlsSocketFactory.create());
        synchronized(this){client=next;}
        next.connect(options,null,new IMqttActionListener(){public void onSuccess(IMqttToken token){try{next.subscribe(topic,1,null,new IMqttActionListener(){
            public void onSuccess(IMqttToken subscribed){worker.post(()->{synchronized(GatewayCorePush.this){if(client!=next)return;connecting=false;connected=true;connectedViaProxy=mqttProxyAttempt;failures=0;}wake.cancel("connect-timeout");wake.release("connect");diagnostic(connectedViaProxy?"connected_proxy":"connected_direct",null);sync(null);});}
            public void onFailure(IMqttToken token,Throwable error){worker.post(()->{diagnostic("subscribe_failed",error);connectionFailed(error);});}});}catch(Exception e){worker.post(()->{diagnostic("subscribe_failed",e);connectionFailed(e);});}}
            public void onFailure(IMqttToken token,Throwable error){worker.post(()->{diagnostic("connect_failed",error);connectionFailed(error);});}});
    }
    private void connectionFailed(Throwable error){if(mqttProxyAttempt){mqttDirectFallback=true;dispose();failures=0;diagnostic("proxy_fallback_direct",error);wake.schedule("retry",1000,this::ensure);}else retry(error);}
    private void receive(MqttAsyncClient source,String topic,String received,MqttMessage message,byte[] bytes) {
        try {
            JSONObject notice=bytes.length<=4096&&topic.equals(received)?new JSONObject(new String(bytes,StandardCharsets.UTF_8)):null;
            synchronized(this){if(client!=source||!GatewayPushPolicy.notice(notice,state.optLong("queued_version"),System.currentTimeMillis())){
                source.messageArrivedComplete(message.getId(),message.getQos());return;}}
            JSONObject saved=new JSONObject().put("notice",notice);save(noticeFile,saved);
            source.messageArrivedComplete(message.getId(),message.getQos());sync(notice);
        } catch(Exception error){retry();}
    }
    private void sync(JSONObject notice) {
        try {
            JSONObject body=identity();if(notice!=null)body.put("received_request_id",notice.getString("request_id")).put("received_version",notice.getLong("version"));
            JSONObject reply=GatewayRemoteHttp.request("/api/devices/push-sync",body);
            JSONObject adbSession=reply.optJSONObject("adb_session");
            if(adbSession!=null){adb.open(adbSession);reply.remove("adb_session");}
            JSONObject adbTunnel=reply.optJSONObject("adb_tunnel");
            if(adbTunnel!=null){tunnel.open(adbTunnel);reply.remove("adb_tunnel");}
            boolean actionable=reply.optJSONObject("managed_update")!=null||reply.optJSONObject("managed_task")!=null
                    ||reply.optJSONObject("status_request")!=null;
            if(actionable){JSONObject pending=new JSONObject().put("delivery_id",java.util.UUID.randomUUID().toString()).put("reply",reply)
                    .put("notice_version",notice==null?0:notice.optLong("version"));save(pendingFile,pending);wake();}
            else completeNotice(notice);
            diagnostic("synced",null);
        } catch(Exception unavailable){diagnostic("sync_failed",unavailable);worker.postDelayed(()->sync(notice),60000);}
    }
    private JSONObject identity() throws Exception {synchronized(this){return new JSONObject().put("device_id",state.getString("device_id")).put("token",state.getString("token"));}}
    private synchronized void completeNotice(JSONObject notice)throws Exception {
        if(notice!=null){state.put("queued_version",Math.max(state.optLong("queued_version"),notice.optLong("version")));save(stateFile,state);}
        if(noticeFile.exists()&&!noticeFile.delete())throw new IOException("notice cleanup failed");
    }
    private void wake() throws Exception {new ProcessBuilder("/system/bin/am","start-foreground-service","--user","0","-a",GatewayRemoteService.ACTION_PUSH,
            "-n",GatewayRemotePolicy.PACKAGE+"/.remote.GatewayRemoteService").redirectErrorStream(true).redirectOutput(new File(root,"wake-last.txt")).start();}
    private void retry(){retry(null);}
    private synchronized void retry(Throwable error){boolean failedProxy=connectedViaProxy;dispose();if(closed)return;if(failedProxy){mqttDirectFallback=true;failures=0;diagnostic("proxy_fallback_direct",error);wake.schedule("retry",1000,this::ensure);return;}long delay=GatewayPushPolicy.retry(failures++);diagnostic("retry_"+(error==null?"connection":error.getClass().getSimpleName()),error);wake.schedule("retry",delay,this::ensure);}
    private synchronized void dispose(){connected=false;connecting=false;connectedViaProxy=false;wake.cancel("connect-timeout");wake.cancel("retry");wake.release("connect");if(ping!=null){ping.stop();ping=null;}MqttAsyncClient old=client;client=null;if(old!=null){try{old.disconnectForcibly(0,500,false);}catch(Exception ignored){}try{old.close(true);}catch(Exception ignored){}}}
    private synchronized void diagnostic(String stage,Throwable error){
        try{state.put("last_stage",stage).put("last_attempt_at",System.currentTimeMillis())
                .put("last_error_class",error==null?"":error.getClass().getSimpleName());
            if(stage.startsWith("connected"))state.put("connected_at",System.currentTimeMillis());save(stateFile,state);}catch(Exception ignored){}
    }
    private GatewayMqttHeartbeat createHeartbeat(){
        final GatewayMqttHeartbeat[] owner=new GatewayMqttHeartbeat[1];
        owner[0]=new GatewayMqttHeartbeat(new GatewayMqttHeartbeat.Driver(){
            public void execute(Runnable action){Runnable guarded=()->{if(ping==owner[0])action.run();};if(Looper.myLooper()==worker.getLooper())guarded.run();else worker.post(guarded);}
            public void schedule(String key,long delay,Runnable action){wake.schedule(key,delay,()->{if(ping==owner[0])action.run();});}
            public void cancel(String key){wake.cancel(key);}public void hold(long timeout){wake.hold("ping",timeout);}public void release(){wake.release("ping");}
            public void failed(Throwable error){if(ping==owner[0])retry(error);}public void event(String message){diagnostic(message,null);}
        },SystemClock::elapsedRealtime);
        return owner[0];
    }
    @Override public void close(){closed=true;try{network.unregisterNetworkCallback(callback);}catch(Exception ignored){}tunnel.close();adb.close();dispose();wake.close();thread.quitSafely();}
    private static JSONObject read(File file) throws Exception{return new JSONObject(new String(new AtomicFile(file).readFully(),StandardCharsets.UTF_8));}
    private static void save(File file,JSONObject value) throws Exception{AtomicFile atomic=new AtomicFile(file);FileOutputStream out=atomic.startWrite();try{out.write(value.toString().getBytes(StandardCharsets.UTF_8));atomic.finishWrite(out);}catch(Exception error){atomic.failWrite(out);throw error;}}
}
