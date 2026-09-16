package org.onetwoone.gateway.remote;

import android.content.Context;
import android.os.Handler;
import java.io.File;
import java.io.IOException;
import org.json.JSONObject;

/** Persistent Pixel Wi-Fi task runner using the shared elfRemote lifecycle. */
final class GatewayManagedWifiTasks {
    private final Context context;private final GatewayRemoteStore store;private final Runnable changed;private final Handler worker;
    private final File activeFile;private final GatewayWifiConnector connector;private boolean running;
    GatewayManagedWifiTasks(Context context,GatewayRemoteStore store,Handler worker,Runnable changed){
        this.context=context.getApplicationContext();this.store=store;this.worker=worker;this.changed=changed;
        activeFile=new File(context.getFilesDir(),"gateway-wifi-task-"+hashDevice(store.deviceId())+".json");connector=new GatewayWifiConnector(context,worker);
        if(connector.busy())worker.post(()->connector.recover(this::finishConnect));
    }
    synchronized void accept(JSONObject envelope){
        JSONObject offer=envelope==null?null:envelope.optJSONObject("managed_task");if(offer==null)return;
        String type=offer.optString("type");
        if("scan_wifi".equals(type)&&!offer.optBoolean("managed_wifi_scan_v1"))return;
        if("connect_wifi".equals(type)&&!offer.optBoolean("managed_wifi_config_v1"))return;
        if(!"scan_wifi".equals(type)&&!"connect_wifi".equals(type))return;
        try {
            JSONObject task=GatewayWifiPolicy.offer(offer,System.currentTimeMillis());String id=task.getString("id");
            JSONObject receipt=receipts().read(id);if(receipt!=null){
                if(receipt.optBoolean("acknowledged")){clearIfSame(id);return;}
                post(receipt);clearIfSame(id);return;
            }
            if(activeFile.exists()){
                JSONObject active=GatewayUpdateProgress.read(activeFile);
                if(!id.equals(active.optString("id")))return;
            } else GatewayUpdateProgress.write(activeFile,new JSONObject().put("task",task).put("phase","queued"));
            start();
        } catch(Exception ignored) { }
    }
    synchronized void tick(){if(activeFile.exists())start();}
    private synchronized void start(){if(running)return;running=true;new Thread(()->{try{execute();}finally{synchronized(GatewayManagedWifiTasks.this){running=false;}}},"gateway-wifi-task").start();}
    private void execute(){
        try {
            JSONObject active=GatewayUpdateProgress.read(activeFile),task=active.getJSONObject("task");String id=task.getString("id"),phase=active.optString("phase","queued");
            if(System.currentTimeMillis()>=task.getLong("expires_at")){terminal(id,"expired","wifi-task-expired",null);return;}
            if("queued".equals(phase)){post(progress(id,"claimed","wifi-task-claimed",null));active.put("phase","running");GatewayUpdateProgress.write(activeFile,active);}
            post(progress(id,"running","wifi-task-running",null));
            if("scan_wifi".equals(task.getString("type"))){JSONObject scan=GatewayWifiScanner.scan(context);
                terminal(id,"success","wifi-scan-complete",new JSONObject().put("stage","wifi").put("action","scanned").put("wifi_scan",scan));return;}
            if(connector.busy()&&!id.equals(connector.pendingTask()))throw new IOException("wifi transaction busy");
            if(connector.busy())connector.recover(this::finishConnect);
            else connector.connect(id,task.getJSONObject("params"),this::finishConnect);
        } catch(Exception error){
            try {JSONObject active=activeFile.exists()?GatewayUpdateProgress.read(activeFile):null;
                if(active!=null)terminal(active.getJSONObject("task").getString("id"),"failed","wifi-task-failed",new JSONObject().put("stage","wifi").put("action","failed"));}
            catch(Exception ignored){}
        }
    }
    private void finishConnect(boolean ok,String detail,JSONObject result){
        try {JSONObject active=GatewayUpdateProgress.read(activeFile);terminal(active.getJSONObject("task").getString("id"),ok?"success":"failed",detail,result);}
        catch(Exception ignored){changed.run();}
    }
    private void terminal(String id,String state,String detail,JSONObject result)throws Exception {
        JSONObject body=progress(id,state,detail,result);receipts().save(body);post(body);clear();changed.run();
    }
    private JSONObject progress(String id,String state,String detail,JSONObject result)throws Exception {
        JSONObject body=new JSONObject().put("device_id",store.deviceId()).put("task_id",id).put("state",state).put("detail",detail);
        if(result!=null)body.put("result",result);return body;
    }
    private void post(JSONObject body)throws Exception {
        JSONObject wire=new JSONObject(body.toString()).put("token",store.token());JSONObject reply=GatewayRemoteHttp.request("/api/elfremote/task-progress",wire),task=reply.optJSONObject("task");
        String state=body.getString("state"),id=body.getString("task_id");
        if(task==null||!id.equals(task.optString("id"))||!(state.equals(task.optString("state"))||("claimed".equals(state)&&"running".equals(task.optString("state")))))
            throw new IOException("task acknowledgement missing");
        if(GatewayTaskReceipts.terminal(state))receipts().acknowledge(id);
    }
    private void clear()throws Exception {if(activeFile.exists()&&!activeFile.delete())throw new IOException("active task cleanup failed");}
    private void clearIfSame(String id)throws Exception {
        if(!activeFile.exists())return;JSONObject active=GatewayUpdateProgress.read(activeFile);
        if(id.equals(active.optJSONObject("task") == null ? "" : active.getJSONObject("task").optString("id")))clear();
    }
    private GatewayTaskReceipts receipts(){return new GatewayTaskReceipts(new File(context.getFilesDir(),"gateway-task-receipts/"+hashDevice(store.deviceId())));}
    private static String hashDevice(String id){try{return GatewayRemoteStore.hash(id);}catch(Exception error){return "unpaired";}}
}
