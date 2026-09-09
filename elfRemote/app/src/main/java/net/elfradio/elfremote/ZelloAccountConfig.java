package net.elfradio.elfremote;

import org.json.JSONObject;
import java.io.IOException;

final class ZelloAccountConfig {
    static JSONObject normalize(JSONObject p)throws Exception {
        String user=p.getString("username"),password=p.getString("password");
        if(!user.matches("[A-Za-z0-9_.@+-]{1,128}")||password.isEmpty()||password.length()>256
                ||password.chars().anyMatch(c->c<32||c==127)||!"regular".equals(p.optString("type","regular")))
            throw new IOException("普通Zello账号参数无效");
        return new JSONObject().put("username",user).put("password",password).put("type","regular");
    }
    static boolean authenticated(String fresh){
        return fresh.contains("(LOGIN) Authenticating with a password")&&fresh.contains("(LOGIN) Received a new token")
                &&fresh.contains("(LOGIN) Server returned a buddy list")&&!fresh.contains("(LOGIN) Error:");
    }
    private ZelloAccountConfig(){}
}
