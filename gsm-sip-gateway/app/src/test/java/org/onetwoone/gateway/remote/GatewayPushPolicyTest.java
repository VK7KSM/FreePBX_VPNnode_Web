package org.onetwoone.gateway.remote;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE,sdk=28)
public class GatewayPushPolicyTest {
    @Test public void acceptsOnlyFreshMonotonicStatusNotices() throws Exception {
        long now=100000;
        JSONObject notice=new JSONObject().put("type","status_request").put("request_id","request-1")
                .put("version",2).put("expires_at_ms",now+60000);
        assertTrue(GatewayPushPolicy.notice(notice,1,now));assertFalse(GatewayPushPolicy.notice(notice,2,now));
        assertFalse(GatewayPushPolicy.notice(new JSONObject(notice.toString()).put("type","command"),1,now));
        assertFalse(GatewayPushPolicy.notice(new JSONObject(notice.toString()).put("expires_at_ms",now+600001),1,now));
    }
    @Test public void validatesBoundTlsConnection() throws Exception {
        String user="d_"+new String(new char[64]).replace('\0','a');
        JSONObject config=new JSONObject().put("tls",true).put("host","mqtt.example.test").put("port",8883)
                .put("username",user).put("client_id",user).put("topic","elfremote/"+user+"/notify").put("password","0123456789abcdef");
        GatewayPushPolicy.connection(config);
        try{GatewayPushPolicy.connection(new JSONObject(config.toString()).put("topic","other"));fail();}catch(java.io.IOException expected){}
    }
}
