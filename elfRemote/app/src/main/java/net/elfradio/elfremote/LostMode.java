package net.elfradio.elfremote;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

final class LostMode {
    private final SharedPreferences state;
    private final File request;
    private final String apk;
    LostMode(Context context) {
        state=context.getSharedPreferences("lost-mode",Context.MODE_PRIVATE);
        request=new File(context.getFilesDir(),"owner-info-request.json");
        apk=context.getApplicationInfo().sourceDir;
    }
    synchronized JSONObject set(JSONObject input) throws Exception {
        JSONObject params=LostModePolicy.params(input);
        if(params.getBoolean("enabled") && !state.contains("original")) {
            JSONObject before=owner(null);
            if(!state.edit().putString("original",before.toString()).commit()) throw new IOException("lost-backup-failed");
        }
        if(!state.edit().putBoolean("enabled",params.getBoolean("enabled")).putString("message",params.getString("message"))
                .putString("state","pending").commit()) throw new IOException("lost-state-failed");
        reconcile();
        return snapshot();
    }
    synchronized void recover() {
        if(!state.contains("original")) return;
        try {reconcile();}catch(Exception error){RuntimeLog.event("lost_recovery_pending");}
    }
    private void reconcile() throws Exception {
        boolean active=state.getBoolean("enabled",false);
        JSONObject desired=active?new JSONObject().put("enabled",true).put("message",state.getString("message",""))
                :state.contains("original")?new JSONObject(state.getString("original","")):null;
        try {
            if(desired!=null) {
                JSONObject actual=owner(desired);
                if(actual.getBoolean("enabled")!=desired.getBoolean("enabled") || !actual.getString("message").equals(desired.getString("message")))
                    throw new IOException("lost-verify-failed");
            }
            SharedPreferences.Editor edit=state.edit().putString("state",active?"enabled":"disabled");
            if(!active) edit.remove("original");
            if(!edit.commit()) throw new IOException("lost-state-failed");
            RuntimeLog.event("lost_mode_state="+(active?"enabled":"disabled"));
        } catch(Exception error) {state.edit().putString("state","pending").commit();throw error;}
    }
    synchronized JSONObject snapshot() throws org.json.JSONException {
        return new JSONObject().put("enabled",state.getBoolean("enabled",false)).put("message",state.getString("message",""))
                .put("state",state.getString("state","disabled"));
    }
    private JSONObject owner(JSONObject value) throws Exception {
        File response=new File(request.getParentFile(),"owner-info-response.json");
        try {
            if(value!=null) try(FileOutputStream out=new FileOutputStream(request)) {
                out.write(value.toString().getBytes(StandardCharsets.UTF_8));out.getFD().sync();
            }
            String cmd="CLASSPATH="+LostModePolicy.quote(apk)+" app_process /system/bin net.elfradio.elfremote.OwnerInfoMain "
                    +(value==null?"read":"write "+LostModePolicy.quote(request.getAbsolutePath()));
            Process process=new ProcessBuilder("su","-c",cmd).redirectOutput(response).start();
            if(!process.waitFor(8,TimeUnit.SECONDS)) {process.destroy();throw new IOException("lost-owner-timeout");}
            if(process.exitValue()!=0) throw new IOException("lost-owner-unavailable");
            ByteArrayOutputStream bytes=new ByteArrayOutputStream();
            byte[] buffer=new byte[2048];int count;
            try(InputStream in=new FileInputStream(response)) {while((count=in.read(buffer))!=-1) {bytes.write(buffer,0,count);if(bytes.size()>65536) throw new IOException("lost-owner-too-large");}}
            return new JSONObject(new String(bytes.toByteArray(),StandardCharsets.UTF_8));
        } finally {
            if(request.exists()&&!request.delete()) RuntimeLog.event("lost_request_cleanup_pending");
            if(response.exists()&&!response.delete()) RuntimeLog.event("lost_response_cleanup_pending");
        }
    }
}
