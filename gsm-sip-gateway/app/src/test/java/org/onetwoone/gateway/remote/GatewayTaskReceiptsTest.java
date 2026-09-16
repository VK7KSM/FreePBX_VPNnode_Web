package org.onetwoone.gateway.remote;

import java.io.File;
import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE,sdk=28)
public class GatewayTaskReceiptsTest {
    @Rule public TemporaryFolder temporary=new TemporaryFolder();
    @Test public void persistsCompactsAndRejectsConflictingTerminalResult() throws Exception {
        File directory=temporary.newFolder();GatewayTaskReceipts receipts=new GatewayTaskReceipts(directory);
        JSONObject value=new JSONObject().put("task_id","sip-test").put("state","success")
                .put("detail","done").put("result",new JSONObject().put("applied",true));
        receipts.save(value);assertEquals("done",receipts.read("sip-test").getString("detail"));
        try{receipts.save(new JSONObject(value.toString()).put("detail","different"));fail();}catch(Exception expected){}
        receipts.acknowledge("sip-test");JSONObject compact=receipts.read("sip-test");
        assertTrue(compact.getBoolean("acknowledged"));assertFalse(compact.has("detail"));
    }
    @Test public void refusesSecretsAndNonTerminalStates() throws Exception {
        GatewayTaskReceipts receipts=new GatewayTaskReceipts(temporary.newFolder());
        try{receipts.save(new JSONObject().put("task_id","x").put("state","running"));fail();}catch(Exception expected){}
        try{receipts.save(new JSONObject().put("task_id","x").put("state","failed").put("token","secret"));fail();}catch(Exception expected){}
    }
}
