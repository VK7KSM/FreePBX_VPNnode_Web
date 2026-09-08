package net.elfradio.elfremote;

import org.json.JSONObject;
import java.nio.charset.StandardCharsets;

final class ConfigPolicy {
    static void wifi(JSONObject p) {
        String ssid = p.optString("ssid", ""), password = p.optString("password", "");
        if (ssid.isEmpty() || ssid.getBytes(StandardCharsets.UTF_8).length > 32 || ssid.indexOf('\0') >= 0)
            throw new IllegalArgumentException("wifi-invalid-ssid");
        if (!password.isEmpty() && !password.matches("[0-9a-fA-F]{64}")
                && (password.length() < 8 || password.length() > 63 || !password.matches("[\\x20-\\x7e]+")))
            throw new IllegalArgumentException("wifi-invalid-password");
    }
    static String quoteWifi(String value) { return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""; }
    static void contact(String type, JSONObject p) {
        if ("contacts_read".equals(type)) return;
        if (!"contact_add".equals(type) && p.optLong("id", 0) <= 0) throw new IllegalArgumentException("contact-invalid-id");
        if ("contact_delete".equals(type)) return;
        String name=p.optString("name", "").trim(), phone=p.optString("phone", "").trim();
        if (name.isEmpty() || name.length()>100 || phone.isEmpty() || phone.length()>80 || name.indexOf('\0')>=0 || phone.indexOf('\0')>=0)
            throw new IllegalArgumentException("contact-invalid-fields");
    }
}
