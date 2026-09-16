package org.onetwoone.gateway.remote;

import android.content.Context;
import android.content.SharedPreferences;
import java.security.MessageDigest;
import java.security.SecureRandom;
import org.json.JSONObject;

/** Separate from all existing SIP, audio and mute preferences. */
final class GatewayRemoteStore {
    final SharedPreferences prefs;
    GatewayRemoteStore(Context context) { prefs = context.getSharedPreferences("elfremote_gateway", Context.MODE_PRIVATE); }
    synchronized String token() throws Exception {
        String value = prefs.getString("token", "");
        if (!value.isEmpty()) return value;
        byte[] bytes = new byte[32]; new SecureRandom().nextBytes(bytes);
        value = hex(bytes);
        if (!prefs.edit().putString("token", value).commit()) throw new java.io.IOException("identity persistence failed");
        return value;
    }
    String deviceId() { return prefs.getString("device_id", ""); }
    boolean enrollmentExpired() {
        String value = prefs.getString("expires_at", "");
        if (value.isEmpty()) return true;
        try { return java.time.Instant.parse(value).toEpochMilli() <= System.currentTimeMillis(); }
        catch (Exception error) { return true; }
    }
    JSONObject identity() throws Exception { return new JSONObject().put("device_id", deviceId()).put("token", token()); }
    void registered(JSONObject response) throws Exception {
        if (response.optString("device_id").isEmpty()) throw new java.io.IOException("registration incomplete");
        SharedPreferences.Editor edit = prefs.edit().putString("device_id", response.getString("device_id"))
                .putBoolean("paired", response.optBoolean("paired"));
        for (String key : new String[]{"code", "enroll_id", "expires_at"}) if (response.has(key)) edit.putString(key, response.optString(key));
        if (!edit.commit()) throw new java.io.IOException("registration persistence failed");
    }
    static String hash(String value) throws Exception { return hex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(java.nio.charset.StandardCharsets.UTF_8))); }
    private static String hex(byte[] bytes) {
        StringBuilder value = new StringBuilder();
        for (byte b : bytes) value.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
        return value.toString();
    }
}
