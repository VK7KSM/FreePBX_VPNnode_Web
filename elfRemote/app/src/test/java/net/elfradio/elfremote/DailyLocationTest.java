package net.elfradio.elfremote;

import org.junit.Test;
import static org.junit.Assert.*;

public class DailyLocationTest {
    @Test public void explicitRequestRejectsRecentButPreRequestCache() {
        assertTrue(DailyLocation.recent(1000, 3000));
        assertFalse(DailyLocation.freshForRequest(1000, 3000, 2000));
        assertTrue(DailyLocation.freshForRequest(2500, 3000, 2000));
        assertFalse(DailyLocation.freshForRequest(4000, 3000, 2000));
    }
    @Test public void firstPermissionInitializationIsNotBlockedByPreviousDeniedSample() {
        assertTrue(DailyLocation.shouldStart(1000, 0, false, 2000));
        assertFalse(DailyLocation.shouldStart(1000, 1000, false, 2000));
        assertFalse(DailyLocation.shouldStart(1000, 0, true, 2000));
        assertTrue(DailyLocation.shouldStart(1000, 1000, false, 3601000));
    }
    @Test public void retryAndReconnectDoNotCauseHourlySensorWorkToRepeat() {
        assertTrue(DailyLocation.due(0, 1000));
        assertFalse(DailyLocation.due(1000, 61000));
        assertFalse(DailyLocation.due(1000, 900000));
        assertTrue(DailyLocation.due(1000, 3601000));
        assertTrue(DailyLocation.due(2000, 1000));
    }
    @Test public void staleFutureAndUnknownSamplesCannotCountAsFresh() {
        assertTrue(DailyLocation.recent(1000000000L, 2000000000L));
        assertFalse(DailyLocation.recent(0, 2000000000L));
        assertFalse(DailyLocation.recent(3000000000L, 2000000000L));
        assertFalse(DailyLocation.recent(1000000000L, 902000000000L));
    }
}
