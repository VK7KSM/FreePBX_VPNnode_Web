package org.onetwoone.gateway.remote;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE,sdk=31)
public class GatewayExecRootMainTest {
    @Test public void acceptsBoundedCommandContract()throws Exception{
        JSONObject normalized=GatewayExecRootMain.normalize(new JSONObject().put("command","id").put("cwd","/").put("timeout",30));
        assertEquals("id",normalized.getString("command"));assertEquals(30,normalized.getInt("timeout"));
    }
    @Test public void rejectsMissingExtraAndUnsafeFields()throws Exception{
        invalid(new JSONObject().put("command","id").put("cwd","relative").put("timeout",30));
        invalid(new JSONObject().put("command","id").put("cwd","/").put("timeout",121));
        invalid(new JSONObject().put("command","id\0whoami").put("cwd","/").put("timeout",30));
        invalid(new JSONObject().put("command","id").put("cwd","/").put("timeout",30).put("extra",true));
    }
    private static void invalid(JSONObject value)throws Exception{try{GatewayExecRootMain.normalize(value);fail();}catch(Exception expected){}}
}
