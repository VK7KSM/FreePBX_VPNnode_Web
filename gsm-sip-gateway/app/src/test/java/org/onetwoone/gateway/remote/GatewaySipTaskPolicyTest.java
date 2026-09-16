package org.onetwoone.gateway.remote;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE,sdk=28)
public class GatewaySipTaskPolicyTest {
    private JSONObject params() throws Exception {
        return new JSONObject().put("target","gateway").put("account_id","primary").put("server","SIP.Example.com")
                .put("username","300").put("transport","tls").put("port",5061).put("realm","*").put("keep_password",true);
    }
    @Test public void acceptsBoundedGatewayNoOpOffer() throws Exception {
        long now=1_800_000_000_000L;
        JSONObject offer=new JSONObject().put("id","sip-test").put("idempotency_key","key-1")
                .put("type","configure_sip").put("expires_at",now+60000).put("params",params());
        JSONObject normalized=GatewaySipTaskPolicy.offer(offer,now).getJSONObject("params");
        assertEquals("sip.example.com",normalized.getString("server"));assertTrue(normalized.getBoolean("keep_password"));
        assertEquals("",normalized.getString("password"));
    }
    @Test public void rejectsTcpWrongTargetExpiredAndAmbiguousPassword() throws Exception {
        JSONObject p=params().put("transport","tcp");expectInvalid(p);
        expectInvalid(params().put("target","linphone"));
        expectInvalid(params().put("password","secret"));
        long now=1_800_000_000_000L;
        try{GatewaySipTaskPolicy.offer(new JSONObject().put("id","sip-test").put("idempotency_key","key")
                .put("type","configure_sip").put("expires_at",now).put("params",params()),now);fail();}catch(Exception expected){}
    }
    @Test public void requiresPasswordWhenNotPreservingIt() throws Exception {
        expectInvalid(params().put("keep_password",false));
        JSONObject normalized=GatewaySipTaskPolicy.params(params().put("keep_password",false).put("password","new-secret"));
        assertEquals("new-secret",normalized.getString("password"));
    }
    @Test public void equalityAndPublicResultNeverExposePassword() throws Exception {
        JSONObject before=new JSONObject().put("server","sip.example.com").put("username","300").put("password","secret")
                .put("realm","*").put("transport","tls").put("port",5061);
        assertTrue(GatewaySipTaskPolicy.same(before,new JSONObject(before.toString())));
        assertFalse(GatewaySipTaskPolicy.same(before,new JSONObject(before.toString()).put("port",5060)));
        assertFalse(GatewaySipTaskPolicy.publicResult("sip-test",true,true,"completed",0,false).toString().contains("secret"));
    }
    private static void expectInvalid(JSONObject p)throws Exception {try{GatewaySipTaskPolicy.params(p);fail();}catch(Exception expected){}}
}
