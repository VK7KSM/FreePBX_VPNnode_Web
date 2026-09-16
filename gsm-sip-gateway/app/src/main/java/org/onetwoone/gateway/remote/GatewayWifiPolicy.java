package org.onetwoone.gateway.remote;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** Strict policy for the shared scan_wifi and connect_wifi contracts. */
final class GatewayWifiPolicy {
    static JSONObject offer(JSONObject value,long now) throws Exception {
        if(value==null)throw new IOException("missing Wi-Fi task");
        String type=value.optString("type"),id=value.optString("id"),key=value.optString("idempotency_key");
        long expires=value.optLong("expires_at");
        if(!"scan_wifi".equals(type)&&!"connect_wifi".equals(type))throw new IOException("unsupported Wi-Fi task");
        if(!id.matches("[A-Za-z0-9-]{1,96}")||key.isEmpty()||key.length()>128)throw new IOException("invalid task identity");
        if(expires<=now||expires>now+86_400_000L)throw new IOException("invalid task expiry");
        JSONObject params=value.optJSONObject("params");if(params==null)params=new JSONObject();
        JSONObject normalized=new JSONObject(value.toString());
        normalized.put("params","scan_wifi".equals(type)?scanParams(params):connectParams(params));
        return normalized;
    }

    static JSONObject scanParams(JSONObject value) throws Exception {
        if(value.length()!=0)throw new IOException("invalid Wi-Fi scan parameters");
        return new JSONObject();
    }

    static JSONObject connectParams(JSONObject value) throws Exception {
        if(value.length()!=2||!value.has("ssid")||!value.has("password"))throw new IOException("invalid Wi-Fi parameters");
        Object rawSsid=value.opt("ssid"),rawPassword=value.opt("password");
        if(!(rawSsid instanceof String)||!(rawPassword instanceof String))throw new IOException("invalid Wi-Fi parameters");
        String ssid=(String)rawSsid,password=(String)rawPassword;
        int bytes=ssid.getBytes(StandardCharsets.UTF_8).length;
        if(bytes<1||bytes>32||ssid.indexOf('\0')>=0)throw new IOException("invalid Wi-Fi SSID");
        if(!password.isEmpty()&&!password.matches("[0-9a-fA-F]{64}")
                &&(password.length()<8||password.length()>63||!password.matches("[\\x20-\\x7e]+")))
            throw new IOException("invalid Wi-Fi password");
        return new JSONObject().put("ssid",ssid).put("password",password);
    }

    static String quoteWifi(String value){return "\""+value.replace("\\","\\\\").replace("\"","\\\"")+"\"";}
    private GatewayWifiPolicy() {}
}
