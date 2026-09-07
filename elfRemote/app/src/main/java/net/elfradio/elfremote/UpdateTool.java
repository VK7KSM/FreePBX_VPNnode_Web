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

/** Root CLI: download, verify, install. Health success is decided by the main app. */
public final class UpdateTool {
    private static final File DIR = new File("/data/local/elfremote");
    private static String deviceId = "";
    private static String token = "";
    private static String jobId = "";

    public static void main(String[] args) {
        int rc = 2;
        try {
            rc = run(args);
        } catch (Throwable t) {
            System.err.println("update-tool " + t);
            rc = 3;
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
        JSONObject job = new JSONObject(rawJob);
        String manRaw = job.getString("manifest_raw");
        String sig = job.getString("signature");
        deviceId = job.optString("device_id", "");
        token = job.optString("token", "");
        byte[] payload = manRaw.getBytes("UTF-8");
        if (!UpdatePolicy.verifySignature(UpdatePolicy.PUBLIC_KEY_PEM, payload, sig)) {
            progress(UpdatePolicy.ST_CLAIMED, "bad-signature");
            return 4;
        }
        JSONObject m = UpdatePolicy.parseManifest(manRaw);
        if (m == null || UpdatePolicy.expired(m, System.currentTimeMillis())) {
            progress(UpdatePolicy.ST_CLAIMED, "bad-manifest");
            return 5;
        }
        jobId = m.getString("job_id");
        writeFlag("updater.ok");
        int wantCode = m.getInt("versionCode");
        String wantName = m.getString("versionName");
        Context ctx = systemContext();
        PackageInfo cur = ctx.getPackageManager().getPackageInfo(UpdatePolicy.PKG, 0);
        boolean onTarget = UpdatePolicy.alreadyOnTarget(
                cur.versionName, cur.versionCode, wantName, wantCode);
        boolean healthOk = healthMatches(wantCode);
        boolean lastGood = new File(UpdatePolicy.LAST_GOOD_APK).isFile();
        String act = UpdatePolicy.resumeAction(readState(), onTarget, healthOk, lastGood,
                readStateJobId(), jobId);
        if (UpdatePolicy.ST_SUCCESS.equals(act)) {
            progress(UpdatePolicy.ST_SUCCESS, "already-healthy");
            return 0;
        }
        if (UpdatePolicy.ST_RECOVERED.equals(act)) {
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
        progress(UpdatePolicy.ST_CLAIMED, "");
        progress(UpdatePolicy.ST_DOWNLOADING, "");
        File apk = new File(DIR, "pending.apk");
        HttpJson.download(m.getString("url"), apk, m.getInt("size"));
        byte[] bytes = readBytes(apk);
        progress(UpdatePolicy.ST_VERIFYING, "");
        if (!UpdatePolicy.apkMatches(bytes, m.getInt("size"), m.getString("sha256"))) {
            writeState(UpdatePolicy.ST_REJECTED, wantCode, wantName);
            progress(UpdatePolicy.ST_REJECTED, "hash-mismatch");
            return 0;
        }
        String liveCert = certSha256(ctx);
        if (!m.getString("certSha256").equals(liveCert)) {
            writeState(UpdatePolicy.ST_REJECTED, wantCode, wantName);
            progress(UpdatePolicy.ST_REJECTED, "cert-mismatch");
            return 0;
        }
        PackageInfo archive = ctx.getPackageManager().getPackageArchiveInfo(apk.getAbsolutePath(), PackageManager.GET_SIGNATURES);
        String archiveCert = archive != null && archive.signatures != null && archive.signatures.length == 1
                ? UpdatePolicy.sha256Hex(archive.signatures[0].toByteArray()) : "";
        if (archive == null || !UpdatePolicy.archiveMatches(m, archive.packageName, archive.versionCode, archive.versionName, archiveCert)) {
            writeState(UpdatePolicy.ST_REJECTED, wantCode, wantName);
            progress(UpdatePolicy.ST_REJECTED, "apk-metadata-mismatch");
            return 0;
        }
        progress(UpdatePolicy.ST_INSTALLING, "");
        backupLastGood();
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
        if (waitHealth(wantCode)) return 0;
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
        return 0;
    }

    private static boolean installApk(String path) {
        String pmOut = exec(UpdatePolicy.pmInstallArgv(path));
        if (pmOut != null && pmOut.contains("Success")) return true;
        String sys = exec("sh", "-c",
                UpdatePolicy.systemInstallCommand(path));
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
                    if (t.equals(String.valueOf(wantCode))) return true;
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

    private static void progress(String state, String detail) {
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
                HttpJson.post(Protocol.updateProgressPath(), payload);
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
        JSONObject o = new JSONObject();
        o.put("job_id", jobId);
        o.put("state", state);
        o.put("versionCode", code);
        o.put("versionName", name);
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

    private static String readState() {
        try {
            File f = new File(DIR, "update.state");
            return new JSONObject(new String(new android.util.AtomicFile(f).readFully(), "UTF-8")).optString("state", "");
        } catch (Exception e) {
            return "";
        }
    }

    private static String readStateJobId() {
        try {
            File f = new File(DIR, "update.state");
            return new JSONObject(new String(new android.util.AtomicFile(f).readFully(), "UTF-8")).optString("job_id", "");
        } catch (Exception e) {
            return "";
        }
    }

    private static boolean healthMatches(int wantCode) {
        try {
            File f = new File(DIR, "health.ok");
            if (!f.isFile()) return false;
            return readFile(f).trim().equals(String.valueOf(wantCode));
        } catch (Exception e) {
            return false;
        }
    }

    private static void writeFlag(String name) throws Exception {
        File f = new File(DIR, name);
        FileOutputStream out = new FileOutputStream(f);
        try {
            out.write("1\n".getBytes("UTF-8"));
        } finally {
            out.close();
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
