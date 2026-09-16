package org.onetwoone.gateway.remote;

import android.content.Context;
import java.io.File;
import java.io.IOException;
import org.json.JSONObject;
import org.onetwoone.gateway.PjsipSipService;

/** Persistent, disabled-by-default staging task for the Pixel root companion. */
final class GatewayManagedCompanionTasks {
    interface Stager { JSONObject stage(Boolean gatewayBusy) throws Exception; }

    private final Context context;private final GatewayRemoteStore store;private final Runnable changed;
    private final File activeFile;private final Stager stager;private boolean running;

    GatewayManagedCompanionTasks(Context context,GatewayRemoteStore store,Runnable changed) {
        this(context,store,changed,busy->new GatewayPixelCompanionController(context).installDisabled(busy));
    }
    GatewayManagedCompanionTasks(Context context,GatewayRemoteStore store,Runnable changed,Stager stager) {
        this.context=context.getApplicationContext();this.store=store;this.changed=changed;this.stager=stager;
        activeFile=new File(context.getFilesDir(),"gateway-companion-active-"+hashDevice(store.deviceId())+".json");
    }

    synchronized void accept(JSONObject envelope) {
        JSONObject offer=envelope==null?null:envelope.optJSONObject("managed_task");
        if(offer==null||!offer.optBoolean("managed_pixel_companion_v1")
                ||!"stage_pixel_companion".equals(offer.optString("type")))return;
        try {
            JSONObject task=validate(offer),saved=receipts().read(task.getString("id"));
            if(saved!=null){if(!saved.optBoolean("acknowledged"))post(saved);clearIfSame(task.getString("id"));return;}
            if(activeFile.exists()) {
                JSONObject active=GatewayUpdateProgress.read(activeFile),current=active.getJSONObject("task");
                if(!task.getString("id").equals(current.getString("id")))return;
                if(task.optBoolean("cancel_requested")&&!current.optBoolean("cancel_requested")) {
                    current.put("cancel_requested",true);GatewayUpdateProgress.write(activeFile,active);
                }
            } else GatewayUpdateProgress.write(activeFile,new JSONObject().put("task",task).put("phase","queued"));
            start();
        } catch(Exception ignored) {}
    }

    synchronized void tick(){if(activeFile.exists())start();}
    private synchronized void start(){if(running)return;running=true;new Thread(()->{
        try{execute();}finally{synchronized(GatewayManagedCompanionTasks.this){running=false;}}
    },"gateway-companion-task").start();}

    private void execute() {
        String id="";
        try {
            JSONObject active=GatewayUpdateProgress.read(activeFile),task=validate(active.getJSONObject("task"));id=task.getString("id");
            JSONObject saved=receipts().read(id);if(saved!=null){if(!saved.optBoolean("acknowledged"))post(saved);clearIfSame(id);return;}
            if(System.currentTimeMillis()>=task.getLong("expires_at")){terminal(id,"expired","companion-task-expired",null);return;}
            if(task.optBoolean("cancel_requested")){terminal(id,"failed","companion-task-cancelled",null);return;}
            String phase=active.optString("phase","queued");
            if("queued".equals(phase)) {
                if(!postAvailable(progress(id,"claimed","companion-task-claimed",null)))return;
                active.put("phase","claimed");GatewayUpdateProgress.write(activeFile,active);phase="claimed";
            }
            if("claimed".equals(phase)) {
                if(!postAvailable(progress(id,"running","companion-task-running",null)))return;
                active.put("phase","running");GatewayUpdateProgress.write(activeFile,active);phase="running";
            }
            JSONObject result;
            if("applied".equals(phase))result=active.getJSONObject("result");
            else {
                PjsipSipService service=PjsipSipService.getInstance();Boolean busy=service==null?null:service.remoteBusy();
                result=publicResult(stager.stage(busy));
                active.put("phase","applied").put("result",result);GatewayUpdateProgress.write(activeFile,active);
            }
            terminal(id,"success","companion-staged-disabled",result);
        } catch(Exception failure) {
            try{if(!id.isEmpty())terminal(id,"failed",category(failure),null);else clear();}catch(Exception ignored){}
        }
    }

    static JSONObject validate(JSONObject task)throws Exception {
        long now=System.currentTimeMillis(),expires=task==null?0:task.optLong("expires_at");
        if(task==null||!task.optString("id").matches("[A-Za-z0-9-]{1,96}")
                ||!"stage_pixel_companion".equals(task.optString("type"))||expires<=0||expires>now+1_800_000L)
            throw new IOException("invalid companion task");
        JSONObject params=task.optJSONObject("params");
        if(task.has("params")&&(params==null||params.length()!=0))throw new IOException("unexpected companion parameters");
        return task;
    }

