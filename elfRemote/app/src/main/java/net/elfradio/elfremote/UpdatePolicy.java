package net.elfradio.elfremote;

import org.json.JSONObject;

import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;

final class UpdatePolicy {
    static final String ST_PENDING = "pending";
    static final String ST_CLAIMED = "claimed";
    static final String ST_DOWNLOADING = "downloading";
    static final String ST_VERIFYING = "verifying";
    static final String ST_INSTALLING = "installing";
    static final String ST_WAIT_HEALTH = "wait_health";
    static final String ST_SUCCESS = "success";
    static final String ST_ROLLBACK = "rollback";
    static final String ST_RECOVERED = "recovered";
    static final String ST_REJECTED = "rejected";
    static final String LAST_GOOD_APK = "/data/local/elfremote/last_good.apk";
    static final String UPDATER_APK = "/data/local/elfremote/updater.apk";
    static final long HEALTH_TIMEOUT_MS = 90_000L;
    static final String PKG = "net.elfradio.elfremote";
    static final String PUBLIC_KEY_PEM = "-----BEGIN PUBLIC KEY-----\n"
            + "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuHuRa52XY+MxbuXi5azn\n"
            + "9/MoJZEHiGi80WsQOr3ODkaqaLgdd9UBxjkj0dirBmTMGP3yNkm9LUjKxCAyhcd6\n"
            + "RlRe6I6PuFMx6eYOfGfYDu/VTtkCrAYiOJOnnynJfHF8Rul93mLyTA19Vx5S7FWW\n"
            + "JtWN43p0VRVU3YOuat97yWJS4xH2RAzNYz+fLK8GTHSYGdaedF6yiETAH9HB7TLs\n"
            + "c6v0ajptxVD/pU5q1zAWjllpTpcfcN97ma2Bpd82PohOTukFFhzkRO9ZJL5t2zpO\n"
            + "Aev2EdkUUH+FvzsMHDwg8po9Yb3tdw0OfDH5hhk7+Q+GUDV/A8sgANTIRa31Yajc\n"
            + "5QIDAQAB\n"
            + "-----END PUBLIC KEY-----";

    static final class Health {
        String versionName = "";
        int versionCode;
        boolean identityOk;
        boolean reportOk;
        boolean watchdogAlive;
        boolean updaterAlive;
    }

    static JSONObject parseManifest(String raw) {
        if (raw == null || raw.length() == 0) return null;
        try {
            JSONObject m = new JSONObject(raw);
            if (!PKG.equals(m.optString("package", ""))) return null;
            int vc = m.optInt("versionCode", 0);
            if (vc <= 0) return null;
            if (m.optString("versionName", "").length() == 0) return null;
            if (!sha256HexLooksValid(m.optString("sha256", ""))) return null;
            if (!sha256HexLooksValid(m.optString("certSha256", ""))) return null;
            if (m.optInt("size", 0) <= 0) return null;
            String url = m.optString("url", "");
            if (!url.startsWith("https://")) return null;
            if (url.contains("127.0.0.1") || url.contains("://localhost")) return null;
            if (m.optString("job_id", "").length() == 0) return null;
            return m;
        } catch (Exception e) {
            return null;
        }
    }

    static boolean expired(JSONObject m, long nowMs) {
        if (m == null) return true;
        long exp = m.optLong("expires_at", 0L);
        return exp > 0 && nowMs >= exp;
    }

    static boolean sha256HexLooksValid(String hex) {
        return hex != null && hex.matches("[0-9a-f]{64}");
    }

