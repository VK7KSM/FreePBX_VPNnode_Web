package net.elfradio.elfremote;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class WifiScanPolicyTest {
    private JSONObject entry(String ssid, int rssi, String sec) throws Exception {
        return new JSONObject().put("ssid", ssid).put("rssi", rssi).put("sec", sec);
    }
    @Test public void strongestAccessPointWinsWithoutMergingDifferentSecurity() throws Exception {
        JSONArray input = new JSONArray().put(entry("fixture", -80, "Open"))
                .put(entry("fixture", -40, "Open")).put(entry("fixture", -60, "WPA3"));
        JSONArray output = WifiScanPolicy.networks(input);
        assertEquals(2, output.length());
        assertEquals(-40, output.getJSONObject(0).getInt("rssi"));
        assertEquals("WPA3", output.getJSONObject(1).getString("sec"));
    }
    @Test public void scanIsBoundedAndInvalidNamesAndSignalAreOmitted() throws Exception {
        JSONArray input = new JSONArray().put(entry("", -40, "Open"))
                .put(entry("x".repeat(33), -40, "Open")).put(entry("invalid", 5, "Open"));
        assertEquals(0, WifiScanPolicy.networks(input).length());
        for (int i = 0; i < 40; i++) input.put(entry("fixture-"+i, -90+i, "Open"));
        JSONArray output = WifiScanPolicy.networks(input);
        assertEquals(30, output.length());
        assertEquals(-51, output.getJSONObject(0).getInt("rssi"));
    }
    @Test public void encryptionIsNotMistakenForOpenNetwork() {
        assertEquals("WPA3", WifiScanPolicy.security("[RSN-PSK+SAE-CCMP][ESS]"));
        assertEquals("Enterprise", WifiScanPolicy.security("[WPA2-EAP-CCMP]"));
        assertEquals("OWE", WifiScanPolicy.security("[RSN-OWE-CCMP]"));
        assertEquals("Unknown", WifiScanPolicy.security("[RSN-UNKNOWN]"));
        assertEquals("Open", WifiScanPolicy.security("[ESS]"));
    }
}