    static JSONObject publicResult(JSONObject raw)throws Exception {
        String state=raw==null?"":raw.optString("state"),legacy=raw==null?"":raw.optString("legacy_modules");
        JSONObject units=raw==null?null:raw.optJSONObject("units"),legacyStatus=raw==null?null:raw.optJSONObject("legacy");
        if(!java.util.Arrays.asList("installed","unchanged","upgraded").contains(state)
                ||raw.optBoolean("units_enabled",true)
                ||raw.optBoolean("rollback_available")!=true
                ||!disabledUnits(units)||!validLegacy(legacy,legacyStatus))
            throw new SecurityException("invalid companion result");
        return new JSONObject().put("stage","pixel_companion").put("action","staged")
                .put("state",state).put("units_enabled",false)
                .put("rollback_available",true).put("legacy_modules",legacy).put("units",units).put("legacy",legacyStatus);
    }

    private static boolean disabledUnits(JSONObject value) {
        return value!=null&&value.length()==3&&!value.optBoolean("charge",true)&&!value.optBoolean("audio",true)&&!value.optBoolean("adb_tcp",true);
    }
    private static boolean validLegacy(String mode,JSONObject value) {
        if(value==null||value.length()!=2)return false;
        JSONObject charge=value.optJSONObject("charge_bypass"),audio=value.optJSONObject("sip_audio_access");
        if(!legacyEntry(charge)||!legacyEntry(audio))return false;
        boolean chargeInstalled=charge.optBoolean("installed"),audioInstalled=audio.optBoolean("installed");
        if("preserved".equals(mode))return chargeInstalled&&audioInstalled&&!charge.optBoolean("disabled",true)&&!audio.optBoolean("disabled",true)
                &&charge.optBoolean("recognized")&&audio.optBoolean("recognized");
        if("partial".equals(mode)) {
            JSONObject installed=chargeInstalled?charge:audio;
            return chargeInstalled^audioInstalled&&!installed.optBoolean("disabled",true)&&installed.optBoolean("recognized");
        }
        return "absent".equals(mode)&&!chargeInstalled&&!audioInstalled
                &&!charge.optBoolean("disabled")&&!charge.optBoolean("recognized")&&!audio.optBoolean("disabled")&&!audio.optBoolean("recognized");
    }
    private static boolean legacyEntry(JSONObject value) {
        return value!=null&&value.length()==3&&value.has("installed")&&value.has("disabled")&&value.has("recognized")
                &&value.opt("installed") instanceof Boolean&&value.opt("disabled") instanceof Boolean&&value.opt("recognized") instanceof Boolean;
    }

    private static String category(Exception failure) {
        String message=String.valueOf(failure.getMessage());
        if(message.contains("idle"))return "gateway-not-confirmed-idle";
        if(failure instanceof SecurityException)return "companion-security-rejected";
        return "companion-stage-failed";
    }
    private void terminal(String id,String state,String detail,JSONObject result)throws Exception {
        JSONObject body=progress(id,state,detail,result);receipts().save(body);post(body);clear();changed.run();
    }
    private JSONObject progress(String id,String state,String detail,JSONObject result)throws Exception {
        JSONObject body=new JSONObject().put("device_id",store.deviceId()).put("task_id",id).put("state",state).put("detail",detail);
        if(result!=null)body.put("result",result);return body;
    }
    private boolean postAvailable(JSONObject body){try{post(body);return true;}catch(Exception unavailable){changed.run();return false;}}
    private void post(JSONObject body)throws Exception {
        JSONObject reply=GatewayRemoteHttp.request("/api/elfremote/task-progress",new JSONObject(body.toString()).put("token",store.token())),task=reply.optJSONObject("task");
        String state=body.getString("state"),id=body.getString("task_id");
        if(task==null||!id.equals(task.optString("id"))||!(state.equals(task.optString("state"))
                ||("claimed".equals(state)&&"running".equals(task.optString("state")))))throw new IOException("task acknowledgement missing");
        if(GatewayTaskReceipts.terminal(state))receipts().acknowledge(id);
    }
    private void clear()throws Exception{if(activeFile.exists()&&!activeFile.delete())throw new IOException("active companion task cleanup failed");}
    private void clearIfSame(String id)throws Exception{if(!activeFile.exists())return;JSONObject active=GatewayUpdateProgress.read(activeFile);if(id.equals(active.getJSONObject("task").optString("id")))clear();}
    private GatewayTaskReceipts receipts(){return new GatewayTaskReceipts(new File(context.getFilesDir(),"gateway-task-receipts/"+hashDevice(store.deviceId())));}
    private static String hashDevice(String id){try{return GatewayRemoteStore.hash(id);}catch(Exception ignored){return "unpaired";}}
}
