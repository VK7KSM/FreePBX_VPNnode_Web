package org.onetwoone.gateway.remote;

import android.util.AtomicFile;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import org.json.JSONObject;

/** Keep ordered progress until the server acknowledges each exact task and state. */
final class GatewayUpdateProgress {
    private final File directory;
    private final JSONObject job;
    interface Sender {JSONObject send(JSONObject body) throws Exception;}
    private final Sender sender;
    GatewayUpdateProgress(File directory,JSONObject job){this(directory,job,body->GatewayRemoteHttp.request("/api/elfremote/update-progress",body));}
    GatewayUpdateProgress(File directory,JSONObject job,Sender sender){this.directory=directory;this.job=job;this.sender=sender;}
    void recordOnce(String state) throws Exception {
        for(File entry:entries())if(state.equals(read(entry).optString("state")))return;
        record(state);
    }
    void recordOnce(String state,String detail) throws Exception {
        for(File entry:entries())if(state.equals(read(entry).optString("state")))return;
        record(state,detail);
    }
    void record(String state) throws Exception {record(state,"");}
    void record(String state,String detail) throws Exception {
        File[] entries=entries();
        if(entries.length>0 && state.equals(read(entries[entries.length-1]).optString("state")))return;
        if(detail==null)detail="";if(detail.length()>200)detail=detail.substring(0,200);
        JSONObject body=new JSONObject().put("device_id",job.getString("device_id")).put("token",job.getString("token"))
                .put("job_id",job.getString("task_id")).put("state",state).put("detail",detail);
        write(new File(directory,String.format(java.util.Locale.ROOT,"progress-%05d.json",entries.length+1)),body);
    }
    boolean flush() {
        try {
            for(File file:entries()) {
                File acknowledged=new File(file.getPath()+".ack");if(acknowledged.exists())continue;
                JSONObject body=read(file);
                JSONObject reply=sender.send(body);
                JSONObject update=reply.optJSONObject("update");
                if(update==null||!body.getString("job_id").equals(update.optString("job_id"))||!body.getString("state").equals(update.optString("state")))return false;
                write(acknowledged,new JSONObject().put("ok",true));
            }
            return true;
        } catch(Exception unavailable){return false;}
    }
    private File[] entries() {
        File[] files=directory.listFiles((dir,name)->name.matches("progress-[0-9]{5}\\.json"));
        if(files==null)return new File[0];Arrays.sort(files);return files;
    }
    static JSONObject read(File file) throws Exception {return new JSONObject(new String(new AtomicFile(file).readFully(),StandardCharsets.UTF_8));}
    static void write(File file,JSONObject value) throws Exception {
        AtomicFile atomic=new AtomicFile(file);FileOutputStream out=atomic.startWrite();
        try{out.write(value.toString().getBytes(StandardCharsets.UTF_8));atomic.finishWrite(out);}
        catch(Exception error){atomic.failWrite(out);throw error;}
    }
}
