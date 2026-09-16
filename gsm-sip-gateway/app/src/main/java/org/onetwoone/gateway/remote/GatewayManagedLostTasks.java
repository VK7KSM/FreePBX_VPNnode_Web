package org.onetwoone.gateway.remote;

import android.content.Context;
import java.io.File;
import java.io.IOException;
import org.json.JSONObject;
import org.onetwoone.gateway.PjsipSipService;

/** Handles the narrow Pixel lost-device contract: alarm control and fresh location. */
final class GatewayManagedLostTasks {
    private final Context context;private final GatewayRemoteStore store;private final GatewayLocationSampler location;
    private final GatewayAlarmPlayer alarm;private final Runnable changed;private final File activeFile;private String locating="";
    GatewayManagedLostTasks(Context context,GatewayRemoteStore store,GatewayLocationSampler location,GatewayAlarmPlayer alarm,Runnable changed){
        this.context=context.getApplicationContext();this.store=store;this.location=location;this.alarm=alarm;this.changed=changed;
        activeFile=new File(context.getFilesDir(),"gateway-lost-active-"+hashDevice(store.deviceId())+".json");
    }
    synchronized void accept(JSONObject envelope){JSONObject offer=envelope==null?null:envelope.optJSONObject("managed_task");if(offer==null)return;
        String type=offer.optString("type");boolean allowed=(offer.optBoolean("managed_alarm_v1")&&("play_alarm".equals(type)||"stop_alarm".equals(type)))
                ||(offer.optBoolean("managed_locate_v1")&&"locate_now".equals(type));if(!allowed)return;
        try{JSONObject task=validate(offer),receipt=receipts().read(task.getString("id"));if(receipt!=null){if(!receipt.optBoolean("acknowledged"))post(receipt);clearIfSame(task.getString("id"));return;}
            if(activeFile.exists()){JSONObject active=GatewayUpdateProgress.read(activeFile);if(!task.getString("id").equals(active.getJSONObject("task").getString("id")))return;}
            else GatewayUpdateProgress.write(activeFile,new JSONObject().put("task",task).put("phase","queued"));run();
        }catch(Exception ignored){}
    }
    synchronized void tick(){if(activeFile.exists())run();}
    private synchronized void run(){String id="";try{JSONObject active=GatewayUpdateProgress.read(activeFile),task=validate(active.getJSONObject("task"));id=task.getString("id");String phase=active.optString("phase","queued");
            if(System.currentTimeMillis()>=task.getLong("expires_at")){terminal(id,"expired","task-expired",null);return;}
            if(task.optBoolean("cancel_requested")){terminal(id,"failed","task-cancelled",null);return;}
            if(!"running".equals(phase)){post(progress(id,"claimed","task-claimed",null));post(progress(id,"running","task-running",null));active.put("phase","running");GatewayUpdateProgress.write(activeFile,active);}
            String type=task.getString("type");if("locate_now".equals(type)){if(id.equals(locating))return;locating=id;final String taskId=id;
                location.requestNow(()->locationComplete(taskId));return;}
            JSONObject status;if("play_alarm".equals(type)){PjsipSipService service=PjsipSipService.getInstance();status=alarm.play(id,service==null?null:service.remoteBusy());}
            else status=alarm.stop();terminal(id,"success","alarm-"+status.getString("state"),new JSONObject().put("stage","alarm").put("action",status.getString("state")).put("alarm",status));
        }catch(Exception failure){try{if(!id.isEmpty())terminal(id,"failed",safeReason(failure),null);else clear();}catch(Exception ignored){}}}
    private synchronized void locationComplete(String id){if(!id.equals(locating))return;locating="";try{String outcome=location.requestOutcome();
            terminal(id,"sampled".equals(outcome)?"success":"failed","location-"+outcome,new JSONObject().put("stage","location").put("action",outcome));}
        catch(Exception ignored){changed.run();}}
    JSONObject alarmSnapshot()throws Exception{return alarm.snapshot();}
    void close(){alarm.close();}
    private static JSONObject validate(JSONObject task)throws Exception {String type=task==null?"":task.optString("type");if(task==null||!task.optString("id").matches("[A-Za-z0-9-]{1,96}")
            ||task.optLong("expires_at")<=0||!("play_alarm".equals(type)||"stop_alarm".equals(type)||"locate_now".equals(type)))throw new IOException("invalid task");return task;}
    private static String safeReason(Exception error){String value=error.getMessage();return value==null||value.isEmpty()?error.getClass().getSimpleName():value.substring(0,Math.min(80,value.length()));}
    private void terminal(String id,String state,String detail,JSONObject result)throws Exception {JSONObject body=progress(id,state,detail,result);receipts().save(body);post(body);clear();changed.run();}
    private JSONObject progress(String id,String state,String detail,JSONObject result)throws Exception {JSONObject body=new JSONObject().put("device_id",store.deviceId()).put("task_id",id).put("state",state).put("detail",detail);if(result!=null)body.put("result",result);return body;}
    private void post(JSONObject body)throws Exception {JSONObject reply=GatewayRemoteHttp.request("/api/elfremote/task-progress",new JSONObject(body.toString()).put("token",store.token())),task=reply.optJSONObject("task");
        String state=body.getString("state"),id=body.getString("task_id");if(task==null||!id.equals(task.optString("id"))||!(state.equals(task.optString("state"))||("claimed".equals(state)&&"running".equals(task.optString("state")))))throw new IOException("task acknowledgement missing");if(GatewayTaskReceipts.terminal(state))receipts().acknowledge(id);}
    private void clear()throws Exception {if(activeFile.exists()&&!activeFile.delete())throw new IOException("active task cleanup failed");}
    private void clearIfSame(String id)throws Exception {if(!activeFile.exists())return;JSONObject active=GatewayUpdateProgress.read(activeFile);if(id.equals(active.getJSONObject("task").optString("id")))clear();}
    private GatewayTaskReceipts receipts(){return new GatewayTaskReceipts(new File(context.getFilesDir(),"gateway-task-receipts/"+hashDevice(store.deviceId())));}
    private static String hashDevice(String id){try{return GatewayRemoteStore.hash(id);}catch(Exception ignored){return "unpaired";}}
}
