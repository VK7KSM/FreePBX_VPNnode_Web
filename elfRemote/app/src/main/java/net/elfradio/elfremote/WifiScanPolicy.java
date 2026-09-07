package net.elfradio.elfremote;

import org.json.JSONArray;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Locale;

final class WifiScanPolicy {
    static String security(String capabilities) {
        String value = capabilities == null ? "" : capabilities.toUpperCase(Locale.ROOT);
        if (value.contains("EAP")) return "Enterprise";
        if (value.contains("SAE")) return "WPA3";
        if (value.contains("PSK")) return "WPA/WPA2";
        if (value.contains("WEP")) return "WEP";
        if (value.contains("OWE")) return "OWE";
        if (value.contains("WPA") || value.contains("RSN")) return "Unknown";
        return "Open";
    }
    static JSONArray networks(JSONArray input) throws Exception {
        LinkedHashMap<String, JSONObject> strongest = new LinkedHashMap<>();
        for (int i = 0; i < input.length(); i++) {
            JSONObject entry = input.getJSONObject(i);
            String ssid = entry.getString("ssid"), sec = entry.getString("sec");
            int rssi = entry.getInt("rssi");
            if (ssid.isEmpty() || ssid.getBytes(StandardCharsets.UTF_8).length > 32 || rssi < -127 || rssi > 0) continue;
            String key = ssid + "\u0000" + sec;
            JSONObject previous = strongest.get(key);
            if (previous == null || rssi > previous.getInt("rssi")) strongest.put(key, entry);
        }
        ArrayList<JSONObject> sorted = new ArrayList<>(strongest.values());
        sorted.sort((a, b) -> Integer.compare(b.optInt("rssi"), a.optInt("rssi")));
        JSONArray result = new JSONArray();
        for (int i = 0; i < Math.min(30, sorted.size()); i++) result.put(sorted.get(i));
        return result;
    }
    private WifiScanPolicy() {}
}
