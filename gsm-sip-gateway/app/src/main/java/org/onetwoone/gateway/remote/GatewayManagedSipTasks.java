package org.onetwoone.gateway.remote;

import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.SystemClock;
import java.io.File;
import java.io.IOException;
import org.json.JSONArray;
import org.json.JSONObject;
import org.onetwoone.gateway.PjsipSipService;
import org.onetwoone.gateway.config.GatewayConfig;

/** Persistent configure_sip runner adapted from the D22 managed-task lifecycle. */
final class GatewayManagedSipTasks {
    private final Context context;
    private final GatewayRemoteStore store;
    private final Runnable changed;
    private final File activeFile;
    private volatile boolean running;

    GatewayManagedSipTasks(Context context,GatewayRemoteStore store,Runnable changed) {
        this.context=context.getApplicationContext();this.store=store;this.changed=changed;
        activeFile=new File(context.getFilesDir(),"gateway-sip-active.json");
    }

    synchronized void accept(JSONObject envelope) {
        JSONObject offer=envelope==null?null:envelope.optJSONObject("managed_task");if(offer==null)return;
        if(!"configure_sip".equals(offer.optString("type")))return;
        String id=offer.optString("id");
        try {
            JSONObject valid=GatewaySipTaskPolicy.offer(offer,System.currentTimeMillis());
            if(activeFile.isFile()) {
                JSONObject active=GatewayUpdateProgress.read(activeFile);
                if(!id.equals(active.optJSONObject("offer").optString("id")))return;
            } else GatewayUpdateProgress.write(activeFile,new JSONObject().put("offer",valid).put("stage","queued")
                    .put("created_at_ms",System.currentTimeMillis()));
            tick();
        } catch(Exception invalid) {
            if(id.matches("[A-Za-z0-9-]{1,96}"))try{terminal(id,"rejected","配置任务参数无效",
                    GatewaySipTaskPolicy.publicResult(id,false,false,"rejected",1,false));}catch(Exception ignored){}
        }
    }

    synchronized void tick() {
        if(running||!activeFile.isFile())return;running=true;
        new Thread(()->{try{execute();}finally{synchronized(GatewayManagedSipTasks.this){running=false;}}},"gateway-sip-task").start();
    }

    JSONObject targets() throws Exception {
        return new JSONObject().put("managed_sip_account",true).put("sip_targets",new JSONArray().put(new JSONObject()
                .put("target","gateway").put("label","Pixel 网关").put("auth_username_supported",false)
                .put("accounts",new JSONArray().put(new JSONObject().put("account_id","primary").put("label","主网关账号")))));
    }

    JSONArray registrations() throws Exception {
        PjsipSipService service=PjsipSipService.getInstance();
        String state=service==null?"unknown":service.isSipRegistered()?"registered":"unregistered";
        JSONObject row=new JSONObject().put("target","gateway").put("account_id","primary").put("state",state)
                .put("reason","").put("sampled_at",System.currentTimeMillis());
        String task=store.prefs.getString("sip_config_task_id","");if(!task.isEmpty())row.put("config_task_id",task);
        return new JSONArray().put(row);
    }

    private void execute() {
        String id="";
        try {
            JSONObject active=GatewayUpdateProgress.read(activeFile),offer=active.getJSONObject("offer");id=offer.getString("id");
            JSONObject saved=receipts().read(id);
            if(saved!=null){if(!saved.optBoolean("acknowledged"))post(saved);clear();return;}
            String stage=active.optString("stage","queued");
            if("queued".equals(stage)) {
                post(progress(id,"claimed","设备已接收网关配置",null));
                post(progress(id,"running","设备正在核验网关配置",null));
                JSONObject before=current(),params=offer.getJSONObject("params"),desired=new JSONObject(params.toString());
                if(params.optBoolean("keep_password"))desired.put("password",before.getString("password"));
                desired.remove("keep_password");
                PjsipSipService service=PjsipSipService.getInstance();Boolean busy=service==null?null:service.remoteBusy();
                if(busy==null||busy) {terminal(id,"failed","无法确认网关空闲，配置未修改",
                        GatewaySipTaskPolicy.publicResult(id,false,service!=null&&service.isSipRegistered(),"not_idle",1,false));return;}
                if(GatewaySipTaskPolicy.same(before,desired)) {
                    boolean registered=service.isSipRegistered();if(registered)store.prefs.edit().putString("sip_config_task_id",id).commit();
                    terminal(id,registered?"success":"failed",
                            registered?"配置相同，网关注册状态正常":"配置相同，但网关尚未注册",
                            GatewaySipTaskPolicy.publicResult(id,registered,registered,registered?"completed":"registration_failed",registered?0:1,false));return;
                }
                active.put("before",before).put("desired",desired).put("stage","verifying").put("changed_at_ms",System.currentTimeMillis());
                GatewayUpdateProgress.write(activeFile,active);
                apply(desired);reload(active);
                if(waitRegistered(active,60_000L)){terminalSuccess(id);return;}
                rollback(active,id,"新配置未能注册");return;
            }
            if("verifying".equals(stage)) {
                if(waitRegistered(active,60_000L)){terminalSuccess(id);return;}
                rollback(active,id,"进程恢复后仍未注册");return;
            }
            if("rollback_verifying".equals(stage)) {
                boolean restored=waitRegistered(active,60_000L);
                terminal(id,"failed",restored?active.optString("failure","配置失败")+"，已恢复原配置":"配置失败，原配置恢复尚未确认",
                        GatewaySipTaskPolicy.publicResult(id,false,restored,"failed",1,restored));
            }
        } catch(Exception error) {
            if(!id.isEmpty())try {
                if(receipts().read(id)!=null)return;
                JSONObject active=activeFile.isFile()?GatewayUpdateProgress.read(activeFile):null;
                if(active!=null&&active.has("before")&&!GatewaySipTaskPolicy.same(current(),active.getJSONObject("before"))) {
                    apply(active.getJSONObject("before"));active.put("stage","rollback_verifying").put("failure","网关配置事务异常");
                    GatewayUpdateProgress.write(activeFile,active);reload(active);
                    boolean restored=waitRegistered(active,60_000L);
                    terminal(id,"failed",restored?"网关配置事务异常，已恢复原配置":"网关配置事务异常，原配置恢复尚未确认",
                            GatewaySipTaskPolicy.publicResult(id,false,restored,"failed",1,restored));
                } else terminal(id,"failed","网关配置事务未完成",
                        GatewaySipTaskPolicy.publicResult(id,false,false,"failed",1,false));
            } catch(Exception ignored){}
        }
    }

