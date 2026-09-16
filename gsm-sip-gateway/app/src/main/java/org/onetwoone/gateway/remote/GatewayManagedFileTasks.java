package org.onetwoone.gateway.remote;

import android.content.Context;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

/** Persistent file-manager task runner. The existing Web UI and protocol remain unchanged. */
final class GatewayManagedFileTasks {
    private final Context context;private final GatewayRemoteStore store;private final Runnable changed;private final File activeFile,base;private boolean running;
    GatewayManagedFileTasks(Context context,GatewayRemoteStore store,Runnable changed){this.context=context.getApplicationContext();this.store=store;this.changed=changed;base=new File(context.getFilesDir(),"gateway-file-tasks");activeFile=new File(context.getFilesDir(),"gateway-file-active-"+hashDevice(store.deviceId())+".json");}
    synchronized void accept(JSONObject envelope){JSONObject offer=envelope==null?null:envelope.optJSONObject("managed_task");if(offer==null||!offer.optBoolean("managed_exec_v1")||!"file_manage".equals(offer.optString("type")))return;try{
        JSONObject task=validate(offer),receipt=receipts().read(task.getString("id"));if(receipt!=null){if(!receipt.optBoolean("acknowledged"))post(receipt);clearIfSame(task.getString("id"));return;}
        if(activeFile.exists()){JSONObject active=GatewayUpdateProgress.read(activeFile);if(!task.getString("id").equals(active.getJSONObject("task").getString("id")))return;}
        else GatewayUpdateProgress.write(activeFile,new JSONObject().put("task",task).put("phase","queued"));
        if(task.optBoolean("cancel_requested"))cancel(task.getString("id"));start();
    }catch(Exception ignored){}}
    synchronized void tick(){if(activeFile.exists())start();}
    private synchronized void start(){if(running)return;running=true;new Thread(()->{try{execute();}finally{synchronized(GatewayManagedFileTasks.this){running=false;}}},"gateway-file-task").start();}
    private void execute(){String id="";try{JSONObject active=GatewayUpdateProgress.read(activeFile),task=validate(active.getJSONObject("task"));id=task.getString("id");String phase=active.optString("phase","queued");
            if(System.currentTimeMillis()>=task.getLong("expires_at")){terminal(id,"queued".equals(phase)?"expired":"failed","file-task-expired",failureResult("expired"));return;}
            if(task.optBoolean("cancel_requested")){terminal(id,"failed","file-operation-cancelled",failureResult("cancelled"));return;}
            if("queued".equals(phase)){post(progress(id,"claimed","file-task-claimed",null));active.put("phase","claimed");GatewayUpdateProgress.write(activeFile,active);}
            post(progress(id,"running","file-task-running",null));active.put("phase","running");GatewayUpdateProgress.write(activeFile,active);
            JSONObject outcome=runRoot(id,task.getJSONObject("params"));JSONObject result=new JSONObject().put("text",outcome.getString("output")).put("truncated",outcome.optBoolean("truncated"))
                .put("exit_code",outcome.getInt("exit_code")).put("elapsed_ms",outcome.getLong("elapsed_ms")).put("stage","file").put("action","completed");terminal(id,"success","file-operation-complete",result);}
        catch(Exception failure){try{if(!id.isEmpty()){JSONObject saved=receipts().read(id);if(saved!=null){if(!saved.optBoolean("acknowledged"))post(saved);clearIfSame(id);}else terminal(id,"failed","file-operation-failed",failureResult("failed"));}else clear();}catch(Exception ignored){}}}
    private JSONObject runRoot(String id,JSONObject params)throws Exception {File dir=new File(base,GatewayRemoteStore.hash(id));if(!dir.isDirectory()&&!dir.mkdirs())throw new IOException("task directory unavailable");File request=new File(dir,"request.json");GatewayUpdateProgress.write(request,params);String token=GatewayWifiConnector.randomToken();Process process=null;long deadline=android.os.SystemClock.elapsedRealtime()+125_000L;
        try(ServerSocket server=new ServerSocket(0,1,InetAddress.getByName("127.0.0.1"))){server.setSoTimeout(125_000);String command="export CLASSPATH="+GatewayWifiConnector.quote(context.getApplicationInfo().sourceDir)+"; exec /system/bin/app_process /system/bin org.onetwoone.gateway.remote.GatewayFileRootMain manage "+GatewayWifiConnector.quote(request.getCanonicalPath())+" "+server.getLocalPort()+" "+token+" </dev/null >/dev/null 2>&1";process=new ProcessBuilder("su","-c",command).start();JSONObject reply;try(Socket socket=server.accept()){socket.setSoTimeout((int)Math.max(1,deadline-android.os.SystemClock.elapsedRealtime()));reply=GatewayWifiConnector.readRootResult(new DataInputStream(socket.getInputStream()),token);}long remaining=deadline-android.os.SystemClock.elapsedRealtime();if(remaining<=0||!process.waitFor(remaining,TimeUnit.MILLISECONDS)){process.destroy();throw new IOException("file helper timeout");}if(process.exitValue()!=0||!reply.optBoolean("ok"))throw new IOException("file helper rejected");return reply.getJSONObject("result");}
        finally{if(process!=null&&process.isAlive())process.destroy();request.delete();new File(dir,"cancel").delete();dir.delete();}}
    private static JSONObject validate(JSONObject task)throws Exception {if(task==null||task.length()<6||!task.getString("id").matches("[A-Za-z0-9-]{1,96}")||!"file_manage".equals(task.getString("type"))||task.getLong("expires_at")<=0)throw new IOException("invalid task");GatewayFileOperations.normalize(task.getJSONObject("params"));return task;}
    private void cancel(String id)throws Exception {File dir=new File(base,GatewayRemoteStore.hash(id));if(!dir.isDirectory()&&!dir.mkdirs())throw new IOException("task directory unavailable");if(!new File(dir,"cancel").exists()&&!new File(dir,"cancel").createNewFile())throw new IOException("cancel marker unavailable");}
    private static JSONObject failureResult(String action)throws Exception {return new JSONObject().put("stage","file").put("action",action).put("exit_code",1).put("elapsed_ms",0).put("text","").put("truncated",false);}
    private void terminal(String id,String state,String detail,JSONObject result)throws Exception {JSONObject body=progress(id,state,detail,result);receipts().save(body);post(body);clear();changed.run();}
    private JSONObject progress(String id,String state,String detail,JSONObject result)throws Exception {JSONObject body=new JSONObject().put("device_id",store.deviceId()).put("task_id",id).put("state",state).put("detail",detail);if(result!=null)body.put("result",result);return body;}
    private void post(JSONObject body)throws Exception {JSONObject reply=GatewayRemoteHttp.request("/api/elfremote/task-progress",new JSONObject(body.toString()).put("token",store.token())),task=reply.optJSONObject("task");String state=body.getString("state"),id=body.getString("task_id");if(task==null||!id.equals(task.optString("id"))||!(state.equals(task.optString("state"))||("claimed".equals(state)&&"running".equals(task.optString("state")))))throw new IOException("task acknowledgement missing");if(GatewayTaskReceipts.terminal(state))receipts().acknowledge(id);}
    private void clear()throws Exception {if(activeFile.exists()&&!activeFile.delete())throw new IOException("active task cleanup failed");}
    private void clearIfSame(String id)throws Exception {if(!activeFile.exists())return;JSONObject active=GatewayUpdateProgress.read(activeFile);if(id.equals(active.getJSONObject("task").optString("id")))clear();}
    private GatewayTaskReceipts receipts(){return new GatewayTaskReceipts(new File(context.getFilesDir(),"gateway-task-receipts/"+hashDevice(store.deviceId())));}
    private static String hashDevice(String id){try{return GatewayRemoteStore.hash(id);}catch(Exception ignored){return "unpaired";}}
}
