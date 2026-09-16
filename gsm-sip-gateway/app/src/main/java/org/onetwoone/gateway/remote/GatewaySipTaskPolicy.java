package org.onetwoone.gateway.remote;

import java.io.IOException;
import java.util.Arrays;
import java.util.Locale;
import org.json.JSONObject;

/** Strict policy for the shared configure_sip task contract. */
final class GatewaySipTaskPolicy {
    static JSONObject offer(JSONObject value,long now) throws Exception {
        if(value==null||!"configure_sip".equals(value.optString("type")))throw new IOException("unsupported task");
        String id=value.optString("id"),key=value.optString("idempotency_key");
        long expires=value.optLong("expires_at");
        if(!id.matches("[A-Za-z0-9-]{1,96}")||key.isEmpty()||key.length()>128)throw new IOException("invalid task identity");
        if(expires<=now||expires>now+86_400_000L)throw new IOException("invalid task expiry");
        JSONObject normalized=new JSONObject(value.toString());
        normalized.put("params",params(value.getJSONObject("params")));
        return normalized;
    }

    static JSONObject params(JSONObject value) throws Exception {
        if(!"gateway".equals(value.optString("target"))||!"primary".equals(value.optString("account_id")))
            throw new IOException("invalid gateway target");
        String server=value.optString("server").toLowerCase(Locale.US),user=value.optString("username");
        String transport=value.optString("transport","tls").toLowerCase(Locale.US);
        String realm=value.has("realm")?value.optString("realm"):"*";
        boolean keep=value.optBoolean("keep_password",false);String password=value.optString("password");
        int port=value.optInt("port","tls".equals(transport)?5061:5060);
        if(!server.matches("[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?")||server.contains("..")
                ||!user.matches("[A-Za-z0-9_.+-]{1,128}")||!Arrays.asList("tls","udp").contains(transport)
                ||port<1||port>65535||realm.length()>253||realm.indexOf('\0')>=0||realm.chars().anyMatch(c->c<32||c==127)
                ||(keep&&!password.isEmpty())||(!keep&&(password.isEmpty()||password.length()>256||!password.equals(password.trim())
                ||password.chars().anyMatch(c->c<32||c==127))))throw new IOException("invalid SIP parameters");
        return new JSONObject().put("target","gateway").put("account_id","primary").put("server",server)
                .put("username",user).put("transport",transport).put("port",port).put("realm",realm)
                .put("keep_password",keep).put("password",password);
    }

    static boolean same(JSONObject before,JSONObject desired) {
        for(String key:new String[]{"server","username","password","realm","transport"})
            if(!before.optString(key).equals(desired.optString(key)))return false;
        return before.optInt("port") == desired.optInt("port");
    }

    static JSONObject publicResult(String taskId,boolean applied,boolean registered,String action,int exitCode,boolean rolledBack) throws Exception {
        return new JSONObject().put("target","gateway").put("account_id","primary").put("config_task_id",taskId)
                .put("applied",applied).put("registered",registered).put("action",action).put("exit_code",exitCode)
                .put("rolled_back",rolledBack);
    }

    private GatewaySipTaskPolicy() {}
}
