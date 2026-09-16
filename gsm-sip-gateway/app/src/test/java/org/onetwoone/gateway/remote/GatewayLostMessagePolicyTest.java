package org.onetwoone.gateway.remote;

import java.io.IOException;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE,sdk=28)
public class GatewayLostMessagePolicyTest {
    @Test public void acceptsExactShowAndClearContracts()throws Exception {long now=System.currentTimeMillis();JSONObject show=GatewayLostMessagePolicy.offer(task("show_lost_message",new JSONObject().put("message","  请联系管理员  "),now),now);assertEquals("请联系管理员",show.getJSONObject("params").getString("message"));
        JSONObject clear=GatewayLostMessagePolicy.offer(task("clear_lost_message",new JSONObject(),now),now);assertEquals(0,clear.getJSONObject("params").length());
        assertEquals("{\"action\":\"displayed\",\"verified\":true}",GatewayLostMessagePolicy.result("displayed").toString());}
    @Test public void rejectsUnknownFieldsMissingIdentityAndInvalidText()throws Exception {long now=System.currentTimeMillis();rejected(task("show_lost_message",new JSONObject().put("message","x").put("extra",1),now),now);rejected(task("clear_lost_message",new JSONObject().put("extra",1),now),now);
        JSONObject missing=task("show_lost_message",new JSONObject().put("message","x"),now);missing.remove("idempotency_key");rejected(missing,now);rejected(task("show_lost_message",new JSONObject().put("message","\u0000bad"),now),now);}
    private static JSONObject task(String type,JSONObject params,long now)throws Exception{return new JSONObject().put("id","lost-1").put("idempotency_key","lost-key-1").put("type",type).put("expires_at",now+60000).put("params",params);}
    private static void rejected(JSONObject value,long now)throws Exception{try{GatewayLostMessagePolicy.offer(value,now);fail();}catch(IOException expected){}}
}
