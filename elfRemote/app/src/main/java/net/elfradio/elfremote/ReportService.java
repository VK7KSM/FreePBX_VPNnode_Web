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
    private PushConnection push;
    private TrafficMeter traffic;
    private DailyLocation dailyLocation;
    private ConnectivityManager connectivity;
    private ConnectivityManager.NetworkCallback networkCallback;
    private boolean healthReportConfirmed;
    private final Runnable healthCheck = this::maybeFinishHealth;

    private final Runnable loop = new Runnable() {
        @Override
        public void run() {
            if (push != null) push.ensure();
            if (dailyLocation != null && store.registered()) dailyLocation.beforePeriodicReport(this::reportAndSchedule);
            else reportAndSchedule();
        }

        private void reportAndSchedule() {
            tick();
            long delay = store.registered()
                    ? WatchdogPolicy.pairedReportIntervalMs()
                    : WatchdogPolicy.unpairedReportIntervalMs();
            if (BuildConfig.STATUS_ONLY && store.registered()) {
                delay = "wifi".equals(networkType()) || "ethernet".equals(networkType())
                        || push == null || !push.connected() ? 900000L : 3600000L;
                if (statusOutbox().entries().length > 0) delay = 60000L;
            }
            if (BuildConfig.STATUS_ONLY && reportFailures > 0) delay = StatusReporter.retryDelay(60000L, reportFailures);
            RuntimeLog.event("next_report delay_ms=" + delay);
            if (worker != null) {
                worker.removeCallbacks(this);
                worker.postDelayed(this, delay);
            }
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        store = new PairingStore(this);
        traffic = new TrafficMeter(this);
        if (!BuildConfig.STATUS_ONLY) healer = new NetworkHealer(this, store);
        RuntimeLog.event("service_start status_only=" + BuildConfig.STATUS_ONLY);
        startForeground(7, buildNotification());
        lastNotifyText = notifyText();
        if (workerThread == null) {
            workerThread = new HandlerThread("elfremote-net", Process.THREAD_PRIORITY_BACKGROUND);
            workerThread.start();
            worker = new Handler(workerThread.getLooper());
        }
        if (BuildConfig.STATUS_ONLY) push = new PushConnection(this, worker, store, this::receiveStatusRequest);
        if (BuildConfig.STATUS_ONLY) dailyLocation = new DailyLocation(this, worker);
        if (BuildConfig.STATUS_ONLY) {
            connectivity = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            networkCallback = new ConnectivityManager.NetworkCallback() {
                private void changed() {
                    Handler target = worker;
                    if (target != null) target.post(() -> { if (push != null) push.networkHint(); });
                }
                @Override public void onAvailable(android.net.Network network) { changed(); }
                @Override public void onLost(android.net.Network network) { changed(); }
            };
            try {
                if (android.os.Build.VERSION.SDK_INT >= 24) connectivity.registerDefaultNetworkCallback(networkCallback);
                else connectivity.registerNetworkCallback(new android.net.NetworkRequest.Builder()
                        .addCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET).build(), networkCallback);
            } catch (Exception error) { RuntimeLog.error("network_callback_failed", error); }
        }
        if (!loopStarted) {
            loopStarted = true;
            if (BuildConfig.STATUS_ONLY) worker.post(() -> traffic.sample());
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
            if (worker != null) worker.post(() -> {
                if (push != null) { push.ensure(); push.networkHint(); }
                tick();
            });
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
        if (connectivity != null && networkCallback != null) {
            try { connectivity.unregisterNetworkCallback(networkCallback); }
            catch (Exception error) { RuntimeLog.error("network_callback_cleanup_failed", error); }
        }
        if (worker != null) worker.removeCallbacks(loop);
        if (worker != null && push != null) worker.post(push::close);
        if (worker != null && dailyLocation != null) worker.post(dailyLocation::close);
        if (workerThread != null) {
            workerThread.quitSafely();
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
            if (push != null) push.ensure();
            if (!store.registered() || (!store.paired() && store.expiresAt() <= System.currentTimeMillis())) registerDevice();
            if (store.registered()) reportCurrent();
            reportFailures = 0;
        } catch (Exception e) {
            reportFailures = store.registered() ? Math.min(10, reportFailures + 1) : 0;
            RuntimeLog.error("report_failed", e);
            android.util.Log.w("elfRemote", "tick failed", e);
            store.setLastStatus(Protocol.formatNetError(e));
        }
        if (BuildConfig.STATUS_ONLY) traffic.sample();
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

    private String defaultDeviceName() {
        String name = android.provider.Settings.Global.getString(getContentResolver(), "device_name");
        if (name == null || name.trim().isEmpty()) name = android.provider.Settings.Secure.getString(getContentResolver(), "bluetooth_name");
        return name == null || name.trim().isEmpty() ? Build.MODEL : name.trim();
    }

    private void enrollOrPoll() throws Exception {
        if (store.expiresAt() > 0 && store.expiresAt() <= System.currentTimeMillis()) store.clearEnroll();
        if (store.code().length() != 6 || store.enrollId().length() == 0) {
            JSONObject body = new JSONObject();
            body.put("token_sha256", store.tokenSha256());
            body.put("app_version", Protocol.appVersion());
            body.put("os_version", "Android " + Build.VERSION.RELEASE);
            body.put("model_hint", "D22");
            body.put("device_name", defaultDeviceName());
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
            if (dailyLocation != null) dailyLocation.beforePeriodicReport(() -> {
                try { reportCurrent(); }
                catch (Exception error) { RuntimeLog.error("first_paired_report_failed", error); }
            });
            else reportCurrent();
        } else {
            store.setLastStatus(getString(R.string.how_to_pair));
        }
    }

    private void registerDevice() throws Exception {
        JSONObject body = new JSONObject();
        body.put("token", store.token());
        body.put("token_sha256", store.tokenSha256());
        body.put("device_name", defaultDeviceName());
        body.put("model_hint", "D22");
        body.put("app_version", Protocol.appVersion());
        body.put("os_version", "Android " + Build.VERSION.RELEASE);
        JSONObject reply = new JSONObject(HttpJson.post(Protocol.enrollPath(), body.toString()));
        if (!reply.optBoolean("ok") || reply.optString("device_id").isEmpty()) throw new java.io.IOException("registration failed");
        store.saveEnroll(reply.getString("code"), reply.getString("enroll_id"), Protocol.parseIsoMillis(reply.getString("expires_at")));
        store.saveRegistration(reply.getString("device_id"), reply.optBoolean("paired"));
        if (push != null) push.ensure();
    }

    private void reportCurrent() throws Exception {
        if (BuildConfig.STATUS_ONLY) reportStatus();
        else report();
    }

    private JSONObject statusBody(String requestId) throws Exception {
        JSONObject body = new JSONObject();
        body.put("device_id", store.deviceId());
        body.put("report_id", java.util.UUID.randomUUID().toString());
        if (requestId != null) body.put("status_request_id", requestId);
        long now = System.currentTimeMillis();
        java.text.SimpleDateFormat time = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US);
        time.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
        body.put("reported_at", time.format(new java.util.Date(now)));
        body.put("queued_at_ms", now);
        body.put("app_version", Protocol.appVersion());
        body.put("os_version", "Android " + Build.VERSION.RELEASE);
        body.put("network", networkType());
        body.put("device_name", defaultDeviceName());
        body.put("battery", batteryPct());
        body.put("ready", true);
        body.put("managed_log_tasks", true);
        body.put("managed_heal_tasks", true);
        body.put("managed_reboot_tasks", true);
        body.put("managed_update", true);
        body.put("traffic", traffic.sample());
        JSONObject location = gpsFix();
        if (location != null) body.put("gps", location);
        else body.put("location_reason", dailyLocation == null ? "no_cached_location" : dailyLocation.reason());
        return body;
    }

    private StatusOutbox statusOutbox() {
        java.io.File directory = new java.io.File(getFilesDir(), "status-outbox/" + PairingStore.sha256Hex(Protocol.BASE_URL + ":" + store.deviceId()));
        return new StatusOutbox(directory, 512);
    }

    private long samplingRequestVersion;

    private void receiveStatusRequest(JSONObject notice, Runnable acknowledge) throws Exception {
        if (push == null || !PushPolicy.shouldQueue(notice, push.lastVersion(), System.currentTimeMillis())) {
            RuntimeLog.event("push_notice_ignored"); acknowledge.run(); return;
        }
        long version = notice.getLong("version");
        if (samplingRequestVersion == version) return;
        samplingRequestVersion = version;
        RuntimeLog.event("push_notice_received version=" + version);
        try {
            JSONObject receipt = new JSONObject().put("device_id", store.deviceId()).put("token", store.token())
                    .put("received_request_id", notice.getString("request_id")).put("received_version", version);
            JSONObject reply = new JSONObject(HttpJson.post(Protocol.pushSyncPath(), receipt.toString()));
            if (!reply.optBoolean("ok")) throw new java.io.IOException("receipt rejected");
            RuntimeLog.event("push_receipt_saved version=" + version);
        } catch (Exception error) { RuntimeLog.error("push_receipt_failed", error); }
        if (dailyLocation != null) {
            dailyLocation.beforePeriodicReport(() -> {
                try { queueStatusRequest(notice, acknowledge); }
                catch (Exception error) { RuntimeLog.error("requested_report_failed", error); }
                finally { if (samplingRequestVersion == version) samplingRequestVersion = 0; }
            });
        } else {
            try { queueStatusRequest(notice, acknowledge); }
            finally { samplingRequestVersion = 0; }
        }
    }

    private void queueStatusRequest(JSONObject notice, Runnable acknowledge) throws Exception {
        if (push == null || !PushPolicy.shouldQueue(notice, push.lastVersion(), System.currentTimeMillis())) {
            RuntimeLog.event("push_notice_ignored"); acknowledge.run(); return;
        }
        StatusOutbox outbox = statusOutbox();
        String requestId = notice.getString("request_id");
        if (!outbox.containsRequest(requestId)) outbox.add(statusBody(requestId));
        push.recordQueued(notice);
        RuntimeLog.event("push_notice_queued version=" + notice.getLong("version"));
        acknowledge.run();
        try {
            flushStatus(outbox, requestId);
            if (worker != null) {
                worker.removeCallbacks(loop);
                long delay = outbox.entries().length > 0 ? 60000L
                        : ("wifi".equals(networkType()) || "ethernet".equals(networkType()) || !push.connected() ? 900000L : 3600000L);
                worker.postDelayed(loop, delay);
                RuntimeLog.event("requested_report_next delay_ms=" + delay);
            }
        }
        catch (Exception error) {
            RuntimeLog.error("push_report_pending", error);
            reportFailures = Math.min(10, reportFailures + 1);
            if (worker != null) {
                worker.removeCallbacks(loop);
                worker.postDelayed(loop, StatusReporter.retryDelay(60000L, reportFailures));
            }
        }
    }

    private void reportStatus() throws Exception {
        if (push != null) push.ensure();
        StatusOutbox outbox = statusOutbox();
        outbox.add(statusBody(null));
        RuntimeLog.event("status_queued network=" + networkType() + " count=" + outbox.entries().length + " log_failed=" + RuntimeLog.failed());
        flushStatus(outbox, null);
    }

    private void flushStatus(StatusOutbox outbox, String priorityRequest) throws Exception {
        int sent = new StatusReporter(outbox, json -> {
            String reply = HttpJson.post(Protocol.reportPath(), json);
            JSONObject response = new JSONObject(reply);
            JSONObject managed = response.optJSONObject("managed_task");
            if (response.optBoolean("ok") && response.optString("report_id").equals(new JSONObject(json).optString("report_id"))) {
                healthReportConfirmed = true;
                JSONObject update = response.optJSONObject("managed_update");
                if (update != null && update.optBoolean("managed_update_v1")) worker.post(() -> maybeQueueUpdate(update));
                worker.removeCallbacks(healthCheck);
                worker.post(healthCheck);
            }
            if (response.optBoolean("ok") && response.optString("report_id").equals(new JSONObject(json).optString("report_id"))
                    && managed != null && ((managed.optBoolean("managed_log_v1") && "pull_logs".equals(managed.optString("type")))
                    || (managed.optBoolean("managed_heal_v1") && "heal_network".equals(managed.optString("type")))
                    || (managed.optBoolean("managed_reboot_v1") && "reboot".equals(managed.optString("type"))))) {
                worker.post(() -> {
                    try { maybeRunTask(managed); }
                    catch (Exception error) { RuntimeLog.error("task_state_pending", error); }
                });
            }
            if (response.optBoolean("ok") && response.has("paired")) {
                boolean revoked = store.paired() && !response.optBoolean("paired");
                store.saveRegistration(store.deviceId(), response.optBoolean("paired"));
                if (revoked) registerDevice();
            }
            if (new JSONObject(reply).optBoolean("pairing_required", false)) {
                store.clearEnroll();
                if (push != null) push.ensure();
                RuntimeLog.event("pairing_revoked_register_again");
                if (worker != null) { worker.removeCallbacks(loop); worker.postDelayed(loop, 1000L); }
                throw new java.io.IOException("pairing required");
            }
            return reply;
        }, notice -> {
            if (worker != null) worker.post(() -> {
                try { receiveStatusRequest(notice, () -> {}); }
                catch (Exception error) { RuntimeLog.error("push_fallback_failed", error); }
            });
        }).flush(store.token(), priorityRequest);
        traffic.sample();
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
            healthReportConfirmed = true;
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
            if (UpdatePolicy.expired(m, System.currentTimeMillis())) return;
            if (m.has("device_id") && !store.deviceId().equals(m.optString("device_id"))) return;
            java.io.File dir = new java.io.File("/data/local/elfremote");
            if (new java.io.File(dir, "update.job").exists() || new java.io.File(dir, "update.running").exists()) return;
            String previousRaw = readTaskState(new java.io.File(dir, "update.state").getPath());
            JSONObject previous = previousRaw.isEmpty() ? null : new JSONObject(previousRaw);
            if (previous != null && m.optString("job_id").equals(previous.optString("job_id"))
                    && !UpdatePolicy.ST_CLAIMED.equals(previous.optString("state"))) return;
            JSONObject job = new JSONObject();
            job.put("manifest_raw", raw);
            job.put("signature", sig);
            job.put("device_id", store.deviceId());
            job.put("token", store.token());
            job.put("managed_update_v1", true);
            java.io.File json = new java.io.File(dir, "update.job.json");
            writeSmall(json.getPath(), job.toString());
            String src = getApplicationInfo().sourceDir;
            if (src != null && src.length() > 0) {
                java.io.File stagedUpdater = new java.io.File(dir, "updater.apk.new");
                copyFile(new java.io.File(src), stagedUpdater);
                if (!stagedUpdater.renameTo(new java.io.File(dir, "updater.apk"))) throw new java.io.IOException("updater commit failed");
            }
            JSONObject fresh = new JSONObject();
            fresh.put("job_id", m.optString("job_id", ""));
            fresh.put("managed_update_v1", true);
            fresh.put("state", UpdatePolicy.ST_CLAIMED);
            fresh.put("versionCode", m.optInt("versionCode", 0));
            fresh.put("versionName", m.optString("versionName", ""));
            java.io.File statef = new java.io.File(dir, "update.state");
            writeSmall(statef.getPath(), fresh.toString());
            writeSmall(new java.io.File(dir, "update.managed").getPath(), m.getString("job_id"));
            java.io.File sh = new java.io.File(dir, "update.job.tmp");
            java.io.FileOutputStream shOut = new java.io.FileOutputStream(sh);
            try {
                shOut.write(UpdatePolicy.jobShell(json.getAbsolutePath()).getBytes("UTF-8"));
                shOut.getFD().sync();
            } finally {
                shOut.close();
            }
            if (!sh.renameTo(new java.io.File(dir, "update.job"))) throw new java.io.IOException("update queue commit failed");
        } catch (Exception e) {
            RuntimeLog.error("update_queue_failed", e);
        }
    }

    private void maybeRunTask(JSONObject offer) {
        if (offer == null) return;
        String id = offer.optString("id", "");
        if (id.length() == 0) return;
        try {
            JSONObject saved = taskReceipts().read(id);
            if (saved != null) {
                if (saved.optBoolean("acknowledged")) return;
                postTask(id, saved.getString("state"), saved.optString("detail"), saved.optJSONObject("result"));
                return;
            }
        } catch (Exception error) { RuntimeLog.error("task_receipt_retry_pending", error); return; }
        if (offer.optBoolean("managed_reboot_v1") && RepairPolicy.TYPE_REBOOT.equals(offer.optString("type"))) {
            runManagedReboot(offer);
            return;
        }
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
                if (healer == null) healer = new NetworkHealer(this, store);
                String stage = healer.maybeHeal(false);
                HealPolicy.Facts f = healer.observe();
                HealPolicy.Snapshot snap = HealPolicy.Snapshot.parse(store.netSnap());
                HealPolicy.Decision d = HealPolicy.decide(f, snap);
                org.json.JSONObject result = new org.json.JSONObject();
                result.put("stage", stage);
                result.put("action", d.action);
                result.put("reason", d.reason);
                boolean recovered = "none".equals(d.action);
                postTask(id, recovered ? RepairPolicy.ST_SUCCESS : RepairPolicy.ST_FAILED, d.reason, result);
                writeLastTaskId(id);
                writeTaskPhase(RepairPolicy.PHASE_DONE);
                store.setLastStatus((recovered ? "修机成功" : "修机未恢复") + " 强制自愈 " + stage);
                RuntimeLog.event("task_heal_complete recovered=" + recovered + " stage=" + stage);
                android.util.Log.i("elfRemote", "task heal_network stage=" + stage
                        + " action=" + d.action + " reason=" + d.reason);
                return;
            }
            java.util.LinkedHashMap<String, String> files = new java.util.LinkedHashMap<String, String>();
            boolean incomplete = false;
            String[] paths = RepairPolicy.LOG_PATHS;
            for (int i = 0; i < paths.length; i++) {
                incomplete |= addLogFile(files, new java.io.File(paths[i]));
            }
            incomplete |= addLogFile(files, new java.io.File(getFilesDir(), "heal.log"));
            java.io.File[] runtime = new java.io.File(getFilesDir(), "runtime-log").listFiles((dir,name) -> name.matches("runtime-[0-9]+\\.log"));
            if (runtime == null) incomplete = true;
            else {
                java.util.Arrays.sort(runtime);
                for (java.io.File file : runtime) incomplete |= addLogFile(files, file);
            }
            RepairPolicy.Pack pack = RepairPolicy.packLogs(files, readLogcat(), Protocol.appVersion());
            org.json.JSONObject result = new org.json.JSONObject();
            result.put("sha256", pack.sha256);
            result.put("bytes", pack.size);
            result.put("truncated", pack.truncated || incomplete);
            result.put("text", pack.text.substring(0, Math.min(2048, pack.text.length())));
            result.put("log_text", pack.text);
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

    private void runManagedReboot(JSONObject offer) {
        String id = offer.optString("id");
        String path = new java.io.File(getFilesDir(), "reboot-intent.json").getPath();
        try {
            String boot = readBootId();
            if (boot.isEmpty()) throw new java.io.IOException("boot identity unavailable");
            String raw = readTaskState(path);
            JSONObject previous = raw.isEmpty() ? null : new JSONObject(raw);
            if (previous != null && id.equals(previous.optString("task_id"))) {
                if (!store.deviceId().equals(previous.optString("device_id"))) throw new java.io.IOException("reboot identity mismatch");
                if (!boot.equals(previous.getString("boot"))) {
                    postTask(id, RepairPolicy.ST_SUCCESS, "reboot-confirmed",
                            new JSONObject().put("stage", "reboot").put("action", "confirmed"));
                    RuntimeLog.event("task_reboot_confirmed");
                } else RuntimeLog.event("task_reboot_waiting_same_boot");
                return;
            }
            String reason = RepairPolicy.rejectReason(offer, System.currentTimeMillis());
            if (!reason.isEmpty()) { postTask(id, RepairPolicy.ST_REJECTED, reason, null); return; }
            if (new java.io.File("/data/local/elfremote/heal.cmd").exists()) {
                postTask(id, RepairPolicy.ST_FAILED, "root-command-busy", null); return;
            }
            postTask(id, RepairPolicy.ST_CLAIMED, "claimed", null);
            postTask(id, RepairPolicy.ST_RUNNING, "reboot", null);
            writeSmall(path, new JSONObject().put("task_id", id).put("device_id", store.deviceId()).put("boot", boot).toString());
            long deadline = offer.optLong("expires_at");
            armHealCmd(RepairPolicy.expiringRebootCommand(deadline));
            RuntimeLog.event("task_reboot_armed");
        } catch (Exception error) {
            RuntimeLog.error("task_reboot_pending", error);
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
            out.getFD().sync();
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
        return readTaskState(RepairPolicy.WANT_FILE);
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

    private TaskReceipts taskReceipts() {
        return new TaskReceipts(new java.io.File(getFilesDir(), "task-receipts/" + PairingStore.sha256Hex(Protocol.BASE_URL + ":" + store.deviceId())));
    }

    private void postTask(String taskId, String state, String detail, org.json.JSONObject result)
            throws Exception {
        org.json.JSONObject body = new org.json.JSONObject();
        body.put("device_id", store.deviceId());
        body.put("task_id", taskId);
        body.put("state", state);
        body.put("detail", detail == null ? "" : detail);
        if (result != null) body.put("result", result);
        if (TaskReceipts.terminal(state)) taskReceipts().save(body);
        body.put("token", store.token());
        String payload = body.toString();
        Exception last = null;
        for (int i = 0; i < 3; i++) {
            try {
                JSONObject reply = new JSONObject(HttpJson.post(Protocol.taskProgressPath(), payload));
                JSONObject task = reply.optJSONObject("task");
                if (!reply.optBoolean("ok") || task == null || !taskId.equals(task.optString("id")) || !state.equals(task.optString("state")))
                    throw new java.io.IOException("task acknowledgment missing");
                if (TaskReceipts.terminal(state)) taskReceipts().acknowledge(taskId);
                return;
            } catch (Exception e) {
                last = e;
            }
        }
        throw last;
    }

    private String readLastTaskId() {
        return readTaskState(RepairPolicy.LAST_TASK_FILE);
    }

    private void writeLastTaskId(String id) {
        writeSmall(RepairPolicy.LAST_TASK_FILE, id);
    }

    private String readTaskPhase() {
        return readTaskState(RepairPolicy.PHASE_FILE);
    }

    private void writeTaskPhase(String phase) {
        writeSmall(RepairPolicy.PHASE_FILE, phase);
    }

    private String readArmedBoot() {
        return readTaskState(RepairPolicy.BOOT_FILE);
    }

    private static String readTaskState(String path) {
        try {
            java.io.File f = new java.io.File(path);
            if (!f.exists() && !new java.io.File(path + ".bak").exists()) return "";
            byte[] value = new android.util.AtomicFile(f).readFully();
            if (value.length > 2048) throw new java.io.IOException("task state too large");
            return new String(value, "UTF-8").trim();
        } catch (Exception e) {
            throw new IllegalStateException("task state unreadable", e);
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
        android.util.AtomicFile file = new android.util.AtomicFile(new java.io.File(path));
        java.io.FileOutputStream out = null;
        try {
            out = file.startWrite();
            out.write(((text == null ? "" : text) + "\n").getBytes("UTF-8"));
            file.finishWrite(out);
        } catch (Exception e) {
            if (out != null) file.failWrite(out);
            throw new IllegalStateException("task state persistence failed", e);
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

    private static boolean addLogFile(java.util.Map<String, String> files, java.io.File f) {
        if (f == null || !f.exists()) return false;
        int limit = 512 * 1024;
        try (java.io.FileInputStream input = new java.io.FileInputStream(f)) {
            java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int count;
            while (bytes.size() < limit && (count = input.read(buffer, 0, Math.min(buffer.length, limit - bytes.size()))) != -1) bytes.write(buffer, 0, count);
            boolean truncated = input.read() != -1;
            files.put(f.getPath(), new String(bytes.toByteArray(), "UTF-8") + (truncated ? "\n[file truncated]\n" : ""));
            return truncated;
        } catch (Exception error) {
            files.put(f.getPath(), "[unreadable]\n");
            return true;
        }
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
            String raw = readTaskState(statef.getPath());
            if (raw.isEmpty()) return;
            JSONObject st = new JSONObject(raw);
            if (BuildConfig.STATUS_ONLY && !st.optBoolean("managed_update_v1")) return;
            String disk = st.optString("state", "");
            if (UpdatePolicy.ST_SUCCESS.equals(disk) || UpdatePolicy.ST_RECOVERED.equals(disk)) {
                acknowledgeUpdateCompletion(st);
                return;
            }
            if (!UpdatePolicy.ST_WAIT_HEALTH.equals(disk)) return;
            int want = st.optInt("versionCode", 0);
            String wantName = st.optString("versionName", "");
            android.content.pm.PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            UpdatePolicy.Health h = new UpdatePolicy.Health();
            h.versionName = Protocol.appVersion();
            h.versionCode = pi.versionCode;
            h.identityOk = store.registered() && store.deviceId().length() > 0;
            h.reportOk = healthReportConfirmed;
            if (!UpdatePolicy.applicationHealthy(h, wantName, want)) {
                RuntimeLog.event("update_health_wait version=" + h.versionCode
                        + " target=" + want + " identity=" + h.identityOk + " report=" + h.reportOk);
                if (worker != null) worker.postDelayed(healthCheck, 5000L);
                return;
            }
            writeSmall("/data/local/elfremote/health.ok", String.valueOf(want));
            if (worker != null) worker.postDelayed(healthCheck, 5000L);
        } catch (Exception e) {
            RuntimeLog.error("update_health_pending", e);
        }
    }

    private void acknowledgeUpdateCompletion(JSONObject state) throws Exception {
        String job = state.getString("job_id"), terminal = state.getString("state");
        String path = new java.io.File(getFilesDir(), "update-confirmed.json").getPath();
        String raw = readTaskState(path);
        if (!raw.isEmpty()) {
            JSONObject previous = new JSONObject(raw);
            if (job.equals(previous.optString("job_id")) && terminal.equals(previous.optString("state"))) return;
        }
        JSONObject body = new JSONObject().put("device_id", store.deviceId()).put("token", store.token())
                .put("job_id", job).put("detail", UpdatePolicy.ST_SUCCESS.equals(terminal) ? "health-ok" : "last-good");
        body.put("state", UpdatePolicy.ST_SUCCESS.equals(terminal) ? UpdatePolicy.ST_WAIT_HEALTH : UpdatePolicy.ST_ROLLBACK);
        HttpJson.post(Protocol.updateProgressPath(), body.toString());
        body.put("state", terminal);
        JSONObject reply = new JSONObject(HttpJson.post(Protocol.updateProgressPath(), body.toString()));
        JSONObject update = reply.optJSONObject("update");
        if (!reply.optBoolean("ok") || update == null || !job.equals(update.optString("job_id")) || !terminal.equals(update.optString("state")))
            throw new java.io.IOException("update acknowledgment missing");
        writeSmall(path, new JSONObject().put("job_id", job).put("state", terminal).toString());
        RuntimeLog.event("update_completion_confirmed state=" + terminal);
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
                out.getFD().sync();
            } finally {
                out.close();
            }
        } finally {
            in.close();
        }
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
                if (loc == null || !DailyLocation.recent(loc.getElapsedRealtimeNanos(), android.os.SystemClock.elapsedRealtimeNanos())) continue;
                if (best == null) best = loc;
                if (LocationManager.GPS_PROVIDER.equals(loc.getProvider())) { best = loc; break; }
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
