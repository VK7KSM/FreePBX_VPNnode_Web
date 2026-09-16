package org.onetwoone.gateway.remote;

import android.content.Context;
import java.io.File;
import java.io.IOException;
import java.io.InterruptedIOException;
import java.net.URL;
import org.json.JSONObject;

/** Persistent typed proxy tasks. Sensitive configuration never enters receipts or preferences. */
final class GatewayManagedProxyTasks {
    private final Context context;private final GatewayRemoteStore store;private final Runnable changed;private final File activeFile;private boolean running;
    GatewayManagedProxyTasks(Context context,GatewayRemoteStore store,Runnable changed){this.context=context.getApplicationContext();this.store=store;this.changed=changed;
        activeFile=new File(context.getFilesDir(),"gateway-proxy-active-"+hashDevice(store.deviceId())+".json");}
    synchronized void accept(JSONObject envelope){JSONObject offer=envelope==null?null:envelope.optJSONObject("managed_task");if(offer==null||!offer.optBoolean("managed_proxy_v1")||!supported(offer.optString("type")))return;
        try{JSONObject task=validate(offer),receipt=receipts().read(task.getString("id"));if(receipt!=null){if(!receipt.optBoolean("acknowledged"))post(receipt);clearIfSame(task.getString("id"));return;}
            if(activeFile.exists()){JSONObject active=GatewayUpdateProgress.read(activeFile),current=active.getJSONObject("task");if(!task.getString("id").equals(current.getString("id")))return;
                if(task.optBoolean("cancel_requested")&&!current.optBoolean("cancel_requested")){current.put("cancel_requested",true);GatewayUpdateProgress.write(activeFile,active);}}
            else GatewayUpdateProgress.write(activeFile,new JSONObject().put("task",task).put("phase","queued"));start();
        }catch(Exception ignored){}}
    synchronized void tick(){if(activeFile.exists())start();}
    private synchronized void start(){if(running)return;running=true;new Thread(()->{try{execute();}finally{synchronized(GatewayManagedProxyTasks.this){running=false;}}},"gateway-proxy-task").start();}
    private void execute(){String id="";try{JSONObject active=GatewayUpdateProgress.read(activeFile),task=validate(active.getJSONObject("task"));id=task.getString("id");
            if(System.currentTimeMillis()>=task.getLong("expires_at")){terminal(id,"expired","proxy-task-expired",null);return;}if(cancelled(id)){terminal(id,"failed","proxy-task-cancelled",null);return;}
            String phase=active.optString("phase","queued");if("queued".equals(phase)){if(!postAvailable(progress(id,"claimed","proxy-task-claimed",null)))return;active.put("phase","claimed");GatewayUpdateProgress.write(activeFile,active);phase="claimed";}
            if("claimed".equals(phase)){if(!postAvailable(progress(id,"running","proxy-task-running",null)))return;active.put("phase","running");GatewayUpdateProgress.write(activeFile,active);}
            String type=task.getString("type");JSONObject status;
            if("configure_proxy".equals(type)){JSONObject params=task.getJSONObject("params");final String taskId=id;File staged=GatewayProxyConfigDownload.download(context,params,()->cancelled(taskId));if(cancelled(id)){terminal(id,"failed","proxy-task-cancelled",null);return;}
                try{status=GatewayCoreClient.configureProxy(context,staged,params.getLong("size"),params.getString("sha256"));}finally{cleanupConfigs();}}
            else if("start_proxy".equals(type))status=GatewayCoreClient.startProxy(context);
            else if("stop_proxy".equals(type))status=GatewayCoreClient.stopProxy(context);
            else status=GatewayCoreClient.testProxy(context);
            GatewayProxyRoute.setPreferred(status.optBoolean("proxy_reachable")&&status.optBoolean("http_ready"));
            terminal(id,"success","proxy-task-complete",new JSONObject().put("stage","proxy").put("action",type).put("proxy",status));
        }catch(Exception failure){try{if(!id.isEmpty())terminal(id,"failed",category(failure),null);else clear();}catch(Exception ignored){}}}
    private boolean cancelled(String id){try{JSONObject active=GatewayUpdateProgress.read(activeFile),task=active.getJSONObject("task");return id.equals(task.optString("id"))&&task.optBoolean("cancel_requested");}catch(Exception ignored){return true;}}
    private void cleanupConfigs(){File parent=new File(context.getFilesDir(),"proxy-config"),files[]=parent.listFiles((dir,name)->name.matches("[0-9a-f]{64}\\.yaml"));if(files!=null)for(File file:files)file.delete();}
    static JSONObject validate(JSONObject task)throws Exception {String type=task==null?"":task.optString("type"),id=task==null?"":task.optString("id");long expires=task==null?0:task.optLong("expires_at"),now=System.currentTimeMillis();if(task==null||!id.matches("[A-Za-z0-9-]{1,96}")||expires<=0||expires>now+1_800_000L||!supported(type))throw new IOException("invalid proxy task");
        if("configure_proxy".equals(type)){JSONObject params=task.optJSONObject("params");if(params==null||params.length()!=3)throw new IOException("invalid proxy parameters");URL url=GatewayProxyConfigDownload.validateUrl(params.optString("url"));if(!url.getPath().endsWith("/"+id)||params.optLong("size")<2||params.optLong("size")>GatewayProxyPolicy.MAX_CONFIG_BYTES||!params.optString("sha256").matches("[0-9a-f]{64}"))throw new IOException("invalid proxy parameters");}
        else if(task.has("params")&&task.optJSONObject("params")!=null&&task.optJSONObject("params").length()!=0)throw new IOException("unexpected proxy parameters");return task;}
    private static boolean supported(String type){return "configure_proxy".equals(type)||"start_proxy".equals(type)||"stop_proxy".equals(type)||"test_proxy".equals(type);}
    private static String category(Exception failure){if(failure instanceof InterruptedIOException)return "proxy-task-cancelled";if(failure instanceof SecurityException)return "proxy-security-rejected";if(failure instanceof java.net.SocketTimeoutException)return "proxy-network-timeout";return "proxy-operation-failed";}
    private void terminal(String id,String state,String detail,JSONObject result)throws Exception{JSONObject body=progress(id,state,detail,result);receipts().save(body);post(body);clear();changed.run();}
    private JSONObject progress(String id,String state,String detail,JSONObject result)throws Exception{JSONObject body=new JSONObject().put("device_id",store.deviceId()).put("task_id",id).put("state",state).put("detail",detail);if(result!=null)body.put("result",result);return body;}
    private boolean postAvailable(JSONObject body){try{post(body);return true;}catch(Exception unavailable){changed.run();return false;}}
    private void post(JSONObject body)throws Exception{JSONObject reply=GatewayRemoteHttp.request("/api/elfremote/task-progress",new JSONObject(body.toString()).put("token",store.token())),task=reply.optJSONObject("task");String state=body.getString("state"),id=body.getString("task_id");
        if(task==null||!id.equals(task.optString("id"))||!(state.equals(task.optString("state"))||("claimed".equals(state)&&"running".equals(task.optString("state")))))throw new IOException("task acknowledgement missing");if(GatewayTaskReceipts.terminal(state))receipts().acknowledge(id);}
    private void clear()throws Exception{if(activeFile.exists()&&!activeFile.delete())throw new IOException("active proxy task cleanup failed");}
    private void clearIfSame(String id)throws Exception{if(!activeFile.exists())return;JSONObject active=GatewayUpdateProgress.read(activeFile);if(id.equals(active.getJSONObject("task").optString("id")))clear();}
    private GatewayTaskReceipts receipts(){return new GatewayTaskReceipts(new File(context.getFilesDir(),"gateway-task-receipts/"+hashDevice(store.deviceId())));}
    private static String hashDevice(String id){try{return GatewayRemoteStore.hash(id);}catch(Exception ignored){return "unpaired";}}
}