    private void rollback(JSONObject active,String id,String failure)throws Exception {
        apply(active.getJSONObject("before"));active.put("stage","rollback_verifying").put("failure",failure);
        GatewayUpdateProgress.write(activeFile,active);reload(active);
        boolean restored=waitRegistered(active,60_000L);
        terminal(id,"failed",restored?failure+"，已恢复原配置":failure+"，原配置恢复尚未确认",
                GatewaySipTaskPolicy.publicResult(id,false,restored,"failed",1,restored));
    }

    private void terminalSuccess(String id)throws Exception {
        store.prefs.edit().putString("sip_config_task_id",id).commit();
        terminal(id,"success","网关SIP配置已写入并确认注册",
                GatewaySipTaskPolicy.publicResult(id,true,true,"completed",0,false));
    }

    private void terminal(String id,String state,String detail,JSONObject result)throws Exception {
        JSONObject body=progress(id,state,detail,result);receipts().save(body);
        post(body);clear();changed.run();
    }

    private JSONObject progress(String id,String state,String detail,JSONObject result)throws Exception {
        JSONObject body=new JSONObject().put("device_id",store.deviceId()).put("task_id",id).put("state",state).put("detail",detail);
        if(result!=null)body.put("result",result);return body;
    }

    private void post(JSONObject body)throws Exception {
        JSONObject wire=new JSONObject(body.toString()).put("token",store.token());
        JSONObject reply=GatewayRemoteHttp.request("/api/elfremote/task-progress",wire),task=reply.optJSONObject("task");
        String state=body.getString("state"),id=body.getString("task_id");
        if(task==null||!id.equals(task.optString("id"))||!(state.equals(task.optString("state"))
                ||("claimed".equals(state)&&"running".equals(task.optString("state")))))throw new IOException("task acknowledgement missing");
        if(GatewayTaskReceipts.terminal(state))receipts().acknowledge(id);
    }

    private JSONObject current() throws Exception {
        GatewayConfig c=GatewayConfig.getInstance();
        return new JSONObject().put("server",c.getSipServer().toLowerCase(java.util.Locale.US)).put("port",c.getSipPort())
                .put("username",c.getSipUser()).put("password",c.getSipPassword()).put("realm",c.getSipRealm())
                .put("transport",c.isUseTls()?"tls":"udp");
    }

    private void apply(JSONObject value)throws Exception {
        GatewayConfig c=GatewayConfig.getInstance();
        if(!c.commitSipConfig(value.getString("server"),value.getInt("port"),value.getString("username"),
                value.getString("password"),value.optString("realm","*"),"tls".equals(value.getString("transport"))))
            throw new IOException("configuration commit failed");
        if(!GatewaySipTaskPolicy.same(current(),value))throw new IOException("configuration readback mismatch");
    }

    private void reload(JSONObject active) throws Exception {
        PjsipSipService service=PjsipSipService.getInstance();
        active.put("reload_pid",android.os.Process.myPid()).put("reload_generation",service==null?-1:service.remoteReloadGeneration());
        GatewayUpdateProgress.write(activeFile,active);
        if(service==null){Intent intent=new Intent(context,PjsipSipService.class);if(Build.VERSION.SDK_INT>=26)context.startForegroundService(intent);else context.startService(intent);}
        else {Boolean busy=service.remoteBusy();if(busy==null||busy)throw new IOException("gateway no longer idle");service.reloadConfig();}
    }

    private boolean waitRegistered(JSONObject active,long timeout)throws InterruptedException {
        long end=SystemClock.elapsedRealtime()+timeout;
        int oldPid=active.optInt("reload_pid",-1);long oldGeneration=active.optLong("reload_generation",-1);boolean transitioned=false;
        while(SystemClock.elapsedRealtime()<end){
            PjsipSipService service=PjsipSipService.getInstance();
            if(android.os.Process.myPid()!=oldPid||service!=null&&service.remoteReloadGeneration()>oldGeneration)transitioned=true;
            if(transitioned&&service!=null&&!service.remoteReloadInProgress()&&service.isSipRegistered())return true;
            Thread.sleep(500);
        }
        return false;
    }

    private void clear()throws Exception {if(activeFile.exists()&&!activeFile.delete())throw new IOException("active task cleanup failed");}
    private GatewayTaskReceipts receipts(){return new GatewayTaskReceipts(new File(context.getFilesDir(),
            "gateway-task-receipts/"+hashDevice(store.deviceId())));}
    private static String hashDevice(String id){try{return GatewayRemoteStore.hash(id);}catch(Exception error){return "unpaired";}}
}
