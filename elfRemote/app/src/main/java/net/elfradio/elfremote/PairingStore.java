package net.elfradio.elfremote;

import android.content.Context;
import android.content.SharedPreferences;

import java.security.MessageDigest;
import java.security.SecureRandom;

final class PairingStore {
    private static final String PREFS = "elfremote";
    private final SharedPreferences prefs;

    PairingStore(Context context) {
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    synchronized String token() {
        String t = prefs.getString("token", "");
        if (t.length() == 64) return t;
        byte[] raw = new byte[32];
        new SecureRandom().nextBytes(raw);
        t = toHex(raw);
        prefs.edit().putString("token", t).apply();
        return t;
    }

    String tokenSha256() {
        return sha256Hex(token());
    }

    String code() { return prefs.getString("code", ""); }
    String enrollId() { return prefs.getString("enroll_id", ""); }
    String deviceId() { return prefs.getString("device_id", ""); }
    boolean paired() { return prefs.getBoolean("paired", false); }
    String lastStatus() { return prefs.getString("last_status", ""); }
    long expiresAt() { return prefs.getLong("expires_at", 0L); }

    void saveEnroll(String code, String enrollId, long expiresAtMs) {
        prefs.edit()
                .putString("code", code)
                .putString("enroll_id", enrollId)
                .putLong("expires_at", expiresAtMs)
                .putBoolean("paired", false)
                .remove("device_id")
                .apply();
    }

    void clearEnroll() {
        prefs.edit()
                .remove("code")
                .remove("enroll_id")
                .remove("expires_at")
                .putBoolean("paired", false)
                .remove("device_id")
                .apply();
    }

    void savePaired(String deviceId) {
        prefs.edit()
                .putBoolean("paired", true)
                .putString("device_id", deviceId)
                .apply();
    }

    void setLastStatus(String status) {
        prefs.edit().putString("last_status", status == null ? "" : status).apply();
    }

    static String sha256Hex(String s) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            return toHex(md.digest(s.getBytes("UTF-8")));
        } catch (Exception e) {
            return "";
        }
    }

    private static String toHex(byte[] data) {
        StringBuilder sb = new StringBuilder(data.length * 2);
        for (byte b : data) sb.append(String.format("%02x", b));
        return sb.toString();
    }
}
