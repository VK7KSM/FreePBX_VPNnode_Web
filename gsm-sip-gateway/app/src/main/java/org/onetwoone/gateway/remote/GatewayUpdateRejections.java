package org.onetwoone.gateway.remote;

import android.content.Context;
import java.io.*;
import org.json.JSONObject;

/** Invalid authenticated offers are acknowledged independently from status reports. */
final class GatewayUpdateRejections {
    private final File root;
    private final GatewayRemoteStore store;
    GatewayUpdateRejections(Context context,GatewayRemoteStore store) throws IOException {
        this.store=store;root=new File(context.getFilesDir(),"gateway-update-rejections");
        if(!root.isDirectory()&&!root.mkdirs())throw new IOException("rejection outbox unavailable");
    }
    boolean enqueue(JSONObject offer,String detail) throws Exception {
        String task=offer.optString("task_id"),device=offer.optString("task_device_id");
        if(!task.matches("update-[a-zA-Z0-9-]{1,80}")||!store.deviceId().equals(device))return false;
        File directory=new File(root,task);if(!directory.isDirectory()&&!directory.mkdir())throw new IOException("rejection task unavailable");
        JSONObject job=new JSONObject().put("device_id",store.deviceId()).put("token",store.token()).put("task_id",task);
        GatewayUpdateProgress progress=new GatewayUpdateProgress(directory,job);
        progress.recordOnce("claimed",detail);progress.recordOnce("rejected",detail);
        return true;
    }
    boolean flush() {
        File[] tasks=root.listFiles(File::isDirectory);if(tasks==null)return true;
        java.util.Arrays.sort(tasks);boolean complete=true;
        for(File directory:tasks)try {
            File marker=new File(directory,"complete.json");if(marker.exists())continue;
            File first=new File(directory,"progress-00001.json");if(!first.isFile()){complete=false;continue;}
            JSONObject body=GatewayUpdateProgress.read(first);
            JSONObject job=new JSONObject().put("device_id",body.getString("device_id")).put("token",store.token())
                    .put("task_id",body.getString("job_id"));
            if(new GatewayUpdateProgress(directory,job).flush())
                GatewayUpdateProgress.write(marker,new JSONObject().put("completed_at",System.currentTimeMillis()));
            else complete=false;
        } catch(Exception unavailable){complete=false;}
        return complete;
    }
}
