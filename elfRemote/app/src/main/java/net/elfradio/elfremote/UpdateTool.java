package net.elfradio.elfremote;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.Charset;

/** Root CLI: download, verify, install and confirm application/keeper health. */
public final class UpdateTool {
    private static final File DIR = new File("/data/local/elfremote");
    private static String deviceId = "";
    private static String token = "";
    private static String jobId = "";
    private static boolean managedUpdate;
    private static int targetCode;
    private static String targetName = "";

    public static void main(String[] args) {
        int rc = 2;
        try {
            rc = run(args);
        } catch (Throwable t) {
            System.err.println("update-tool error=" + t.getClass().getSimpleName());
            rc = 3;
            try {
                if (UpdatePolicy.ST_DOWNLOADING.equals(readState()) && !jobId.isEmpty()) {
                    android.util.AtomicFile retry = new android.util.AtomicFile(new File(DIR, "download-retries.json"));
                    JSONObject record = retry.getBaseFile().exists() ? new JSONObject(new String(retry.readFully(), "UTF-8")) : new JSONObject();
                    int count = jobId.equals(record.optString("job_id")) ? record.optInt("count") + 1 : 1;
                    FileOutputStream out = retry.startWrite();
                    try { out.write(new JSONObject().put("job_id", jobId).put("count", count).toString().getBytes("UTF-8")); retry.finishWrite(out); }
                    catch (Exception error) { retry.failWrite(out); throw error; }
                    progress(count >= 5 ? UpdatePolicy.ST_REJECTED : UpdatePolicy.ST_DOWNLOADING,
                            count >= 5 ? "download-failed" : "download-interrupted");
                    if (count >= 5) rc = 0;
                }
            } catch (Exception ignored) { System.err.println("update failure state pending"); }
        }
        System.exit(rc);
    }

