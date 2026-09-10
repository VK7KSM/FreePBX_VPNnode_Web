package net.elfradio.elfremote;
import org.junit.*;import org.junit.rules.TemporaryFolder;import static org.junit.Assert.*;import org.json.JSONObject;import java.io.File;
public class CorePushStateTest {
    @Rule public TemporaryFolder temp=new TemporaryFolder();
    JSONObject identity(String token,long queued)throws Exception{return new JSONObject().put("device_id","fixture").put("token",token).put("queued_version",queued);}
    JSONObject notice(long version)throws Exception{return new JSONObject().put("type","status_request").put("request_id","request-"+version).put("version",version).put("expires_at_ms",5000);}
    @Test public void persistsPendingBeforeAckAndDoesNotReplayAfterAppQueue()throws Exception {
        File path=new File(temp.getRoot(),"state.json");CorePushState state=new CorePushState(path);JSONObject id=identity("token_fixture_123456",0);state.configure(id);
        assertTrue(state.notice(CorePushState.key(id),notice(2),1000));state=new CorePushState(path);assertEquals(2,state.pending(1000).getLong("version"));
        assertFalse(state.notice(CorePushState.key(id),notice(1),1000));assertNull(state.pending(5000));
        state.configure(identity("token_fixture_123456",2));assertNull(state.pending(1000));assertFalse(new CorePushState(path).notice(CorePushState.key(id),notice(2),1000));
    }
    @Test public void credentialChangeDropsOldPendingAndRejectsOldCallback()throws Exception {
        CorePushState state=new CorePushState(new File(temp.getRoot(),"state.json"));JSONObject old=identity("token_fixture_123456",0);state.configure(old);state.notice(CorePushState.key(old),notice(2),1000);
        assertTrue(state.configure(identity("replacement_12345678",0)));assertNull(state.pending(1000));assertFalse(state.notice(CorePushState.key(old),notice(3),1000));
        assertThrows(Exception.class,()->state.configure(identity("short",0)));
    }
    @Test public void failedPersistenceNeverAcknowledgesAnUnstoredNotice()throws Exception {
        File folder=temp.newFolder(),path=new File(folder,"state.json");CorePushState state=new CorePushState(path);JSONObject id=identity("token_fixture_123456",0);state.configure(id);
        assertTrue(new File(path.getPath()+".tmp").mkdir());assertThrows(Exception.class,()->state.notice(CorePushState.key(id),notice(1),1000));assertNull(state.pending(1000));
    }
    @Test public void corruptStateIsPreservedAndCanReceiveNewIdentity()throws Exception {
        File path=new File(temp.getRoot(),"broken.json");RescueFiles.write(path,"{broken");
        CorePushState state=new CorePushState(path);assertEquals("",state.snapshot().optString("device_id"));
        assertEquals(1,temp.getRoot().listFiles((d,n)->n.startsWith("broken.json.invalid-")).length);
        state.configure(identity("token_fixture_123456",0));assertEquals("fixture",new CorePushState(path).snapshot().getString("device_id"));
    }
}