    static String sha256Hex(byte[] data) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            return toHex(md.digest(data));
        } catch (Exception e) {
            return "";
        }
    }

    static boolean apkMatches(byte[] apk, int size, String sha256) {
        if (apk == null || !sha256HexLooksValid(sha256)) return false;
        if (apk.length != size) return false;
        return sha256.equals(sha256Hex(apk));
    }

    static boolean archiveMatches(JSONObject manifest, String packageName, int code, String name, String cert) {
        return manifest != null && PKG.equals(packageName)
                && code == manifest.optInt("versionCode", -1)
                && name != null && name.equals(manifest.optString("versionName"))
                && sha256HexLooksValid(cert) && cert.equals(manifest.optString("certSha256"));
    }

    static String systemInstallCommand(String path) {
        if (!"/data/local/elfremote/pending.apk".equals(path) && !LAST_GOOD_APK.equals(path))
            throw new IllegalArgumentException("install path invalid");
        String target="/system/app/ElfRemote/ElfRemote.apk";
        return "set -e; mount -o remount,rw /system; trap 'mount -o remount,ro /system' EXIT; "
                + "cp '"+path+"' "+target+".new; chown 0:0 "+target+".new; chmod 0644 "+target+".new; "
                + "restorecon "+target+".new; cmp '"+path+"' "+target+".new; sync; "
                + "mv "+target+".new "+target+"; restorecon "+target+"; sync; "
                + "if mount -o remount,ro /system; then echo SYS_READONLY; else echo SYS_READONLY_PENDING_REBOOT; fi; "
                + "trap - EXIT; echo SYS_OK";
    }

    static boolean alreadyOnTarget(String haveName, int haveCode, String wantName, int wantCode) {
        return haveCode == wantCode && wantName != null && wantName.equals(haveName);
    }

    static boolean preserveBackup(String job, String diskJob, String state, boolean backupExists) {
        return backupExists && job != null && !job.isEmpty() && job.equals(diskJob)
                && (ST_INSTALLING.equals(state) || ST_WAIT_HEALTH.equals(state) || ST_ROLLBACK.equals(state));
    }

    static boolean healthy(Health h, String wantName, int wantCode) {
        if (h == null) return false;
        if (!h.identityOk || !h.reportOk || !h.watchdogAlive || !h.updaterAlive) return false;
        return alreadyOnTarget(h.versionName, h.versionCode, wantName, wantCode);
    }

    static boolean canAdvance(String from, String to) {
        if (from == null || to == null) return false;
        if (from.equals(to)) return true;
        if (ST_PENDING.equals(from) && ST_CLAIMED.equals(to)) return true;
        if (ST_CLAIMED.equals(from) && ST_DOWNLOADING.equals(to)) return true;
        if (ST_DOWNLOADING.equals(from) && ST_VERIFYING.equals(to)) return true;
        if (ST_VERIFYING.equals(from) && ST_INSTALLING.equals(to)) return true;
        if (ST_INSTALLING.equals(from) && ST_WAIT_HEALTH.equals(to)) return true;
        if (ST_WAIT_HEALTH.equals(from) && ST_SUCCESS.equals(to)) return true;
        if (ST_ROLLBACK.equals(to) && (ST_CLAIMED.equals(from) || ST_DOWNLOADING.equals(from)
                || ST_VERIFYING.equals(from) || ST_INSTALLING.equals(from)
                || ST_WAIT_HEALTH.equals(from))) {
            return true;
        }
        if (ST_ROLLBACK.equals(from) && ST_RECOVERED.equals(to)) return true;
        if (ST_REJECTED.equals(from) && ST_REJECTED.equals(to)) return true;
        if (ST_REJECTED.equals(to) && (ST_CLAIMED.equals(from) || ST_DOWNLOADING.equals(from)
                || ST_VERIFYING.equals(from))) {
            return true;
        }
        return false;
    }

    static boolean healthTimedOut(long startedMs, long nowMs, long timeoutMs) {
        if (timeoutMs <= 0) timeoutMs = HEALTH_TIMEOUT_MS;
        return nowMs - startedMs >= timeoutMs;
    }

    /**
     * Resume after pm install may SIGTERM the updater.
     * onTarget: live PM already matches the job. healthOk: health.ok matches versionCode.
     */
    static String resumeAction(String diskState, boolean onTarget, boolean healthOk,
            boolean lastGoodExists) {
        return resumeAction(diskState, onTarget, healthOk, lastGoodExists, "", "");
    }

    static String resumeAction(String diskState, boolean onTarget, boolean healthOk,
            boolean lastGoodExists, String diskJobId, String jobId) {
        if (diskState == null) diskState = "";
        boolean sameJob = jobId != null && jobId.length() > 0 && jobId.equals(diskJobId);
        if (!sameJob) {
            if (onTarget) {
                if (healthOk) return ST_SUCCESS;
                return ST_WAIT_HEALTH;
            }
            return ST_DOWNLOADING;
        }
        if (onTarget) {
            if (healthOk) return ST_SUCCESS;
            if (ST_ROLLBACK.equals(diskState) && lastGoodExists) return ST_ROLLBACK;
            return ST_WAIT_HEALTH;
        }
        if (ST_ROLLBACK.equals(diskState) || ST_WAIT_HEALTH.equals(diskState)
                || ST_RECOVERED.equals(diskState)) {
            return ST_RECOVERED;
        }
        return ST_DOWNLOADING;
    }

    static boolean installOutputMeansHealthy(String pmOut) {
        return false;
    }

    static String[] pmInstallArgv(String apkPath) {
        return new String[] { "pm", "install", "-r", "-d", apkPath };
    }

    static String publicKeyPem(java.security.PublicKey pub) {
        if (pub == null) return "";
        return "-----BEGIN PUBLIC KEY-----\n" + chunk(b64(pub.getEncoded())) + "\n-----END PUBLIC KEY-----";
    }

    static String sign(PrivateKey priv, byte[] payload) throws Exception {
        Signature s = Signature.getInstance("SHA256withRSA");
        s.initSign(priv);
        s.update(payload);
        return toHex(s.sign());
    }

    static boolean verifySignature(String pem, byte[] payload, String sigHex) {
        if (pem == null || payload == null || !looksHex(sigHex)) return false;
        try {
            PublicKey pub = publicFromPem(pem);
            Signature s = Signature.getInstance("SHA256withRSA");
            s.initVerify(pub);
            s.update(payload);
            return s.verify(fromHex(sigHex));
        } catch (Exception e) {
            return false;
        }
    }

    static PublicKey publicFromPem(String pem) throws Exception {
        String body = pem.replace("-----BEGIN PUBLIC KEY-----", "")
                .replace("-----END PUBLIC KEY-----", "")
                .replace("\r", "")
                .replace("\n", "")
                .replace(" ", "");
        byte[] der = fromB64(body);
        return KeyFactory.getInstance("RSA").generatePublic(new X509EncodedKeySpec(der));
    }

    static PrivateKey privateFromPem(String pem) throws Exception {
        String body = pem.replace("-----BEGIN PRIVATE KEY-----", "")
                .replace("-----END PRIVATE KEY-----", "")
                .replace("\r", "")
                .replace("\n", "")
                .replace(" ", "");
        byte[] der = fromB64(body);
        return KeyFactory.getInstance("RSA").generatePrivate(new PKCS8EncodedKeySpec(der));
    }

    static String jobShell(String jsonPath) {
        return "export PATH=/system/bin:/system/xbin:/sbin:/vendor/bin:$PATH\n"
                + "export CLASSPATH=" + UPDATER_APK + "\n"
                + "exec /system/bin/app_process /system/bin net.elfradio.elfremote.UpdateTool run "
                + jsonPath + "\n";
    }

    private static boolean looksHex(String s) {
        return s != null && s.length() >= 8 && s.matches("[0-9a-fA-F]+") && (s.length() % 2) == 0;
    }

    private static String toHex(byte[] data) {
        StringBuilder sb = new StringBuilder(data.length * 2);
        for (int i = 0; i < data.length; i++) {
            sb.append(String.format("%02x", data[i] & 0xff));
        }
        return sb.toString();
    }

    private static byte[] fromHex(String hex) {
        int n = hex.length() / 2;
        byte[] out = new byte[n];
        for (int i = 0; i < n; i++) {
            out[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }

    private static String chunk(String s) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < s.length(); i += 64) {
            if (i > 0) sb.append('\n');
            sb.append(s.substring(i, Math.min(i + 64, s.length())));
        }
        return sb.toString();
    }

    private static final char[] B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".toCharArray();

    private static String b64(byte[] data) {
        StringBuilder sb = new StringBuilder(((data.length + 2) / 3) * 4);
        int i = 0;
        while (i + 3 <= data.length) {
            int n = ((data[i] & 0xff) << 16) | ((data[i + 1] & 0xff) << 8) | (data[i + 2] & 0xff);
            sb.append(B64[(n >> 18) & 63]).append(B64[(n >> 12) & 63])
                    .append(B64[(n >> 6) & 63]).append(B64[n & 63]);
            i += 3;
        }
        int rem = data.length - i;
        if (rem == 1) {
            int n = (data[i] & 0xff) << 16;
            sb.append(B64[(n >> 18) & 63]).append(B64[(n >> 12) & 63]).append("==");
        } else if (rem == 2) {
            int n = ((data[i] & 0xff) << 16) | ((data[i + 1] & 0xff) << 8);
            sb.append(B64[(n >> 18) & 63]).append(B64[(n >> 12) & 63])
                    .append(B64[(n >> 6) & 63]).append('=');
        }
        return sb.toString();
    }

    private static byte[] fromB64(String s) {
        int pad = 0;
        if (s.endsWith("==")) pad = 2;
        else if (s.endsWith("=")) pad = 1;
        int len = s.length();
        byte[] out = new byte[len / 4 * 3 - pad];
        int[] inv = new int[128];
        for (int i = 0; i < inv.length; i++) inv[i] = -1;
        for (int i = 0; i < B64.length; i++) inv[B64[i]] = i;
        int o = 0;
        for (int i = 0; i < len; i += 4) {
            int n = (inv[s.charAt(i)] << 18) | (inv[s.charAt(i + 1)] << 12)
                    | (s.charAt(i + 2) == '=' ? 0 : inv[s.charAt(i + 2)] << 6)
                    | (s.charAt(i + 3) == '=' ? 0 : inv[s.charAt(i + 3)]);
            if (o < out.length) out[o++] = (byte) ((n >> 16) & 0xff);
            if (o < out.length) out[o++] = (byte) ((n >> 8) & 0xff);
            if (o < out.length) out[o++] = (byte) (n & 0xff);
        }
        return out;
    }

    private UpdatePolicy() {}
}
