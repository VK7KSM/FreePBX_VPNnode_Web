package net.elfradio.elfremote;

import org.json.JSONObject;

final class LostModePolicy {
    static JSONObject params(JSONObject input) throws org.json.JSONException {
        if(!(input.opt("enabled") instanceof Boolean)) throw new IllegalArgumentException("lost-invalid-enabled");
        boolean enabled=input.optBoolean("enabled");
        String message=input.optString("message","").trim();
        if(enabled && (message.isEmpty() || message.length()>300 || message.indexOf('\0')>=0))
            throw new IllegalArgumentException("lost-invalid-message");
        return new JSONObject().put("enabled",enabled).put("message",enabled?message:"");
    }
    static String quote(String value) {return "'"+value.replace("'","'\"'\"'")+"'";}
}
