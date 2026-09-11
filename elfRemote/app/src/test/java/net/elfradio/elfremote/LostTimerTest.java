package net.elfradio.elfremote;

import org.junit.Test;
import org.json.JSONObject;
import static org.junit.Assert.*;

public class LostTimerTest {
    private static final long DAY=24*LostTimer.HOUR;
    private JSONObject armed(boolean paired)throws Exception {
        JSONObject s=new JSONObject();LostTimer.arm(s,true,24,paired,1000000,1000,"boot1");return s;
    }
    @Test public void disabledNeverErasesEvenAfterYear()throws Exception {
        JSONObject s=armed(false);LostTimer.arm(s,false,24,false,1000000,1000,"boot1");
        assertEquals(Long.MAX_VALUE,LostTimer.remaining(s,1000000+366*DAY,1000+366*DAY,"boot1"));
    }
    @Test public void exact24HoursWithoutAdditionalDay()throws Exception {
        JSONObject s=armed(true);assertEquals(1,LostTimer.remaining(s,1000000+DAY-1,1000+DAY-1,"boot1"));
        assertEquals(0,LostTimer.remaining(s,1000000+DAY,1000+DAY,"boot1"));
    }
    @Test public void contactDoesNotCancelUnpairedDeadline()throws Exception {
        JSONObject s=armed(false);LostTimer.contact(s,false,0,1000000+DAY-1000,1000+DAY-1000,"boot1");
        assertEquals(1000,LostTimer.remaining(s,1000000+DAY-1000,1000+DAY-1000,"boot1"));
        assertEquals("unpaired",LostTimer.trigger(s,1000000+DAY-1000,1000+DAY-1000,"boot1"));
    }
    @Test public void RepairedAndContactResetsBothConditions()throws Exception {
        JSONObject s=armed(false);LostTimer.contact(s,true,0,1000000+DAY-1000,1000+DAY-1000,"boot1");
        assertEquals(DAY,LostTimer.remaining(s,1000000+DAY-1000,1000+DAY-1000,"boot1"));
    }
    @Test public void oldUnpairedDateCannotEraseImmediatelyWhenArmed()throws Exception {
        JSONObject s=armed(false);LostTimer.contact(s,false,1,1001000,2000,"boot1");assertEquals(DAY-1000,LostTimer.remaining(s,1001000,2000,"boot1"));
    }
    @Test public void latePairingNoticeUsesOriginalServerTimeButNotBeforeArming()throws Exception {
        JSONObject s=armed(true);LostTimer.contact(s,false,1005000,1010000,11000,"boot1");assertEquals(DAY-5000,LostTimer.remaining(s,1010000,11000,"boot1"));
    }
    @Test public void wallClockChangesDoNotAffectSameBoot()throws Exception {
        JSONObject s=armed(true);assertEquals(DAY-5000,LostTimer.remaining(s,999999999999L,6000,"boot1"));
        assertEquals(DAY-5000,LostTimer.remaining(s,1,6000,"boot1"));
    }
    @Test public void rebootKeepsDeadlineInsteadOfRearming()throws Exception {
        JSONObject s=armed(true);LostTimer.checkpoint(s,4600000,3601000,"boot1");
        assertEquals(DAY-3602000,LostTimer.remaining(s,999999999999L,2000,"boot2"));
        assertEquals(DAY-3602000,LostTimer.remaining(s,1,2000,"boot2"));
        LostTimer.checkpoint(s,1,2000,"boot2");
        assertEquals(DAY-3605000,LostTimer.remaining(s,1,3000,"boot3"));
    }
    @Test public void startedOrFailedNeverRepeatsDestruction()throws Exception {
        for(String state:new String[]{"started","failed"}){
            JSONObject s=armed(true);s.put("wipe_state",state);assertEquals(Long.MAX_VALUE,LostTimer.remaining(s,1000000+DAY,1000+DAY,"boot1"));
        }
    }
}
