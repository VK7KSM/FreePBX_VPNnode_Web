package net.elfradio.elfremote;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class LostWipeAttemptTest {
    JSONObject due(boolean automatic)throws Exception {
        JSONObject s=new JSONObject();LostTimer.arm(s,true,1,true,0,0,"boot");
        LostWipeAttempt.started(s,automatic,"boot",10,"123");return s;
    }
    @Test public void liveInvocationRemainsUncancellableRegardlessOfTime()throws Exception {
        JSONObject s=due(true);LostWipeAttempt.recover(s,99999999,"boot",(b,p,t)->true);
        assertEquals("started",s.getString("wipe_state"));assertFalse(LostWipeAttempt.retry(s,99999999,"boot"));
    }
    @Test public void deadOwnerRetriesOnlyAfterBackoffAndRechecksContact()throws Exception {
        JSONObject s=due(true);LostWipeAttempt.recover(s,4000000,"boot",(b,p,t)->false);
        assertEquals("failed",s.getString("wipe_state"));assertFalse(LostWipeAttempt.retry(s,4029999,"boot"));
        LostTimer.contact(s,true,0,1,4020000,"boot");
        assertTrue(LostWipeAttempt.retry(s,4030000,"boot"));
        assertEquals(3590000,LostTimer.remaining(s,1,4030000,"boot"));
    }
    @Test public void deadOwnerStillOverdueCanRetryWithoutRearming()throws Exception {
        JSONObject s=due(true);LostWipeAttempt.recover(s,4000000,"boot",(b,p,t)->false);
        assertTrue(LostWipeAttempt.retry(s,4030000,"boot"));assertEquals(0,LostTimer.remaining(s,1,4030000,"boot"));
    }
    @Test public void manualConfirmationNeverReplays()throws Exception {
        JSONObject s=due(false);LostWipeAttempt.recover(s,4000000,"boot",(b,p,t)->false);
        assertFalse(LostWipeAttempt.retry(s,99999999,"boot"));
    }
    @Test public void cancellationWinsBeforeAnyRetry()throws Exception {
        JSONObject s=due(true);LostWipeAttempt.failed(s,4000000,"boot");s.put("auto_wipe_enabled",false).put("wipe_state","idle");
        assertFalse(LostWipeAttempt.retry(s,99999999,"boot"));assertEquals(Long.MAX_VALUE,LostTimer.remaining(s,1,99999999,"boot"));
    }
    @Test public void unknownOwnerCannotBeAssumedDead()throws Exception {
        JSONObject s=due(true);s.remove("wipe_owner_pid");LostWipeAttempt.recover(s,1,"boot",(b,p,t)->false);
        assertEquals("started",s.getString("wipe_state"));
        s=due(true);try{LostWipeAttempt.recover(s,1,"boot",(b,p,t)->{throw new java.io.IOException();});fail();}catch(java.io.IOException expected){}
        assertEquals("started",s.getString("wipe_state"));
    }
    @Test public void rebootDoesNotTurnBackoffIntoImmediateRetry()throws Exception {
        JSONObject s=due(true);LostWipeAttempt.failed(s,4000000,"boot");
        assertFalse(LostWipeAttempt.retry(s,2000,"new"));assertFalse(LostWipeAttempt.retry(s,31999,"new"));assertTrue(LostWipeAttempt.retry(s,32000,"new"));
    }
    @Test public void processIdentityIncludesStartTimeAndHandlesSpaces() {
        assertEquals("998",LostWipeAttempt.processStart("42 (process (with spaces)) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 998 20"));
    }
}
