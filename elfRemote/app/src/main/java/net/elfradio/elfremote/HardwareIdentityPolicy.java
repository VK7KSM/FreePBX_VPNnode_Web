package net.elfradio.elfremote;

import java.util.Locale;

final class HardwareIdentityPolicy {
    static String normalize(String raw) {
        String value = raw == null ? "" : raw.replace(":", "").replace("-", "").toLowerCase(Locale.US);
        if (!value.matches("[0-9a-f]{12}") || value.equals("000000000000")
                || (Integer.parseInt(value.substring(0, 2), 16) & 3) != 0) return "";
        StringBuilder result = new StringBuilder();
        for (int i = 0; i < 12; i += 2) {
            if (i != 0) result.append(':');
            result.append(value, i, i + 2);
        }
        return result.toString();
    }

    static String fromBytes(byte[] bytes) {
        if (bytes == null || bytes.length != 6) return "";
        StringBuilder result = new StringBuilder();
        for (byte b : bytes) result.append(String.format(Locale.US, "%02x", b & 255));
        return normalize(result.toString());
    }
}
