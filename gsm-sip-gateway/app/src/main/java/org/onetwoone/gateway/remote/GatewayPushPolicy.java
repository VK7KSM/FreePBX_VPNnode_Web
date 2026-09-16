package org.onetwoone.gateway.remote;

import org.json.JSONObject;

final class GatewayPushPolicy {
    static boolean notice(JSONObject value,long queued,long now) {
        if(value==null||!"status_request".equals(value.optString("type"))
                ||!value.optString("request_id").matches("[A-Za-z0-9-]{1,96}"))return false;
        Object version=value.opt("version"),expires=value.opt("expires_at_ms");
        if(!(version instanceof Number)||!(expires instanceof Number))return false;
        long v=((Number)version).longValue(),end=((Number)expires).longValue();
        return ((Number)version).doubleValue()==v&&((Number)expires).doubleValue()==end
                &&v>queued&&v>0&&end>now&&end-now<=600000;
    }
    static void connection(JSONObject value) throws Exception {
        String username=value.optString("username");
        if(!value.optBoolean("tls")||!value.optString("host").matches("[a-zA-Z0-9.-]{1,253}")
                ||value.optInt("port")<1||value.optInt("port")>65535||!username.matches("d_[a-f0-9]{64}")
                ||!username.equals(value.optString("client_id"))||!("elfremote/"+username+"/notify").equals(value.optString("topic"))
                ||value.optString("password").length()<16||value.optString("password").length()>512)
            throw new java.io.IOException("invalid push connection");
    }
    static long retry(int failures){return Math.min(300000L,5000L<<Math.min(6,Math.max(0,failures)));}
    private GatewayPushPolicy(){}
}
