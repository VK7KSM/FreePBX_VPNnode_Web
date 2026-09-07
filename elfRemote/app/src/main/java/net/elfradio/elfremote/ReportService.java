package net.elfradio.elfremote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.location.Location;
import android.location.LocationManager;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Process;

import org.json.JSONObject;

public final class ReportService extends Service {
    static final String ACTION_REPORT_NOW = "net.elfradio.elfremote.REPORT_NOW";
    static final String ACTION_RENEW = "net.elfradio.elfremote.RENEW";
    static final String ACTION_LAB_DNS = "net.elfradio.elfremote.LAB_DNS";
    private static final String CHANNEL = WatchdogPolicy.NOTIFY_CHANNEL;
    private final Handler mainHandler = new Handler();
    private HandlerThread workerThread;
    private Handler worker;
    private PairingStore store;
    private NetworkHealer healer;
    private boolean loopStarted;
    private String lastNotifyText = "";
    private int reportFailures;

    private final Runnable loop = new Runnable() {
        @Override
        public void run() {
            tick();
            long delay = store.paired()
                    ? WatchdogPolicy.pairedReportIntervalMs()
                    : WatchdogPolicy.unpairedReportIntervalMs();
            if (BuildConfig.STATUS_ONLY) delay = StatusReporter.retryDelay(delay, reportFailures);
            RuntimeLog.event("next_report delay_ms=" + delay);
            if (worker != null) worker.postDelayed(this, delay);
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        store = new PairingStore(this);
        if (!BuildConfig.STATUS_ONLY) healer = new NetworkHealer(this, store);
        RuntimeLog.event("service_start status_only=" + BuildConfig.STATUS_ONLY);
        startForeground(7, buildNotification());
        lastNotifyText = notifyText();
        if (workerThread == null) {
            workerThread = new HandlerThread("elfremote-net", Process.THREAD_PRIORITY_BACKGROUND);
            workerThread.start();
            worker = new Handler(workerThread.getLooper());
        }
        if (!loopStarted) {
            loopStarted = true;
            worker.post(loop);
        }
        if (!BuildConfig.STATUS_ONLY) WatchdogInstaller.ensure(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_RENEW.equals(intent.getAction())) {
            store.clearEnroll();
            store.setLastStatus("正在重新获取配对码");
        }
        if (!BuildConfig.STATUS_ONLY && intent != null && ACTION_LAB_DNS.equals(intent.getAction())) {
            if (worker != null) {
                final String dns = intent.getStringExtra("dns");
                final String ipv4 = intent.getStringExtra("ipv4");
                final String gw = intent.getStringExtra("gw");
                worker.post(() -> applyLabDns(dns, ipv4, gw));
            }
        }
        if (intent != null && (ACTION_REPORT_NOW.equals(intent.getAction())
                || ACTION_RENEW.equals(intent.getAction()))) {
            if (worker != null) worker.post(this::tick);
        }
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        RuntimeLog.event("service_stop");
        if (worker != null) worker.removeCallbacks(loop);
        if (workerThread != null) {
            workerThread.quit();
            workerThread = null;
            worker = null;
        }
        super.onDestroy();
    }

    private void applyLabDns(String dns, String ipv4, String gw) {
        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) == 0) {
            return;
        }
        String cmd = "dhcp".equals(dns)
                ? HealPolicy.wifiToolCmd("dhcp", "", "", "")
                : HealPolicy.wifiToolCmd("static", ipv4, gw, dns);
        boolean ok = cmd.length() > 0 && healer.runPrivileged(cmd);
        android.util.Log.i("elfRemote", "lab-dns dns=" + dns + " result=" + (ok ? "ok" : "fail"));
    }

    private void tick() {
        try {
            if (!store.paired()) enrollOrPoll();
            else reportCurrent();
            reportFailures = 0;
        } catch (Exception e) {
            reportFailures = Math.min(10, reportFailures + 1);
            RuntimeLog.error("report_failed", e);
            android.util.Log.w("elfRemote", "tick failed", e);
            store.setLastStatus(Protocol.formatNetError(e));
        }
        maybeNotify();
    }

    private String notifyText() {
        return store.paired()
                ? getString(R.string.notify_online)
                : getString(R.string.notify_waiting);
    }

    private void maybeNotify() {
        final String text = notifyText();
        if (text.equals(lastNotifyText)) return;
        lastNotifyText = text;
        mainHandler.post(() -> startForeground(7, buildNotification()));
    }

    private void enrollOrPoll() throws Exception {
        if (store.code().length() != 6 || store.enrollId().length() == 0) {
            JSONObject body = new JSONObject();
            body.put("token_sha256", store.tokenSha256());
            body.put("app_version", Protocol.appVersion());
            body.put("os_version", "Android " + Build.VERSION.RELEASE);
            body.put("model_hint", "D22");
            JSONObject res = Protocol.parseObject(HttpJson.post(Protocol.enrollPath(), body.toString()));
            if (!Protocol.isOk(res)) {
                store.setLastStatus(res.optString("msg", "申请配对码失败"));
                return;
            }
            store.saveEnroll(
                    res.getString("code"),
                    res.getString("enroll_id"),
                    Protocol.parseIsoMillis(res.optString("expires_at", "")));
            store.setLastStatus(getString(R.string.how_to_pair));
            return;
        }
        JSONObject res = Protocol.parseObject(HttpJson.get(
                Protocol.enrollStatusPath(store.code(), store.enrollId())));
        if (Protocol.isOk(res) && res.optBoolean("paired", false)) {
            store.savePaired(res.getString("device_id"));
            store.setLastStatus(getString(R.string.paired));
            reportCurrent();
        } else {
            store.setLastStatus(getString(R.string.how_to_pair));
        }
    }

    private void reportCurrent() throws Exception {
        if (BuildConfig.STATUS_ONLY) reportStatus();
        else report();
    }

    private void reportStatus() throws Exception {
        JSONObject body = new JSONObject();
        body.put("device_id", store.deviceId());
        body.put("report_id", java.util.UUID.randomUUID().toString());
        long now = System.currentTimeMillis();
        java.text.SimpleDateFormat time = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US);
        time.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
        body.put("reported_at", time.format(new java.util.Date(now)));
        body.put("queued_at_ms", now);
        body.put("app_version", Protocol.appVersion());
        body.put("os_version", "Android " + Build.VERSION.RELEASE);
        body.put("network", networkType());
        body.put("battery", batteryPct());
        body.put("ready", true);
        JSONObject location = gpsFix();
        if (location != null) body.put("gps", location);
        else body.put("location_reason", "no_cached_location");
        java.io.File directory = new java.io.File(getFilesDir(), "status-outbox/" + PairingStore.sha256Hex(store.deviceId()));
        StatusOutbox outbox = new StatusOutbox(directory, 512);
        outbox.add(body);
        RuntimeLog.event("status_queued network=" + networkType() + " count=" + outbox.entries().length + " log_failed=" + RuntimeLog.failed());
        int sent = new StatusReporter(outbox, json -> HttpJson.post(Protocol.reportPath(), json)).flush(store.token());
        store.setLastStatus(sent > 0 ? "已上报" : "等待上报");
    }

    private void report() throws Exception {
        String pre = healer.maybeHeal(false);
        if ("L1".equals(pre)) {
            store.setLastStatus("自愈L1 物理断网");
            return;
        }
        JSONObject body = new JSONObject();
        body.put("device_id", store.deviceId());
        body.put("token", store.token());
        body.put("app_version", Protocol.appVersion());
        body.put("os_version", "Android " + Build.VERSION.RELEASE);
        body.put("network", networkType());
        body.put("battery", batteryPct());
        body.put("ready", true);
        JSONObject gps = gpsFix();
        if (gps != null) body.put("gps", gps);
        JSONObject res;
        try {
            res = Protocol.parseObject(HttpJson.post(Protocol.reportPath(), body.toString()));
        } catch (Exception e) {
            String stage = healer.maybeHeal(true);
            store.setLastStatus("上报失败后自愈" + stage);
            res = Protocol.parseObject(HttpJson.post(Protocol.reportPath(), body.toString()));
        }
        if (Protocol.isOk(res)) {
            healer.saveSnapshot(healer.observe());
            store.setLastStatus("已上报");
            maybeQueueUpdate(res.optJSONObject("update"));
            maybeRunTask(res.optJSONObject("task"));
            maybeFinishHealth();
        } else {
            String stage = healer.maybeHeal(true);
            store.setLastStatus(res.optString("msg", "上报失败") + " 自愈" + stage);
        }
    }

    private void maybeQueueUpdate(JSONObject upd) {
        if (upd == null) return;
        String raw = upd.optString("manifest_raw", "");
        String sig = upd.optString("signature", "");
        JSONObject m = UpdatePolicy.parseManifest(raw);
        if (m == null) return;
        if (!UpdatePolicy.verifySignature(UpdatePolicy.PUBLIC_KEY_PEM, raw.getBytes(java.nio.charset.Charset.forName("UTF-8")), sig)) {
            return;
        }
        try {
            JSONObject job = new JSONObject();
            job.put("manifest_raw", raw);
            job.put("signature", sig);
            job.put("device_id", store.deviceId());
            job.put("token", store.token());
            java.io.File dir = new java.io.File("/data/local/elfremote");
            java.io.File json = new java.io.File(dir, "update.job.json");
            java.io.FileOutputStream out = new java.io.FileOutputStream(json);
            try {
                out.write(job.toString().getBytes("UTF-8"));
            } finally {
                out.close();
            }
            String src = getApplicationInfo().sourceDir;
            if (src != null && src.length() > 0) {
                copyFile(new java.io.File(src), new java.io.File(dir, "updater.apk"));
            }
            JSONObject fresh = new JSONObject();
            fresh.put("job_id", m.optString("job_id", ""));
            fresh.put("state", UpdatePolicy.ST_CLAIMED);
            fresh.put("versionCode", m.optInt("versionCode", 0));
            fresh.put("versionName", m.optString("versionName", ""));
            java.io.File statef = new java.io.File(dir, "update.state");
            java.io.FileOutputStream stOut = new java.io.FileOutputStream(statef);
            try {
                stOut.write(fresh.toString().getBytes("UTF-8"));
            } finally {
                stOut.close();
            }
            java.io.File sh = new java.io.File(dir, "update.job");
            java.io.FileOutputStream shOut = new java.io.FileOutputStream(sh);
            try {
                shOut.write(UpdatePolicy.jobShell(json.getAbsolutePath()).getBytes("UTF-8"));
            } finally {
                shOut.close();
            }
            sh.setExecutable(true, false);
        } catch (Exception e) {
            android.util.Log.w("elfRemote", "queue update failed " + e.getMessage());
        }
    }

    private void maybeRunTask(JSONObject offer) {
        if (offer == null) return;
        String id = offer.optString("id", "");
        if (id.length() == 0) return;
        String lastId = readLastTaskId();
        String phase = readTaskPhase();
        if (RepairPolicy.alreadyDone(lastId, phase, id)) return;
        if (RepairPolicy.shouldConfirmReboot(lastId, phase, id, readArmedBoot(), readBootId())) {
            try {
                org.json.JSONObject result = new org.json.JSONObject();
                result.put("stage", "reboot");
                result.put("action", "confirmed");
                postTask(id, RepairPolicy.ST_SUCCESS, "rebooted", result);
                writeLastTaskId(id);
                writeTaskPhase(RepairPolicy.PHASE_DONE);
                store.setLastStatus("修机成功 受控重启");
                android.util.Log.i("elfRemote", "task reboot confirmed");
            } catch (Exception e) {
                android.util.Log.w("elfRemote", "task reboot confirm " + e.getMessage());
            }
            return;
        }
        if (RepairPolicy.shouldConfirmInstall(lastId, phase, id, Protocol.appVersion(), readWantName())) {
            try {
                org.json.JSONObject result = new org.json.JSONObject();
                result.put("stage", "install");
                result.put("action", "confirmed");
                result.put("text", Protocol.appVersion());
                postTask(id, RepairPolicy.ST_SUCCESS, Protocol.appVersion(), result);
                writeLastTaskId(id);
                writeTaskPhase(RepairPolicy.PHASE_DONE);
                store.setLastStatus("修机成功 覆盖安装 " + Protocol.appVersion());
                android.util.Log.i("elfRemote", "task install_apk confirmed " + Protocol.appVersion());
            } catch (Exception e) {
                android.util.Log.w("elfRemote", "task install confirm " + e.getMessage());
            }
            return;
        }
        if (RepairPolicy.PHASE_INSTALLING.equals(phase) && id.equals(lastId)) {
            String rc = readHealRc();
            if (rc.length() > 0 && !"0".equals(rc)) {
                try {
                    postTask(id, RepairPolicy.ST_FAILED, "install-rc=" + rc, null);
                    writeLastTaskId(id);
                    writeTaskPhase(RepairPolicy.PHASE_DONE);
                    android.util.Log.w("elfRemote", "task install_apk rc=" + rc);
                } catch (Exception e) {
                    android.util.Log.w("elfRemote", "task install fail-post " + e.getMessage());
                }
            }
            return;
        }
        String reason = RepairPolicy.rejectReason(offer, System.currentTimeMillis());
        try {
            if (reason.length() > 0) {
                postTask(id, RepairPolicy.ST_REJECTED, reason, null);
                writeLastTaskId(id);
                writeTaskPhase(RepairPolicy.PHASE_DONE);
                return;
            }
            String type = offer.optString("type", "");
            postTask(id, RepairPolicy.ST_CLAIMED, "claimed", null);
            postTask(id, RepairPolicy.ST_RUNNING, type, null);
            if (RepairPolicy.TYPE_REBOOT.equals(type)) {
                writeLastTaskId(id);
                writeTaskPhase(RepairPolicy.PHASE_RUNNING);
                writeArmedBoot(readBootId());
                android.util.Log.i("elfRemote", "task reboot armed");
                armReboot();
                return;
            }
            if (RepairPolicy.TYPE_RESTART_ADBD.equals(type)) {
                armHealCmd(RepairPolicy.adbdCommand());
                String rc = waitHealRc(45000L);
                String out = readHealOut();
                if (!"0".equals(rc)) {
                    postTask(id, RepairPolicy.ST_FAILED, "adbd-rc=" + rc, null);
                    writeLastTaskId(id);
                    writeTaskPhase(RepairPolicy.PHASE_DONE);
                    return;
                }
                org.json.JSONObject result = new org.json.JSONObject();
                result.put("stage", "adbd");
                result.put("action", out.contains("PORT=5555") ? "loopback" : "unknown");
                result.put("text", out.length() > 1500 ? out.substring(0, 1500) : out);
                postTask(id, RepairPolicy.ST_SUCCESS, "adbd-5555", result);
                writeLastTaskId(id);
                writeTaskPhase(RepairPolicy.PHASE_DONE);
                store.setLastStatus("修机成功 重启本机adbd");
                android.util.Log.i("elfRemote", "task restart_adbd " + result.optString("action"));
                return;
            }
            if (RepairPolicy.TYPE_INSTALL_APK.equals(type)) {
                org.json.JSONObject params = RepairPolicy.parseInstallParams(offer.optJSONObject("params"));
                if (params == null) {
                    postTask(id, RepairPolicy.ST_REJECTED, "bad-params", null);
                    writeLastTaskId(id);
                    writeTaskPhase(RepairPolicy.PHASE_DONE);
                    return;
                }
                String want = params.optString("versionName", "");
                if (RepairPolicy.alreadyOnTarget(Protocol.appVersion(), want)) {
                    org.json.JSONObject result = new org.json.JSONObject();
                    result.put("stage", "install");
                    result.put("action", "already");
                    result.put("text", want);
                    postTask(id, RepairPolicy.ST_SUCCESS, want, result);
                    writeLastTaskId(id);
                    writeTaskPhase(RepairPolicy.PHASE_DONE);
                    return;
                }
                java.io.File apk = new java.io.File(RepairPolicy.TASK_APK);
                HttpJson.download(params.optString("url", ""), apk);
                apk.setReadable(true, false);
                byte[] raw = readAll(apk);
                if (!UpdatePolicy.apkMatches(raw, params.optInt("size", 0), params.optString("sha256", ""))) {
                    postTask(id, RepairPolicy.ST_REJECTED, "hash-mismatch", null);
                    writeLastTaskId(id);
                    writeTaskPhase(RepairPolicy.PHASE_DONE);
                    return;
                }
                writeLastTaskId(id);
                writeTaskPhase(RepairPolicy.PHASE_INSTALLING);
                writeSmall(RepairPolicy.WANT_FILE, want);
                android.util.Log.i("elfRemote", "task install_apk armed " + want);
                armHealCmd(RepairPolicy.installCommand());
                return;
            }
            if (RepairPolicy.TYPE_HEAL_NETWORK.equals(type)) {
                String stage = healer.maybeHeal(false);
                HealPolicy.Facts f = healer.observe();
                HealPolicy.Snapshot snap = HealPolicy.Snapshot.parse(store.netSnap());
                HealPolicy.Decision d = HealPolicy.decide(f, snap);
                org.json.JSONObject result = new org.json.JSONObject();
                result.put("stage", stage);
                result.put("action", d.action);
                result.put("reason", d.reason);
                postTask(id, RepairPolicy.ST_SUCCESS, stage, result);
                writeLastTaskId(id);
                writeTaskPhase(RepairPolicy.PHASE_DONE);
                store.setLastStatus("修机成功 强制自愈 " + stage);
                android.util.Log.i("elfRemote", "task heal_network stage=" + stage
                        + " action=" + d.action + " reason=" + d.reason);
                return;
            }
            java.util.LinkedHashMap<String, String> files = new java.util.LinkedHashMap<String, String>();
            String[] paths = RepairPolicy.LOG_PATHS;
            for (int i = 0; i < paths.length; i++) {
                addLogFile(files, new java.io.File(paths[i]));
            }
            addLogFile(files, new java.io.File(getFilesDir(), "heal.log"));
            RepairPolicy.Pack pack = RepairPolicy.packLogs(files, readLogcat(), Protocol.appVersion());
            org.json.JSONObject result = new org.json.JSONObject();
            result.put("sha256", pack.sha256);
            result.put("bytes", pack.size);
            result.put("truncated", pack.truncated);
            result.put("text", pack.text);
            postTask(id, RepairPolicy.ST_SUCCESS, "packed", result);
            writeLastTaskId(id);
            writeTaskPhase(RepairPolicy.PHASE_DONE);
            store.setLastStatus("修机成功 拉取日志");
            android.util.Log.i("elfRemote", "task pull_logs bytes=" + pack.size
                    + " truncated=" + pack.truncated + " sha=" + pack.sha256);
        } catch (Exception e) {
            try {
                postTask(id, RepairPolicy.ST_FAILED, Protocol.formatNetError(e), null);
            } catch (Exception e2) {
                android.util.Log.w("elfRemote", "task fail-post " + e2.getMessage());
            }
            writeLastTaskId(id);
            writeTaskPhase(RepairPolicy.PHASE_DONE);
            android.util.Log.w("elfRemote", "task failed " + e.getMessage());
        }
    }

    private void armReboot() throws Exception {
        armHealCmd(RepairPolicy.rebootCommand());
    }

    private void armHealCmd(String cmd) throws Exception {
        java.io.File dir = new java.io.File("/data/local/elfremote");
        java.io.File tmp = new java.io.File(dir, "heal.cmd.tmp");
        java.io.FileOutputStream out = new java.io.FileOutputStream(tmp);
        try {
            out.write((cmd + "\n").getBytes("UTF-8"));
        } finally {
            out.close();
        }
        java.io.File rcf = new java.io.File(dir, "heal.rc");
        if (rcf.exists()) rcf.delete();
        java.io.File cmdf = new java.io.File(dir, "heal.cmd");
        if (cmdf.exists() && !cmdf.delete()) {
            throw new Exception("heal-cmd-stale");
        }
        if (!tmp.renameTo(cmdf)) throw new Exception("heal-arm-fail");
    }

    private String waitHealRc(long timeoutMs) {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            String rc = readHealRc();
            if (rc.length() > 0) return rc;
            try { Thread.sleep(250); } catch (InterruptedException e) { return ""; }
        }
        return "";
    }

    private String readHealOut() {
        try {
            java.io.File f = new java.io.File("/data/local/elfremote/heal.out");
            if (!f.isFile()) return "";
            String t = readSmallCapped(f, 1500);
            return t == null ? "" : t;
        } catch (Exception e) {
            return "";
        }
    }

    private String readHealRc() {
        try {
            java.io.File f = new java.io.File("/data/local/elfremote/heal.rc");
            if (!f.isFile()) return "";
            return readSmall(f).trim();
        } catch (Exception e) {
            return "";
        }
    }

    private String readWantName() {
        try {
            java.io.File f = new java.io.File(RepairPolicy.WANT_FILE);
            if (!f.isFile()) return "";
            return readSmall(f).trim();
        } catch (Exception e) {
            return "";
        }
    }

    private static byte[] readAll(java.io.File f) throws Exception {
        java.io.FileInputStream in = new java.io.FileInputStream(f);
        try {
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) >= 0) bos.write(buf, 0, n);
            return bos.toByteArray();
        } finally {
            in.close();
        }
    }

    private void postTask(String taskId, String state, String detail, org.json.JSONObject result)
            throws Exception {
        org.json.JSONObject body = new org.json.JSONObject();
        body.put("device_id", store.deviceId());
        body.put("token", store.token());
        body.put("task_id", taskId);
        body.put("state", state);
        body.put("detail", detail == null ? "" : detail);
        if (result != null) body.put("result", result);
        String payload = body.toString();
        Exception last = null;
        for (int i = 0; i < 3; i++) {
            try {
                HttpJson.post(Protocol.taskProgressPath(), payload);
                return;
            } catch (Exception e) {
                last = e;
            }
        }
        throw last;
    }

    private String readLastTaskId() {
        try {
            java.io.File f = new java.io.File(RepairPolicy.LAST_TASK_FILE);
            if (!f.isFile()) return "";
            return readSmall(f).trim();
        } catch (Exception e) {
            return "";
        }
    }

    private void writeLastTaskId(String id) {
        try {
            java.io.File f = new java.io.File(RepairPolicy.LAST_TASK_FILE);
            java.io.FileOutputStream out = new java.io.FileOutputStream(f);
            try {
                out.write((id + "\n").getBytes("UTF-8"));
            } finally {
                out.close();
            }
        } catch (Exception e) {
            android.util.Log.w("elfRemote", "task.last " + e.getMessage());
        }
    }

    private String readTaskPhase() {
        try {
            java.io.File f = new java.io.File(RepairPolicy.PHASE_FILE);
            if (!f.isFile()) return "";
            return readSmall(f).trim();
        } catch (Exception e) {
            return "";
        }
    }

    private void writeTaskPhase(String phase) {
        writeSmall(RepairPolicy.PHASE_FILE, phase);
    }

    private String readArmedBoot() {
        try {
            java.io.File f = new java.io.File(RepairPolicy.BOOT_FILE);
            if (!f.isFile()) return "";
            return readSmall(f).trim();
        } catch (Exception e) {
            return "";
        }
    }

    private void writeArmedBoot(String boot) {
        writeSmall(RepairPolicy.BOOT_FILE, boot);
    }

    private static String readBootId() {
        try {
            java.io.File f = new java.io.File("/proc/sys/kernel/random/boot_id");
            if (!f.isFile()) return "";
            String t = readSmallCapped(f, 64);
            return t == null ? "" : t.trim();
        } catch (Exception e) {
            return "";
        }
    }

    private static void writeSmall(String path, String text) {
        try {
            java.io.FileOutputStream out = new java.io.FileOutputStream(new java.io.File(path));
            try {
                out.write(((text == null ? "" : text) + "\n").getBytes("UTF-8"));
            } finally {
                out.close();
            }
        } catch (Exception e) {
            android.util.Log.w("elfRemote", "write " + path + " " + e.getMessage());
        }
    }

    private String readLogcat() {
        try {
            java.lang.Process p = Runtime.getRuntime().exec(new String[] {
                    "logcat", "-d", "-t", "80", "-s", "elfRemote:I"
            });
            java.io.InputStream in = p.getInputStream();
            try {
                byte[] buf = new byte[4096];
                int n = in.read(buf);
                if (n <= 0) return "";
                return new String(buf, 0, n, "UTF-8");
            } finally {
                in.close();
                p.destroy();
            }
        } catch (Exception e) {
            return "";
        }
    }

    private static void addLogFile(java.util.Map<String, String> files, java.io.File f) {
        if (f == null || !f.exists()) return;
        String body = readSmallCapped(f, 2048);
        files.put(f.getName(), body == null ? "unreadable" : body);
    }

    private static String readSmallCapped(java.io.File f, int max) {
        java.io.FileInputStream in = null;
        try {
            in = new java.io.FileInputStream(f);
            byte[] buf = new byte[max];
            int n = in.read(buf);
            if (n <= 0) return "";
            return new String(buf, 0, n, "UTF-8");
        } catch (Exception e) {
            return null;
        } finally {
            if (in != null) {
                try { in.close(); } catch (Exception e2) { /* ignore */ }
            }
        }
    }

    private void maybeFinishHealth() {
        try {
            java.io.File statef = new java.io.File("/data/local/elfremote/update.state");
            if (!statef.isFile()) return;
            String raw = readSmall(statef);
            JSONObject st = new JSONObject(raw);
            String disk = st.optString("state", "");
            if (UpdatePolicy.ST_ROLLBACK.equals(disk) || UpdatePolicy.ST_RECOVERED.equals(disk)) {
                JSONObject body = new JSONObject();
                body.put("device_id", store.deviceId());
                body.put("token", store.token());
                body.put("job_id", st.optString("job_id", ""));
                body.put("detail", "last-good");
                body.put("state", UpdatePolicy.ST_WAIT_HEALTH);
                HttpJson.post(Protocol.updateProgressPath(), body.toString());
                body.put("state", UpdatePolicy.ST_ROLLBACK);
                HttpJson.post(Protocol.updateProgressPath(), body.toString());
                body.put("state", UpdatePolicy.ST_RECOVERED);
                HttpJson.post(Protocol.updateProgressPath(), body.toString());
                store.setLastStatus("更新已回滚");
                return;
            }
            if (!UpdatePolicy.ST_WAIT_HEALTH.equals(disk)) return;
            int want = st.optInt("versionCode", 0);
            String wantName = st.optString("versionName", "");
            android.content.pm.PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            UpdatePolicy.Health h = new UpdatePolicy.Health();
            h.versionName = Protocol.appVersion();
            h.versionCode = pi.versionCode;
            h.identityOk = store.paired() && store.deviceId().length() > 0;
            h.reportOk = true;
            h.watchdogAlive = new java.io.File("/data/local/elfremote/watchdog.pid").isFile();
            h.updaterAlive = new java.io.File("/data/local/elfremote/updater.ok").isFile();
            if (!UpdatePolicy.healthy(h, wantName, want)) return;
            JSONObject body = new JSONObject();
            body.put("device_id", store.deviceId());
            body.put("token", store.token());
            body.put("job_id", st.optString("job_id", ""));
            body.put("detail", "health-ok");
            body.put("state", UpdatePolicy.ST_WAIT_HEALTH);
            HttpJson.post(Protocol.updateProgressPath(), body.toString());
            body.put("state", UpdatePolicy.ST_SUCCESS);
            HttpJson.post(Protocol.updateProgressPath(), body.toString());
            java.io.FileOutputStream hf = new java.io.FileOutputStream(
                    new java.io.File("/data/local/elfremote/health.ok"));
            try {
                hf.write((want + "\n").getBytes("UTF-8"));
            } finally {
                hf.close();
            }
            st.put("state", UpdatePolicy.ST_SUCCESS);
            java.io.FileOutputStream out = new java.io.FileOutputStream(statef);
            try {
                out.write(st.toString().getBytes("UTF-8"));
            } finally {
                out.close();
            }
            store.setLastStatus("更新成功 " + wantName);
        } catch (Exception e) {
            android.util.Log.w("elfRemote", "health finish " + e.getMessage());
        }
    }

    private static String readSmall(java.io.File f) throws Exception {
        java.io.FileInputStream in = new java.io.FileInputStream(f);
        try {
            byte[] buf = new byte[2048];
            int n = in.read(buf);
            if (n <= 0) return "";
            return new String(buf, 0, n, "UTF-8");
        } finally {
            in.close();
        }
    }

    private static void copyFile(java.io.File from, java.io.File to) throws Exception {
        java.io.FileInputStream in = new java.io.FileInputStream(from);
        try {
            java.io.FileOutputStream out = new java.io.FileOutputStream(to);
            try {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) >= 0) out.write(buf, 0, n);
            } finally {
                out.close();
            }
        } finally {
            in.close();
        }
        to.setReadable(true, false);
    }

    private String networkType() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        NetworkInfo info = cm == null ? null : cm.getActiveNetworkInfo();
        if (info == null || !info.isConnected()) return "unknown";
        if (info.getType() == ConnectivityManager.TYPE_WIFI) return "wifi";
        if (info.getType() == ConnectivityManager.TYPE_MOBILE) return "cellular";
        if (info.getType() == ConnectivityManager.TYPE_ETHERNET) return "ethernet";
        return "unknown";
    }

    private JSONObject gpsFix() {
        try {
            LocationManager lm = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
            if (lm == null) return null;
            Location best = null;
            String[] providers = new String[] {
                    LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER
            };
            for (int i = 0; i < providers.length; i++) {
                if (!lm.isProviderEnabled(providers[i])) continue;
                Location loc = lm.getLastKnownLocation(providers[i]);
                if (loc == null) continue;
                if (best == null || loc.getTime() > best.getTime()) best = loc;
            }
            if (best == null) return null;
            JSONObject o = new JSONObject();
            o.put("lat", best.getLatitude());
            o.put("lng", best.getLongitude());
            o.put("acc_m", best.hasAccuracy() ? Math.round(best.getAccuracy()) : JSONObject.NULL);
            o.put("provider", best.getProvider());
            java.text.SimpleDateFormat f = new java.text.SimpleDateFormat(
                    "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US);
            f.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
            o.put("at", f.format(new java.util.Date(best.getTime())));
            return o;
        } catch (SecurityException e) {
            return null;
        } catch (Exception e) {
            return null;
        }
    }

    private int batteryPct() {
        Intent i = registerReceiver(null, new android.content.IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        if (i == null) return -1;
        int level = i.getIntExtra("level", -1);
        int scale = i.getIntExtra("scale", 100);
        if (level < 0 || scale <= 0) return -1;
        return Math.round(level * 100f / scale);
    }

    private Notification buildNotification() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL, getString(R.string.app_name), NotificationManager.IMPORTANCE_MIN);
            ch.setShowBadge(false);
            ch.enableVibration(false);
            ch.setSound(null, null);
            ch.setLockscreenVisibility(Notification.VISIBILITY_SECRET);
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) nm.createNotificationChannel(ch);
        }
        String text = notifyText();
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL)
                : new Notification.Builder(this);
        b.setContentTitle(getString(R.string.notify_title))
                .setContentText(text)
                .setSmallIcon(android.R.drawable.ic_menu_info_details)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setDefaults(0)
                .setSound(null)
                .setPriority(Notification.PRIORITY_MIN);
        if (!WatchdogPolicy.notificationLaunchesUi()) {
            b.setContentIntent(null);
        }
        return b.build();
    }
}