    static int run(String[] args) throws Exception {
        if (args != null && args.length == 2 && "inspect".equals(args[0])) {
            PackageInfo archive = systemContext().getPackageManager().getPackageArchiveInfo(args[1], PackageManager.GET_SIGNATURES);
            if (archive == null || archive.signatures == null || archive.signatures.length != 1) throw new java.io.IOException("invalid APK archive");
            System.out.println(new JSONObject().put("package", archive.packageName).put("versionCode", archive.versionCode)
                    .put("versionName", archive.versionName).put("certSha256", UpdatePolicy.sha256Hex(archive.signatures[0].toByteArray())));
            return 0;
        }
        if (args == null || args.length < 2 || !"run".equals(args[0])) {
            System.err.println("usage: run job.json");
            return 2;
        }
        String rawJob = readFile(new File(args[1]));
        JSONObject job;
        try { job = new JSONObject(rawJob); }
        catch (org.json.JSONException malformed) { return rejectQueuedJob("bad-job"); }
        managedUpdate = job.optBoolean("managed_update_v1");
        String manRaw = job.optString("manifest_raw", "");
        String sig = job.optString("signature", "");
        deviceId = job.optString("device_id", "");
        token = job.optString("token", "");
        byte[] payload = manRaw.getBytes("UTF-8");
        if (!UpdatePolicy.verifySignature(UpdatePolicy.PUBLIC_KEY_PEM, payload, sig)) {
            return rejectQueuedJob("bad-signature");
        }
        JSONObject m = UpdatePolicy.parseManifest(manRaw);
        if (m == null) {
            return rejectQueuedJob("bad-manifest");
        }
        boolean signedExpired = UpdatePolicy.expired(m, System.currentTimeMillis());
        m = UpdatePolicy.executionManifest(m, job, deviceId, 0);
        if (m == null) return rejectQueuedJob("bad-task");
        jobId = m.getString("job_id");
        targetCode = m.getInt("versionCode"); targetName = m.getString("versionName");
        if (m.has("device_id") && !deviceId.equals(m.optString("device_id"))) {
            writeState(UpdatePolicy.ST_REJECTED, m.getInt("versionCode"), m.getString("versionName"), "wrong-device");
            progress(UpdatePolicy.ST_REJECTED, "wrong-device"); return 0;
        }
        boolean resuming = jobId.equals(readStateJobId()) && (UpdatePolicy.ST_INSTALLING.equals(readState())
                || UpdatePolicy.ST_WAIT_HEALTH.equals(readState()) || UpdatePolicy.ST_ROLLBACK.equals(readState())
                || UpdatePolicy.ST_RECOVERED.equals(readState()) || UpdatePolicy.ST_SUCCESS.equals(readState()));
        if ((signedExpired || UpdatePolicy.expired(m, System.currentTimeMillis())) && !resuming) {
            writeState(UpdatePolicy.ST_REJECTED, m.getInt("versionCode"), m.getString("versionName"), "expired");
            progress(UpdatePolicy.ST_REJECTED, "expired"); return 0;
        }
        writeUpdaterIdentity();
        int wantCode = m.getInt("versionCode");
        String wantName = m.getString("versionName");
        Context ctx = systemContext();
        PackageInfo cur = ctx.getPackageManager().getPackageInfo(UpdatePolicy.PKG, 0);
        boolean onTarget = UpdatePolicy.alreadyOnTarget(
                cur.versionName, cur.versionCode, wantName, wantCode);
        boolean healthOk = jobId.equals(readStateJobId()) && healthMatches(wantCode) && watchdogAlive();
        boolean lastGood = new File(UpdatePolicy.LAST_GOOD_APK).isFile();
        boolean keepBackup = UpdatePolicy.preserveBackup(jobId, readStateJobId(), readState(), lastGood);
        String act = UpdatePolicy.resumeAction(readState(), onTarget, healthOk, lastGood,
                readStateJobId(), jobId);
        if (UpdatePolicy.ST_SUCCESS.equals(act)) {
            writeState(UpdatePolicy.ST_SUCCESS, wantCode, wantName);
            progress(UpdatePolicy.ST_SUCCESS, "already-healthy");
            return 0;
        }
        if (UpdatePolicy.ST_RECOVERED.equals(act)) {
            PackageInfo backup = ctx.getPackageManager().getPackageArchiveInfo(UpdatePolicy.LAST_GOOD_APK, PackageManager.GET_SIGNATURES);
            if (backup == null || !UpdatePolicy.alreadyOnTarget(cur.versionName, cur.versionCode, backup.versionName, backup.versionCode))
                return doRollback(wantCode, wantName);
            String disk = readState();
            if (!UpdatePolicy.ST_ROLLBACK.equals(disk)
                    && !UpdatePolicy.ST_RECOVERED.equals(disk)) {
                progress(UpdatePolicy.ST_WAIT_HEALTH, "resume");
            }
            if (!UpdatePolicy.ST_RECOVERED.equals(disk)) {
                progress(UpdatePolicy.ST_ROLLBACK, "health-timeout");
            }
            writeState(UpdatePolicy.ST_RECOVERED, wantCode, wantName);
            progress(UpdatePolicy.ST_RECOVERED, "last-good");
            return 0;
        }
        if (UpdatePolicy.ST_WAIT_HEALTH.equals(act)) {
            return finishHealthOrRollback(wantCode, wantName, "already-on-target");
        }
        if (UpdatePolicy.ST_ROLLBACK.equals(act)) {
            return doRollback(wantCode, wantName);
        }
        File currentApk = new File(ctx.getPackageManager().getApplicationInfo(UpdatePolicy.PKG, 0).sourceDir);
        if (!UpdatePolicy.hasStagingSpace(DIR.getUsableSpace(), m.getLong("size"), currentApk.length())) {
            writeState(UpdatePolicy.ST_REJECTED, wantCode, wantName, "insufficient-storage");
            progress(UpdatePolicy.ST_REJECTED, "insufficient-storage");
            return 0;
        }
        File apk = new File(DIR, "pending.apk");
        boolean cached = apk.isFile() && apk.length() == m.getLong("size")
                && UpdatePolicy.apkMatches(readBytes(apk), m.getInt("size"), m.getString("sha256"));
        if (!cached) {
            android.net.ConnectivityManager manager = (android.net.ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
            android.net.Network network = manager.getActiveNetwork();
            android.net.NetworkCapabilities capabilities = network == null ? null : manager.getNetworkCapabilities(network);
            if (capabilities == null || !(capabilities.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI)
                    || capabilities.hasTransport(android.net.NetworkCapabilities.TRANSPORT_ETHERNET))) {
                if (!"waiting-wifi".equals(readStateObject().optString("detail"))) progress(UpdatePolicy.ST_DOWNLOADING, "waiting-wifi");
                return 75;
            }
            progress(UpdatePolicy.ST_DOWNLOADING, "");
            HttpJson.download(m.getString("url"), apk, m.getInt("size"), network);
        }
        byte[] bytes = readBytes(apk);
        progress(UpdatePolicy.ST_VERIFYING, "");
        if (!UpdatePolicy.apkMatches(bytes, m.getInt("size"), m.getString("sha256"))) {
            writeState(UpdatePolicy.ST_REJECTED, wantCode, wantName, "hash-mismatch");
            progress(UpdatePolicy.ST_REJECTED, "hash-mismatch");
            return 0;
        }
        String liveCert = certSha256(ctx);
        if (!m.getString("certSha256").equals(liveCert)) {
            writeState(UpdatePolicy.ST_REJECTED, wantCode, wantName, "cert-mismatch");
            progress(UpdatePolicy.ST_REJECTED, "cert-mismatch");
            return 0;
        }
        PackageInfo archive = ctx.getPackageManager().getPackageArchiveInfo(apk.getAbsolutePath(), PackageManager.GET_SIGNATURES);
        String archiveCert = archive != null && archive.signatures != null && archive.signatures.length == 1
                ? UpdatePolicy.sha256Hex(archive.signatures[0].toByteArray()) : "";
        if (archive == null || !UpdatePolicy.archiveMatches(m, archive.packageName, archive.versionCode, archive.versionName, archiveCert)) {
            writeState(UpdatePolicy.ST_REJECTED, wantCode, wantName, "apk-metadata-mismatch");
            progress(UpdatePolicy.ST_REJECTED, "apk-metadata-mismatch");
            return 0;
        }
        if (!keepBackup) backupLastGood();
        progress(UpdatePolicy.ST_INSTALLING, "");
        writeState(UpdatePolicy.ST_INSTALLING, wantCode, wantName);
        new File(DIR, "health.ok").delete();
        if (!installApk(apk.getAbsolutePath())) {
            progress(UpdatePolicy.ST_INSTALLING, "install-fail");
            return 8;
        }
        return finishHealthOrRollback(wantCode, wantName, "installed");
    }

