package net.elfradio.elfremote;

import org.junit.Test;
import org.junit.Rule;
import org.junit.rules.TemporaryFolder;
import org.json.JSONObject;
import static org.junit.Assert.*;

public class LostSafetyTest {
    @Rule public TemporaryFolder folder=new TemporaryFolder();
    JSONObject offer(boolean enabled)throws Exception{return new JSONObject().put("id","test-task").put("idempotency_key","test-key").put("type","set_lost_mode").put("expires_at",9000)
        .put("params",new JSONObject().put("version",2).put("enabled",enabled).put("auto_wipe_enabled",false));}
    @Test public void onlyCancellationCanUseSafetyLane()throws Exception {
        assertTrue(LostSafety.accepts(offer(false)));assertFalse(LostSafety.accepts(offer(true)));
        assertFalse(LostSafety.accepts(offer(false).put("type","wipe_data")));
    }
    @Test public void cancellationRunsBeforeNetworkAndReceiptRetryDoesNotExecuteAgain()throws Exception {
        TaskReceipts receipts=new TaskReceipts(folder.newFolder());int[] executed={0},sent={0};
        LostSafety.Execute execute=p->{executed[0]++;return new JSONObject().put("enabled",false);};
        try{LostSafety.run(offer(false),receipts,execute,(id,phase,detail,result)->{assertEquals(1,executed[0]);throw new java.io.IOException("离线");},1000);fail();}
        catch(java.io.IOException expected){}
        LostSafety.run(offer(false),receipts,execute,(id,phase,detail,result)->sent[0]++,10000);
        assertEquals(1,executed[0]);assertEquals(3,sent[0]);assertTrue(receipts.read("test-task").getBoolean("acknowledged"));
    }
    @Test public void expiredTaskDoesNotExecute()throws Exception {
        LostSafety.run(offer(false),new TaskReceipts(folder.newFolder()),p->{fail();return null;},(id,phase,detail,result)->assertEquals("rejected",phase),9000);
    }
    @Test public void cancelledRevisionRejectsOldEnable()throws Exception {
        JSONObject s=new JSONObject(),request=new JSONObject().put("expected_revision","initial");LostRevision.require(s,request);
        LostRevision.advance(s);assertEquals(1,s.getInt("revision_seq"));
        try{LostRevision.require(s,request);fail();}catch(IllegalStateException expected){}
    }
    @Test public void localCoreAuthenticationFailsClosed()throws Exception {
        String token=CoreAuth.ensure(folder.getRoot());assertTrue(CoreAuth.authorized(token,"Bearer "+token));
        assertFalse(CoreAuth.authorized(token,null));assertFalse(CoreAuth.authorized(token,"Bearer wrong"));
        assertFalse(CoreAuth.allowed(new java.io.File(folder.getRoot(),"missing"),"Bearer "+token));
        assertEquals(token,CoreAuth.ensure(folder.getRoot()));
    }
}
