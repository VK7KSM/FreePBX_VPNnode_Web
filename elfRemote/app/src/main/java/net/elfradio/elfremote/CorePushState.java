package net.elfradio.elfremote;

import org.json.JSONObject;
import java.io.*;

/** 保存当前连接与尚未交付的通知；只在原子保存成功后确认MQTT消息。 */
final class CorePushState {
    private final File file;
    private JSONObject value;
    CorePushState(File file)throws Exception {this.file=file;value=file.isFile()?new JSONObject(RescueFiles.read(file,16384)):new JSONObject();}
    synchronized JSONObject snapshot()throws Exception{return new JSONObject(value.toString());}
    static String key(JSONObject input){return input.optString("device_id")+":"+input.optString("token");}
    synchronized boolean configure(JSONObject request)throws Exception {
        if(!request.optString("device_id").matches("[A-Za-z0-9_-]{1,128}")||!request.optString("token").matches("[A-Za-z0-9_-]{16,512}")
                ||request.optLong("queued_version",-1)<0)throw new IOException("独立推送身份无效");
        boolean changed=!key(request).equals(key(value));
        JSONObject next=changed?new JSONObject().put("device_id",request.getString("device_id")).put("token",request.getString("token")):snapshot();
        long queued=Math.max(next.optLong("queued_version"),request.getLong("queued_version"));
        next.put("queued_version",queued);
        if(changed&&request.optJSONObject("connection")!=null){validateConnection(request.getJSONObject("connection"));next.put("connection",request.getJSONObject("connection"));}
        if(next.optJSONObject("pending")!=null&&next.getJSONObject("pending").optLong("version")<=queued)next.remove("pending");
        if(!next.toString().equals(value.toString()))commit(next);
        return changed;
    }
    static void validateConnection(JSONObject config)throws Exception {
        String username=config.optString("username");
        if(!config.optBoolean("tls")||!config.optString("host").matches("[a-zA-Z0-9.-]{1,253}")||config.optInt("port")<1||config.optInt("port")>65535
                ||!username.matches("d_[a-f0-9]{64}")||!username.equals(config.optString("client_id"))||!("elfremote/"+username+"/notify").equals(config.optString("topic"))
                ||config.optString("password").length()<16||config.optString("password").length()>512)throw new IOException("独立推送连接配置无效");
    }
    synchronized void connection(String key,JSONObject config)throws Exception {
        if(!key.equals(key(value)))return;
        JSONObject next=snapshot();if(config==null)next.remove("connection");else{validateConnection(config);next.put("connection",config);}commit(next);
    }
    synchronized boolean notice(String key,JSONObject notice,long now)throws Exception {
        if(!key.equals(key(value))||!PushPolicy.shouldQueue(notice,value.optLong("queued_version"),now))return false;
        JSONObject existing=value.optJSONObject("pending");
        if(existing!=null&&existing.optLong("version")>=notice.getLong("version"))return false;
        JSONObject next=snapshot();next.put("pending",notice);commit(next);return true;
    }
    synchronized JSONObject pending(long now)throws Exception {
        JSONObject notice=value.optJSONObject("pending");return PushPolicy.shouldQueue(notice,value.optLong("queued_version"),now)?new JSONObject(notice.toString()):null;
    }
    synchronized void clear()throws Exception {commit(new JSONObject());}
    private void commit(JSONObject next)throws Exception {RescueFiles.write(file,next.toString());value=next;}
}