    private static int finishHealthOrRollback(int wantCode, String wantName, String detail)
            throws Exception {
        writeState(UpdatePolicy.ST_WAIT_HEALTH, wantCode, wantName);
        progress(UpdatePolicy.ST_WAIT_HEALTH, detail);
        exec("am", "force-stop", UpdatePolicy.PKG);
        startMainApp();
        if (waitHealth(wantCode)) {
            writeState(UpdatePolicy.ST_SUCCESS, wantCode, wantName);
            progress(UpdatePolicy.ST_SUCCESS, "health-ok");
            return 0;
        }
        return doRollback(wantCode, wantName);
    }

    private static int doRollback(int wantCode, String wantName) throws Exception {
        progress(UpdatePolicy.ST_ROLLBACK, "health-timeout");
        writeState(UpdatePolicy.ST_ROLLBACK, wantCode, wantName);
        if (!installApk(UpdatePolicy.LAST_GOOD_APK)) {
            progress(UpdatePolicy.ST_ROLLBACK, "rollback-fail");
            return 9;
        }
        writeState(UpdatePolicy.ST_RECOVERED, wantCode, wantName);
        progress(UpdatePolicy.ST_RECOVERED, "last-good");
        exec("am", "force-stop", UpdatePolicy.PKG);
        startMainApp();
        return 0;
    }

    private static void startMainApp() {
        String command = android.os.Build.VERSION.SDK_INT >= 26 ? "start-foreground-service" : "startservice";
        exec("am", command, "--user", "0", "-n", UpdatePolicy.PKG + "/.ReportService");
    }

