package org.onetwoone.gateway.remote;

import java.io.IOException;
import org.json.JSONObject;

/** Strict Pixel-only contract for reversible lost-message tasks. */
final class GatewayLostMessagePolicy {
    static JSONObject offer(JSONObject value,long now)throws Exception {
        if(value==null)throw new IOException("missing lost message task");
        String type=value.optString("type"),id=value.optString("id"),key=value.optString("idempotency_key");long expires=value.optLong("expires_at");
        if(!"show_lost_message".equals(type)&&!"clear_lost_message".equals(type))throw new IOException("unsupported lost message task");
        if(!id.matches("[A-Za-z0-9-]{1,96}")||key.isEmpty()||key.length()>128)throw new IOException("invalid task identity");
        if(expires<=now||expires>now+86_400_000L)throw new IOException("invalid task expiry");
        JSONObject params=value.optJSONObject("params");if(params==null)throw new IOException("missing lost message parameters");
        JSONObject normalized=new JSONObject(value.toString());normalized.put("params","show_lost_message".equals(type)?show(params):clear(params));return normalized;
    }
    static JSONObject show(JSONObject value)throws Exception {
        if(value.length()!=1||!value.has("message")||!(value.opt("message") instanceof String))throw new IOException("invalid lost message parameters");
        return new JSONObject().put("message",GatewayLostDisplay.normalize((String)value.opt("message")));
    }
    static JSONObject clear(JSONObject value)throws Exception {if(value.length()!=0)throw new IOException("invalid lost message parameters");return new JSONObject();}
    static JSONObject result(String action)throws Exception {if(!"displayed".equals(action)&&!"cleared".equals(action))throw new IOException("invalid lost result");return new JSONObject().put("action",action).put("verified",true);}
    private GatewayLostMessagePolicy(){}
}
