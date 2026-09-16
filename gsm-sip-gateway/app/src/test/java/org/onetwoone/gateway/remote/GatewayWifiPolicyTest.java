package org.onetwoone.gateway.remote;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE,sdk=28)
public class GatewayWifiPolicyTest {
    @Test public void acceptsOnlyExactWifiParameters() throws Exception {
        JSONObject value=GatewayWifiPolicy.connectParams(new JSONObject().put("ssid","Office WiFi").put("password","12345678"));
        assertEquals("Office WiFi",value.getString("ssid"));
        expectInvalid(new JSONObject().put("ssid","Office WiFi").put("password","12345678").put("hidden",true));
        expectInvalid(new JSONObject().put("ssid","Office WiFi").put("password","short"));
        expectInvalid(new JSONObject().put("ssid",new String(new char[33]).replace('\0','a')).put("password",""));
    }
    @Test public void validatesScanAndTaskEnvelope() throws Exception {
        long now=1_800_000_000_000L;
        JSONObject scan=new JSONObject().put("id","wifi-scan").put("idempotency_key","wifi-scan")
                .put("type","scan_wifi").put("expires_at",now+60_000).put("params",new JSONObject());
        assertEquals("scan_wifi",GatewayWifiPolicy.offer(scan,now).getString("type"));
        try{GatewayWifiPolicy.scanParams(new JSONObject().put("extra",true));fail();}catch(Exception expected){}
        try{GatewayWifiPolicy.offer(new JSONObject(scan.toString()).put("expires_at",now),now);fail();}catch(Exception expected){}
    }
    @Test public void normalizesScanSecurityAndStrongestNetworks() throws Exception {
        JSONArray input=new JSONArray().put(new JSONObject().put("ssid","A").put("rssi",-70).put("sec","WPA/WPA2"))
                .put(new JSONObject().put("ssid","A").put("rssi",-40).put("sec","WPA/WPA2"))
                .put(new JSONObject().put("ssid","B").put("rssi",-60).put("sec","Open"));
        JSONArray result=GatewayWifiScanPolicy.networks(input);
        assertEquals(2,result.length());assertEquals("A",result.getJSONObject(0).getString("ssid"));assertEquals(-40,result.getJSONObject(0).getInt("rssi"));
        assertEquals("WPA3",GatewayWifiScanPolicy.security("[RSN-SAE-CCMP]"));
        assertEquals("Enterprise",GatewayWifiScanPolicy.security("[RSN-EAP-CCMP]"));
    }
    @Test public void shellQuoteKeepsPathsSingleArgument(){assertEquals("'a'\"'\"'b'",GatewayWifiConnector.quote("a'b"));}
    @Test public void scanGrantIncludesBackgroundLocation() {
        String command=GatewayWifiScanner.locationGrantCommand();
        assertTrue(command.contains("ACCESS_COARSE_LOCATION"));
        assertTrue(command.contains("ACCESS_FINE_LOCATION"));
        assertTrue(command.contains("ACCESS_BACKGROUND_LOCATION"));
    }
    @Test public void rootReceiptRoundTripsWithoutRawSsidLines() throws Exception {
        JSONObject expected=new JSONObject().put("ok",true).put("ssid","Line1\nLine2");
        String output="WIFI_RESULT_HEX="+GatewayWifiRootMain.encodeResult(expected)+"\nWIFI_OPERATION_OK\n";
        JSONObject actual=GatewayWifiConnector.parseRootOutput(output);
        assertTrue(actual.getBoolean("ok"));assertEquals("Line1\nLine2",actual.getString("ssid"));
        try {GatewayWifiConnector.parseRootOutput("WIFI_OPERATION_OK\n");fail();}catch(Exception expectedFailure){}
    }
    private static void expectInvalid(JSONObject value)throws Exception{try{GatewayWifiPolicy.connectParams(value);fail();}catch(Exception expected){}}
}