    private static boolean installApk(String path) {
        String pmOut = exec(UpdatePolicy.pmInstallArgv(path));
        if (pmOut != null && pmOut.contains("Success")) return true;
        System.out.println("package installer: " + pmOut);
        String sys = exec("sh", "-c",
                UpdatePolicy.systemInstallCommand(path));
        System.out.println("system installer: " + sys);
        if (sys == null || !sys.contains("SYS_OK")) return false;
        exec("reboot");
        return true;
    }

    private static void backupLastGood() throws Exception {
        String src = "/system/app/ElfRemote/ElfRemote.apk";
        String pathOut = exec("pm", "path", UpdatePolicy.PKG);
        if (pathOut != null) {
            int i = pathOut.indexOf("package:");
            if (i >= 0) {
                String p = pathOut.substring(i + 8).trim();
                int nl = p.indexOf('\n');
                if (nl > 0) p = p.substring(0, nl).trim();
                if (p.length() > 0) src = p;
            }
        }
        if (!src.startsWith("/") || src.contains("'") || src.contains("\n") || src.contains("\r")) throw new java.io.IOException("backup source invalid");
        String copied = exec("sh", "-c", "set -e; cp '" + src + "' " + UpdatePolicy.LAST_GOOD_APK + ".new"
                + "; chmod 0660 " + UpdatePolicy.LAST_GOOD_APK + ".new"
                + "; cmp '" + src + "' " + UpdatePolicy.LAST_GOOD_APK + ".new"
                + "; sync; mv " + UpdatePolicy.LAST_GOOD_APK + ".new " + UpdatePolicy.LAST_GOOD_APK + "; sync; echo BACKUP_OK");
        if (copied == null || !copied.contains("BACKUP_OK")) throw new java.io.IOException("backup failed");
    }

    private static boolean waitHealth(int wantCode) {
        File health = new File(DIR, "health.ok");
        long start = System.currentTimeMillis();
        while (!UpdatePolicy.healthTimedOut(start, System.currentTimeMillis(),
                UpdatePolicy.HEALTH_TIMEOUT_MS)) {
            try {
                if (health.isFile()) {
                    String t = readFile(health).trim();
                    if (t.equals(String.valueOf(wantCode)) && watchdogAlive()) return true;
                }
                Thread.sleep(2000);
            } catch (Exception e) {
                return false;
            }
        }
        return false;
    }

    private static Context systemContext() throws Exception {
        try {
            Class.forName("android.os.Looper").getMethod("prepareMainLooper").invoke(null);
        } catch (Exception e) { /* already prepared */ }
        Object at = Class.forName("android.app.ActivityThread").getMethod("systemMain").invoke(null);
        return (Context) at.getClass().getMethod("getSystemContext").invoke(at);
    }

    @SuppressWarnings("deprecation")
    private static String certSha256(Context ctx) throws Exception {
        PackageInfo pi = ctx.getPackageManager().getPackageInfo(
                UpdatePolicy.PKG, PackageManager.GET_SIGNATURES);
        Signature[] sigs = pi.signatures;
        if (sigs == null || sigs.length == 0) return "";
        return UpdatePolicy.sha256Hex(sigs[0].toByteArray());
    }

    private static void progress(String state, String detail) throws Exception {
        if (targetCode > 0) writeState(state, targetCode, targetName, detail);
        JSONObject body = new JSONObject();
        try {
            body.put("device_id", deviceId);
            body.put("token", token);
            body.put("job_id", jobId);
            body.put("state", state);
            body.put("detail", detail == null ? "" : detail);
        } catch (Exception e) {
            System.err.println("progress build " + state);
            return;
        }
        String payload = body.toString();
        for (int i = 0; i < 3; i++) {
            try {
                JSONObject reply = new JSONObject(HttpJson.post(Protocol.updateProgressPath(), payload));
                JSONObject accepted = reply.optJSONObject("update");
                if (!reply.optBoolean("ok") || accepted == null || !jobId.equals(accepted.optString("job_id"))
                        || !state.equals(accepted.optString("state"))) throw new java.io.IOException("progress-not-accepted");
                System.out.println("update-tool state=" + state);
                return;
            } catch (Exception e) {
                System.err.println("progress " + state + " try=" + i);
                try {
                    Thread.sleep(1000);
                } catch (InterruptedException ie) {
                    break;
                }
            }
        }
        System.out.println("update-tool state=" + state + " unsent");
    }

