package org.onetwoone.gateway.remote;

import android.content.Context;
import java.io.*;
import org.json.JSONObject;

/** Root-private, frozen runner owns the transaction across package replacement. */
final class GatewayManagedUpdate {
    static void run(Context context,File input) throws Exception {
        File jobFile=input.getCanonicalFile(), directory=jobFile.getParentFile();
        if(!"job.json".equals(jobFile.getName())||!directory.getName().matches("update-[a-zA-Z0-9-]{1,80}")
                ||!directory.getParent().equals("/data/local/elfremote-gateway/updates")||jobFile.length()>131072)
            throw new SecurityException("invalid managed job path");
        try(RandomAccessFile handle=new RandomAccessFile(new File(directory.getParentFile(),"transaction.lock"),"rw");
            java.nio.channels.FileLock lock=handle.getChannel().tryLock()) {
            if(lock==null)return;
            JSONObject job=GatewayUpdateProgress.read(jobFile);
            if(!directory.getName().equals(job.getString("task_id")))throw new SecurityException("task path mismatch");
            GatewayUpdateProgress progress=new GatewayUpdateProgress(directory,job);
            File journalFile=new File(directory,"transaction.json"), admissionFile=new File(directory,"admission.json");
            JSONObject journal=journalFile.exists()?GatewayUpdateProgress.read(journalFile):null;
            String state=journal==null?"":journal.optString("state");
            boolean started="installing".equals(state)||"wait_health".equals(state)||"rollback".equals(state)
                    ||"success".equals(state)||"recovered".equals(state);
            int installed=context.getPackageManager().getPackageInfo(GatewayRemotePolicy.PACKAGE,0).versionCode;
            long now=System.currentTimeMillis();
            JSONObject admission=admissionFile.exists()?GatewayUpdateProgress.read(admissionFile):null;
            // Expiry blocks new installs, but must not strand an already-started recovery.
            JSONObject manifest=GatewayUpdatePolicy.validateOffer(job,job.getString("device_id"),
                    started?admission.getInt("version"):installed,started?admission.getLong("at"):now);
            if(started&&(!job.getString("task_id").equals(journal.optString("task"))
                    ||!manifest.getString("sha256").equals(journal.optString("target"))))throw new SecurityException("resume mismatch");
            if(admission==null) {
                admission=new JSONObject().put("version",installed).put("at",now);
                GatewayUpdateProgress.write(admissionFile,admission);
            }
            progress.recordOnce("claimed");progress.flush();
            File target=new File(directory,"target.apk");
            if(!started) {
                progress.recordOnce("downloading");progress.flush();
                GatewayArtifactDownload.download(manifest,target);
                progress.recordOnce("verifying");progress.flush();
            }
            GatewayApkVerifier.matches(GatewayApkVerifier.inspect(context.getPackageManager(),target),manifest);
            if(!started)GatewayUpdatePolicy.validateOffer(job,job.getString("device_id"),installed,System.currentTimeMillis());
            String identity=job.getString("identity_sha256");
            GatewayAndroidUpdate platform=new GatewayAndroidUpdate(context,target,directory,identity,false);
            platform.progress=progress;
            String result=GatewayUpdateTransaction.run(platform,job.getString("task_id"),manifest.getString("sha256"));
            // Re-create a terminal outbox entry if death occurred between journal and outbox writes.
            if("success".equals(result)||"recovered".equals(result)) {
                if("recovered".equals(result))progress.recordOnce("rollback");
                else progress.recordOnce("wait_health");
                progress.recordOnce(result);
            }
            boolean acknowledged=progress.flush();
            File mirror=new File(context.getPackageManager().getApplicationInfo(GatewayRemotePolicy.PACKAGE,0).dataDir,
                    "files/gateway-update-result.json");
            GatewayUpdateProgress.write(mirror,new JSONObject().put("task_id",job.getString("task_id"))
                    .put("state",result).put("acknowledged",acknowledged));
            int uid=context.getPackageManager().getApplicationInfo(GatewayRemotePolicy.PACKAGE,0).uid;
            android.system.Os.chown(mirror.getPath(),uid,uid);android.system.Os.chmod(mirror.getPath(),0600);
        }
    }
    private GatewayManagedUpdate(){}
}
