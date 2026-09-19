package net.elfradio.elfremote;

import org.json.JSONObject;

final class PushPolicy {
    static boolean shouldQueue(JSONObject value, long lastVersion, long now) {
        if (value == null || !"status_request".equals(value.optString("type"))) return false;
        if (!value.optString("request_id").matches("[A-Za-z0-9-]{1,96}")) return false;
        Object version = value.opt("version"), expires = value.opt("expires_at_ms");
        if (!(version instanceof Number) || !(expires instanceof Number)) return false;
        long v = ((Number) version).longValue(), end = ((Number) expires).longValue();
        if (((Number) version).doubleValue() != v || ((Number) expires).doubleValue() != end) return false;
        return v > lastVersion && v > 0 && end > now && end - now <= 600000;
    }

    static long retryDelay(int failures, double random) {
        long base = Math.min(900000, 1000L << Math.min(10, Math.max(0, failures)));
        return Math.min(900000, base + (long) (base * 0.25 * Math.max(0, Math.min(1, random))));
    }

    private PushPolicy() {}
}