    private static void writeState(String state, int code, String name) throws Exception {
        writeState(state, code, name, "");
    }

    private static int rejectQueuedJob(String detail) throws Exception {
        JSONObject previous = readStateObject();
        if (!UpdatePolicy.ST_CLAIMED.equals(previous.optString("state"))) return 0;
        jobId = previous.getString("job_id");
        managedUpdate = previous.optBoolean("managed_update_v1");
        writeState(UpdatePolicy.ST_REJECTED, previous.optInt("versionCode"), previous.optString("versionName"), detail);
        return 0;
    }

    private static void writeState(String state, int code, String name, String detail) throws Exception {
        JSONObject o = new JSONObject();
        o.put("job_id", jobId);
        o.put("managed_update_v1", managedUpdate);
        o.put("state", state);
        o.put("versionCode", code);
        o.put("versionName", name);
        o.put("detail", detail);
        File f = new File(DIR, "update.state");
        android.util.AtomicFile atomic = new android.util.AtomicFile(f);
        FileOutputStream out = null;
        try {
            out = atomic.startWrite();
            out.write(o.toString().getBytes("UTF-8"));
            atomic.finishWrite(out);
        } catch (Exception error) {
            if (out != null) atomic.failWrite(out);
            throw error;
        }
    }

    private static JSONObject readStateObject() throws Exception {
        File f = new File(DIR, "update.state");
        if (!f.exists() && !new File(f.getPath() + ".bak").exists()) return new JSONObject();
        return new JSONObject(new String(new android.util.AtomicFile(f).readFully(), "UTF-8"));
    }

    private static String readState() throws Exception { return readStateObject().optString("state", ""); }
    private static String readStateJobId() throws Exception { return readStateObject().optString("job_id", ""); }

    private static boolean healthMatches(int wantCode) {
        try {
            File f = new File(DIR, "health.ok");
            if (!f.isFile()) return false;
            return readFile(f).trim().equals(String.valueOf(wantCode));
        } catch (Exception e) {
            return false;
        }
    }

    // Root owns the keeper check; Android app processes may not see root /proc entries.
    private static boolean watchdogAlive() {
        try {
            String pid = readFile(new File(DIR, "watchdog.pid")).trim();
            if (!pid.matches("[1-9][0-9]{0,8}")) return false;
            byte[] command = new byte[4096];
            try (FileInputStream in = new FileInputStream("/proc/" + pid + "/cmdline")) {
                int count = in.read(command);
                if (count <= 0) return false;
                for (String argument : new String(command, 0, count, "UTF-8").split("\u0000"))
                    if ("/data/local/elfremote/watchdog.sh".equals(argument)) return true;
            }
        } catch (Exception error) { System.err.println("watchdog check: " + error.getClass().getSimpleName()); }
        return false;
    }

    private static void writeUpdaterIdentity() throws Exception {
        android.util.AtomicFile file = new android.util.AtomicFile(new File(DIR, "updater.ok"));
        FileOutputStream out = file.startWrite();
        try {
            out.write((android.os.Process.myPid() + "\n").getBytes("UTF-8"));
            file.finishWrite(out);
        } catch (Exception error) {
            file.failWrite(out); throw error;
        }
    }

    private static String exec(String... argv) {
        try {
            ProcessBuilder pb = new ProcessBuilder(argv);
            pb.redirectErrorStream(true);
            Process p = pb.start();
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            InputStream in = p.getInputStream();
            byte[] buf = new byte[256];
            int n;
            while ((n = in.read(buf)) >= 0) bos.write(buf, 0, n);
            p.waitFor();
            return bos.toString("UTF-8");
        } catch (Exception e) {
            return null;
        }
    }

    private static String readFile(File f) throws Exception {
        return new String(readBytes(f), Charset.forName("UTF-8"));
    }

    private static byte[] readBytes(File f) throws Exception {
        FileInputStream in = new FileInputStream(f);
        try {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) >= 0) bos.write(buf, 0, n);
            return bos.toByteArray();
        } finally {
            in.close();
        }
    }

    private UpdateTool() {}
}
