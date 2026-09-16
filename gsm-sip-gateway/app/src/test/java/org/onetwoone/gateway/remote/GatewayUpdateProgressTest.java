package org.onetwoone.gateway.remote;

import java.io.File;
import java.util.*;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.Rule;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE,sdk=28)
public class GatewayUpdateProgressTest {
    @Rule public TemporaryFolder temporary=new TemporaryFolder();
    private JSONObject job() throws Exception{return new JSONObject().put("device_id","test").put("token","test-token").put("task_id","update-test");}
    @Test public void rejectsHttpSuccessWithWrongTaskOrState() throws Exception {
        File dir=temporary.newFolder();
        GatewayUpdateProgress progress=new GatewayUpdateProgress(dir,job(),body->new JSONObject().put("ok",true)
                .put("update",new JSONObject().put("job_id","wrong").put("state","claimed")));
        progress.record("claimed");assertFalse(progress.flush());
        assertFalse(new File(dir,"progress-00001.json.ack").exists());
        progress=new GatewayUpdateProgress(dir,job(),body->new JSONObject().put("ok",true)
                .put("update",new JSONObject().put("job_id","update-test").put("state","pending")));
        assertFalse(progress.flush());
    }
    @Test public void resumesInOrderAndDoesNotReplayAcknowledgedEntries() throws Exception {
        File dir=temporary.newFolder();List<String> sent=new ArrayList<>();
        GatewayUpdateProgress progress=new GatewayUpdateProgress(dir,job(),body->{
            sent.add(body.getString("state"));
            if("downloading".equals(body.getString("state")))throw new java.io.IOException("offline");
            return new JSONObject().put("update",body);
        });
        progress.recordOnce("claimed");progress.recordOnce("downloading");assertFalse(progress.flush());
        progress=new GatewayUpdateProgress(dir,job(),body->{sent.add(body.getString("state"));return new JSONObject().put("update",body);});
        progress.recordOnce("claimed");progress.recordOnce("verifying");assertTrue(progress.flush());
        assertEquals(Arrays.asList("claimed","downloading","downloading","verifying"),sent);
        assertTrue(progress.flush());assertEquals(4,sent.size());
    }
    @Test public void persistsBoundedDetailWithoutDuplicatingStates() throws Exception {
        File dir=temporary.newFolder();StringBuilder longDetail=new StringBuilder();
        for(int i=0;i<250;i++)longDetail.append('x');
        GatewayUpdateProgress progress=new GatewayUpdateProgress(dir,job(),body->new JSONObject().put("update",body));
        progress.recordOnce("claimed",longDetail.toString());progress.recordOnce("claimed","different");
        progress.recordOnce("rejected","bad-signature");
        assertEquals(200,GatewayUpdateProgress.read(new File(dir,"progress-00001.json")).getString("detail").length());
        assertEquals("rejected",GatewayUpdateProgress.read(new File(dir,"progress-00002.json")).getString("state"));
        assertFalse(new File(dir,"progress-00003.json").exists());
    }
}
