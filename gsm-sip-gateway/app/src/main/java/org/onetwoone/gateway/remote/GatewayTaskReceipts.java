package org.onetwoone.gateway.remote;

import android.util.AtomicFile;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** D22-compatible terminal task receipts with explicit server acknowledgment. */
final class GatewayTaskReceipts {
    private final File directory;
    GatewayTaskReceipts(File directory){this.directory=directory;}
    static boolean terminal(String state){return "success".equals(state)||"failed".equals(state)||"rejected".equals(state)||"expired".equals(state);}
    private File target(String id)throws Exception {
        if(id==null||id.isEmpty()||id.length()>128)throw new IOException("invalid task id");
        return new File(directory,GatewayRemoteStore.hash(id)+".json");
    }
    synchronized JSONObject read(String id)throws Exception {
        File file=target(id),ack=new File(file.getPath()+".ack");if(ack.exists())file=ack;
        if(!file.exists())return null;if(file.length()>65536)throw new IOException("task receipt too large");
        JSONObject value=GatewayUpdateProgress.read(file);
        if(!id.equals(value.optString("task_id"))||!terminal(value.optString("state"))||value.has("token"))throw new IOException("invalid task receipt");
        return value;
    }
    synchronized void save(JSONObject value)throws Exception {
        if(value.has("token")||!terminal(value.optString("state")))throw new IOException("invalid task receipt");
        String id=value.getString("task_id");JSONObject old=read(id);
        if(old!=null){if(!old.toString().equals(value.toString()))throw new IOException("task result already committed");return;}
        if(!directory.isDirectory()&&!directory.mkdirs())throw new IOException("task receipt storage unavailable");
        GatewayUpdateProgress.write(target(id),value);
    }
    synchronized void acknowledge(String id)throws Exception {
        JSONObject value=read(id);if(value==null)throw new IOException("task receipt missing");
        File full=target(id),ack=new File(full.getPath()+".ack");
        if(!value.optBoolean("acknowledged"))GatewayUpdateProgress.write(ack,new JSONObject().put("task_id",id)
                .put("state",value.getString("state")).put("acknowledged",true));
        if(full.exists()&&!full.delete())throw new IOException("task receipt cleanup failed");
    }
}
