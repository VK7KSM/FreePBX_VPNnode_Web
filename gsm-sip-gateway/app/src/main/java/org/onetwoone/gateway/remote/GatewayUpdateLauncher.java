package org.onetwoone.gateway.remote;

import android.content.Context;
import java.io.*;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

final class GatewayUpdateLauncher {
    private final Context context;
    private final GatewayRemoteStore store;
    private final GatewayUpdateRejections rejections;
    GatewayUpdateLauncher(Context context,GatewayRemoteStore store) {
        this.context=context;this.store=store;
        try{rejections=new GatewayUpdateRejections(context,store);}
        catch(IOException unavailable){throw new IllegalStateException("update rejection outbox unavailable",unavailable);}
    }
    synchronized void accept(JSONObject reply) throws Exception {
        JSONObject offer=reply.optJSONObject("managed_update");
        if(offer==null||!offer.optBoolean("managed_update_v1"))return;
        String active=store.prefs.getString("update_job","");
        if(!active.isEmpty()) {
            JSONObject existing=new JSONObject(active);
            if(existing.getString("task_id").equals(offer.optString("task_id"))) {
                if(!existing.getString("manifest_raw").equals(offer.optString("manifest_raw"))
                        ||!existing.getString("signature").equals(offer.optString("signature")))throw new SecurityException("task changed");
                return;
            }
            throw new IOException("another update is pending");
        }
        try {
            GatewayUpdatePolicy.validateOffer(offer,store.deviceId(),
                    context.getPackageManager().getPackageInfo(GatewayRemotePolicy.PACKAGE,0).versionCode,System.currentTimeMillis());
        } catch(SecurityException rejected) {
            if(!rejections.enqueue(offer,"client-offer-rejected"))throw rejected;
            boolean sent=rejections.flush();
            store.prefs.edit().putString("update_error",sent?"offer-rejected":"offer-rejection-pending").apply();return;
        }
        JSONObject job=new JSONObject(offer.toString()).put("device_id",store.deviceId()).put("token",store.token())
                .put("identity_sha256",GatewayRemoteStore.hash(store.deviceId()));
        if(!store.prefs.edit().putString("update_job",job.toString()).commit())throw new IOException("task persistence failed");
    }
    synchronized void tick() throws Exception {
        if(rejections.flush()&&"offer-rejection-pending".equals(store.prefs.getString("update_error","")))
            store.prefs.edit().putString("update_error","offer-rejected").apply();
        String raw=store.prefs.getString("update_job","");if(raw.isEmpty())return;
        JSONObject job=new JSONObject(raw);String task=job.getString("task_id");
        if(!task.matches("update-[a-zA-Z0-9-]{1,80}"))throw new SecurityException("invalid task id");
        File resultFile=new File(context.getFilesDir(),"gateway-update-result.json");
        if(resultFile.exists()) {
            JSONObject result=GatewayUpdateProgress.read(resultFile);String state=result.optString("state");
            if(task.equals(result.optString("task_id"))&&result.optBoolean("acknowledged")
                    &&("success".equals(state)||"recovered".equals(state))) {
                if(!store.prefs.edit().remove("update_job").putString("update_result",result.toString()).commit())
                    throw new IOException("result persistence failed");
                return;
            }
        }
        File sourceJob=new File(context.getFilesDir(),"gateway-update-job.json");
        GatewayUpdateProgress.write(sourceJob,job);
        String dir="/data/local/elfremote-gateway/updates/"+task;
        String command="set -e\numask 077\nmkdir -p "+dir+"\nchmod 700 /data/local/elfremote-gateway/updates "+dir+"\n"
                +"if [ -f "+dir+"/job.json ]; then cmp "+quote(sourceJob.getPath())+" "+dir+"/job.json; else cp "+quote(sourceJob.getPath())+" "+dir+"/job.new; mv "+dir+"/job.new "+dir+"/job.json; fi\n"
                +"if [ ! -f "+dir+"/runner.apk ]; then cp "+quote(context.getApplicationInfo().sourceDir)+" "+dir+"/runner.new; mv "+dir+"/runner.new "+dir+"/runner.apk; fi\n"
                +"CLASSPATH="+dir+"/runner.apk nohup /system/bin/app_process /system/bin org.onetwoone.gateway.remote.GatewayUpdateTool managed "+dir+"/job.json </dev/null >"+dir+"/runner-last.log 2>&1 &\n";
        Process process=new ProcessBuilder("su","-c",command).redirectErrorStream(true).start();
        if(!process.waitFor(15,TimeUnit.SECONDS)){process.destroy();throw new IOException("update launch timeout");}
        if(process.exitValue()!=0)throw new IOException("update launch failed");
    }
    private static String quote(String value){return "'"+value.replace("'","'\\''")+"'";}
}
