package net.elfradio.elfremote;
import org.junit.Test;
import static org.junit.Assert.*;

public class RadioLocationTest {
    @Test public void cellDoesNotSuppressEnabledWifiRefresh() {
        assertTrue(RadioLocation.needsCoreRefresh(true,0,1));
        assertTrue(RadioLocation.needsCoreRefresh(true,1,1));
        assertFalse(RadioLocation.needsCoreRefresh(true,2,1));
        assertFalse(RadioLocation.needsCoreRefresh(false,0,1));
        assertTrue(RadioLocation.needsCoreRefresh(false,0,0));
    }
    @Test public void rejectRandomMulticastPlaceholderAndReservedAccessPoints() {
        assertTrue(RadioLocation.usableMac("10:11:22:33:44:55"));
        for(String mac:new String[]{"02:00:00:00:00:00","ff:ff:ff:ff:ff:ff","00:00:00:00:00:00","00:00:5e:00:01:02","not-a-mac"})assertFalse(RadioLocation.usableMac(mac));
    }
    @Test public void staleScanIsNotStampedAsANewObservation() {
        assertTrue(RadioLocation.recent(1000000000L,2000000000L));
        assertFalse(RadioLocation.recent(0,2000000000L));
        assertFalse(RadioLocation.recent(3000000000L,2000000000L));
        assertFalse(RadioLocation.recent(1000000000L,122000000000L));
    }
    @Test public void lteUsesWholeCellIdAndRejectsUnknownModemFields()throws Exception {
        assertEquals(17856323,RadioLocation.tower("lte",17856323,321,505,1,-96).getInt("cellId"));
        assertNull(RadioLocation.tower("gsm",17856323,321,505,1,-96));
        assertNull(RadioLocation.tower("lte",Integer.MAX_VALUE,321,505,1,-96));
        assertNull(RadioLocation.tower("lte",123,321,Integer.MAX_VALUE,1,-96));
        assertNull(RadioLocation.tower("lte",123,-1,505,1,-96));
        assertTrue(UpdatePolicy.HEALTH_TIMEOUT_MS>60000L+5000L+30000L+8000L+4500L);
    }
    @Test public void zeroTimestampIsAcceptedOnlyForCurrentlyRegisteredCell() {
        long now=300000000000L;
        assertTrue(RadioLocation.usableCellObservation(0,now,true));
        assertFalse(RadioLocation.usableCellObservation(0,now,false));
        assertFalse(RadioLocation.usableCellObservation(-1,now,true));
        assertFalse(RadioLocation.usableCellObservation(Long.MAX_VALUE,now,true));
        assertFalse(RadioLocation.usableCellObservation(now+1,now,true));
        assertFalse(RadioLocation.usableCellObservation(1000000000L,now,true));
        assertFalse(RadioLocation.usableCellObservation(1000000000L,now,false));
        assertTrue(RadioLocation.usableCellObservation(now-1000000000L,now,true));
        assertTrue(RadioLocation.usableCellObservation(now-1000000000L,now,false));
        assertFalse(RadioLocation.recent(0,now));
    }
}
