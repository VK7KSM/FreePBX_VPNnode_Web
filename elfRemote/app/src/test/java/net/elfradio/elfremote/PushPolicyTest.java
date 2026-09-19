package net.elfradio.elfremote;

import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class PushPolicyTest {
    private JSONObject notice() throws Exception {
        return new JSONObject().put("type", "status_request").put("request_id", "fixture-id")
                .put("version", 3).put("expires_at_ms", 2000);
    }
    @Test public void freshAcceptedDuplicatesAndOutOfOrderRejected() throws Exception {
        assertTrue(PushPolicy.shouldQueue(notice(), 2, 1000));
        assertFalse(PushPolicy.shouldQueue(notice(), 3, 1000));
        assertFalse(PushPolicy.shouldQueue(notice(), 4, 1000));
    }
    @Test public void expiredAndFarFutureRejected() throws Exception {
        assertFalse(PushPolicy.shouldQueue(notice(), 0, 2000));
        assertFalse(PushPolicy.shouldQueue(notice().put("expires_at_ms", 602000), 0, 1000));
    }
    @Test public void nonStatusAndMalformedValuesRejected() throws Exception {
        assertFalse(PushPolicy.shouldQueue(notice().put("type", "shell"), 0, 1000));
        assertFalse(PushPolicy.shouldQueue(notice().put("version", "3"), 0, 1000));
        assertFalse(PushPolicy.shouldQueue(notice().put("version", 3.5), 0, 1000));
        assertFalse(PushPolicy.shouldQueue(notice().put("request_id", "../other"), 0, 1000));
    }
    @Test public void reconnectDelayHasJitterAndBoundedGrowth() {
        assertTrue(PushPolicy.retryDelay(1, 0.9) > PushPolicy.retryDelay(1, 0));
        assertTrue(PushPolicy.retryDelay(5, 0) > PushPolicy.retryDelay(1, 1));
        assertEquals(900000, PushPolicy.retryDelay(100, 1));
        assertTrue(PushPolicy.retryDelay(-1, -1) >= 1000);
    }
}
