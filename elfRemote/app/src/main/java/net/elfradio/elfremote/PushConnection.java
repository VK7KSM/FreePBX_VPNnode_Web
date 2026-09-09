package net.elfradio.elfremote;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import org.json.JSONObject;
import java.io.IOException;

/** 应用只交付身份与领取通知；MQTT连接由独立维护核心持有。 */
final class PushConnection {
    interface Receiver { void receive(JSONObject notification,Runnable acknowledge)throws Exception; }
    private final Context context;
    private final PairingStore pairing;
    private final Receiver receiver;
    private final WakeScheduler legacyWake;
    private SharedPreferences prefs;
    private String identity="";
    private boolean connected,closed;
    PushConnection(Context context,Handler worker,PairingStore pairing,Receiver receiver){
        this.context=context;this.pairing=pairing;this.receiver=receiver;legacyWake=new WakeScheduler(context);
        // 升级后清除原应用连接遗留的闹钟，新核心使用系统所有者监听器。
        for(String key:new String[]{"retry","connect-timeout","ping"})legacyWake.cancel(key);
    }
    void ensure(){
        if(closed)return;
        try {
            if(!pairing.registered()){
                CoreClient.request("/push/disable",new JSONObject());connected=false;identity="";prefs=null;return;
            }
            String next=PairingStore.sha256Hex(Protocol.BASE_URL+":"+pairing.deviceId());
            if(!next.equals(identity)){identity=next;prefs=context.getSharedPreferences("push-"+identity,Context.MODE_PRIVATE);}
            JSONObject health=CoreClient.health();
            if(!health.optBoolean("independent_push")){connected=false;return;}
            JSONObject request=identityBody().put("queued_version",lastVersion());
            String saved=prefs.getString("connection","");if(!saved.isEmpty())request.put("connection",new JSONObject(saved));
            JSONObject status=CoreClient.request("/push/config",request);
            connected=status!=null&&status.optBoolean("connected");
            JSONObject notice=status==null?null:status.optJSONObject("notification");
            if(notice!=null)receiver.receive(notice,()->{});
        }catch(Exception error){connected=false;RuntimeLog.error("core_push_handoff_pending",error);}
    }
    private JSONObject identityBody()throws Exception{return new JSONObject().put("device_id",pairing.deviceId()).put("token",pairing.token());}
    long lastVersion(){return prefs==null?0:prefs.getLong("queued_version",0);}
    void recordQueued(JSONObject notice)throws Exception {
        if(prefs==null||!prefs.edit().putLong("queued_version",notice.getLong("version")).commit())throw new IOException("push receipt persistence failed");
        try{CoreClient.request("/push/config",identityBody().put("queued_version",lastVersion()));}
        catch(Exception pending){RuntimeLog.error("core_push_queue_ack_pending",pending);}
    }
    boolean connected(){return connected;}
    void networkHint(){if(closed)return;try{CoreClient.request("/push/hint",new JSONObject());}catch(Exception ignored){}ensure();}
    void wake(String key){ensure();}
    void close(){closed=true;connected=false;}
}
