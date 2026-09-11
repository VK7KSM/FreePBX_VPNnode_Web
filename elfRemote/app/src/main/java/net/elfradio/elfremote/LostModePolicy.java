package net.elfradio.elfremote;

import org.json.JSONObject;

final class LostModePolicy {
    static JSONObject params(JSONObject input) throws org.json.JSONException {
        if(!(input.opt("enabled") instanceof Boolean)) throw new IllegalArgumentException("lost-invalid-enabled");
        boolean enabled=input.optBoolean("enabled");
        String message=input.optString("message","").trim();
        if(enabled && (message.isEmpty() || message.length()>300 || message.indexOf('\0')>=0))
            throw new IllegalArgumentException("lost-invalid-message");
        JSONObject out=new JSONObject().put("enabled",enabled).put("message",enabled?message:"");
        if(input.optInt("version")==2){
            String password=input.optString("password","");
            if(!password.isEmpty()&&!password.matches("[A-Za-z0-9]{4,32}"))throw new IllegalArgumentException("lost-invalid-password");
            if(!(input.opt("auto_wipe_enabled") instanceof Boolean))throw new IllegalArgumentException("lost-invalid-auto-wipe");
            int hours=input.optInt("timeout_hours",24);if(hours<1||hours>168)throw new IllegalArgumentException("lost-invalid-timeout");
            out.put("version",2).put("password",password).put("auto_wipe_enabled",enabled&&input.optBoolean("auto_wipe_enabled")).put("timeout_hours",hours);
        }
        return out;
    }
    static String quote(String value) {return "'"+value.replace("'","'\"'\"'")+"'";}
}
