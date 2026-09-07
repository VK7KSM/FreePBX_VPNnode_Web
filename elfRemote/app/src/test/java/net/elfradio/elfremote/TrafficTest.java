package net.elfradio.elfremote;

import org.json.JSONObject;
import org.junit.Test;
import java.io.StringReader;
import static org.junit.Assert.*;

public class TrafficTest {
    @Test public void newlyVisibleInterfaceStartsBaselineInsteadOfAddingHistoricalBytes() throws Exception {
        TrafficLedger ledger = new TrafficLedger(null);
        ledger.sample(counters(10, 20), "qtaguid_uid", "boot", 100, 1000);
        JSONObject changed = counters(20, 30).put("rmnet0", new JSONObject().put("rx_bytes", 9000).put("tx_bytes", 8000));
        JSONObject result = ledger.sample(changed, "qtaguid_uid", "boot", 200, 1100);
        assertEquals(0, result.getLong("rx_bytes"));
        assertEquals(1, result.getInt("gaps"));
        changed.getJSONObject("rmnet0").put("rx_bytes", 9010);
        result = ledger.sample(changed, "qtaguid_uid", "boot", 300, 1200);
        assertEquals(10, result.getLong("rx_bytes"));
        assertEquals(100, result.getLong("covered_ms"));
    }
    private JSONObject counters(long rx, long tx) throws Exception {
        return new JSONObject().put("wlan0", new JSONObject().put("rx_bytes", rx).put("tx_bytes", tx));
    }
    @Test public void uidCountersDoNotDoubleCountTagsOrOtherApplications() throws Exception {
        String source = "idx iface acct_tag_hex uid_tag_int cnt_set rx_bytes tx_bytes\n"
                + "1 wlan0 0x0 42 0 100 200\n2 wlan0 0x0 42 1 30 40\n"
                + "3 wlan0 0xabc 42 0 20 30\n4 wlan0 0x0 99 0 999 999\n"
                + "5 rmnet0 0x0 42 0 5 6\n";
        JSONObject result = UidTraffic.parse(new StringReader(source), 42);
        assertEquals(130, result.getJSONObject("wlan0").getLong("rx_bytes"));
        assertEquals(240, result.getJSONObject("wlan0").getLong("tx_bytes"));
        assertEquals(5, result.getJSONObject("rmnet0").getLong("rx_bytes"));
    }
    @Test public void malformedCounterInputDoesNotLookLikeZeroTraffic() throws Exception {
        for (String source : new String[]{"", "idx rx_bytes\n", "idx iface acct_tag_hex uid_tag_int cnt_set rx_bytes tx_bytes\n1 wlan0 0x0 42 0 -1 0\n"}) {
            try { UidTraffic.parse(new StringReader(source), 42); fail(); } catch (Exception expected) {}
        }
    }
    @Test public void processRestartKeepsCumulativeDeltas() throws Exception {
        TrafficLedger first = new TrafficLedger(null);
        first.sample(counters(100, 200), "qtaguid_uid", "boot-a", 1000, 10000);
        JSONObject measured = first.sample(counters(150, 270), "qtaguid_uid", "boot-a", 2000, 11000);
        assertEquals(50, measured.getLong("rx_bytes"));
        TrafficLedger restarted = new TrafficLedger(first.saved());
        measured = restarted.sample(counters(170, 280), "qtaguid_uid", "boot-a", 3000, 12000);
        assertEquals(70, measured.getLong("rx_bytes"));
        assertEquals(80, measured.getLong("tx_bytes"));
        assertEquals(2000, measured.getLong("covered_ms"));
        assertEquals(0, measured.getInt("gaps"));
    }
    @Test public void rebootAndCounterResetPreserveTotalsAndMarkGaps() throws Exception {
        TrafficLedger ledger = new TrafficLedger(null);
        ledger.sample(counters(100, 200), "qtaguid_uid", "boot-a", 1000, 10000);
        ledger.sample(counters(150, 250), "qtaguid_uid", "boot-a", 2000, 11000);
        JSONObject result = ledger.sample(counters(20, 30), "qtaguid_uid", "boot-b", 500, 12000);
        assertEquals(50, result.getLong("rx_bytes")); assertEquals(1, result.getInt("gaps"));
        result = ledger.sample(counters(25, 40), "qtaguid_uid", "boot-b", 1000, 12500);
        assertEquals(55, result.getLong("rx_bytes"));
        result = ledger.sample(counters(1, 2), "qtaguid_uid", "boot-b", 2000, 13000);
        assertEquals(55, result.getLong("rx_bytes")); assertEquals(2, result.getInt("gaps"));
    }
    @Test public void sourceChangeDoesNotAddOverlappingCountersAndClockJumpDoesNotChangeCoverage() throws Exception {
        TrafficLedger ledger = new TrafficLedger(null);
        ledger.sample(counters(10, 20), "qtaguid_uid", "boot", 100, 1000);
        JSONObject result = ledger.sample(counters(20, 30), "qtaguid_uid", "boot", 200, 500);
        assertEquals(100, result.getLong("covered_ms"));
        result = ledger.sample(counters(9999, 9999), "trafficstats_uid", "boot", 300, 100);
        assertEquals(10, result.getLong("rx_bytes")); assertEquals(1, result.getInt("gaps"));
    }
}
