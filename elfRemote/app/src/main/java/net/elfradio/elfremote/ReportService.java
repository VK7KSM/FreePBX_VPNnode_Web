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
    static final String ACTION_FILE_NOTIFICATION = "net.elfradio.elfremote.FILE_NOTIFICATION";
    static final String ACTION_LAB_DNS = "net.elfradio.elfremote.LAB_DNS";
    private static final String CHANNEL = WatchdogPolicy.NOTIFY_CHANNEL;
    private final Handler mainHandler = new Handler();
    private HandlerThread workerThread;
    private Handler worker;
    private PairingStore store;
    private DeviceIdentity identity;
    private String executingCommand = "";
    private FileTransfer fileTransfer;
    private FileReturn fileReturn;
    private volatile boolean destroyed;
    private NetworkHealer healer;
    private boolean loopStarted;
    private boolean reporting;
    private WakeScheduler wake;
    private String lastNotifyText = "";
    private int reportFailures;
    private int statusDrainFailures;
    private PushConnection push;
    private TrafficMeter traffic;
    private DailyLocation dailyLocation;
    private ReportPhotos reportPhotos;
    private BatteryReports batteryReports;
    private MovementReports movementReports;
    private boolean movementSampling;
    private android.content.BroadcastReceiver batteryReceiver;
    private LostUnlockReceiver lostUnlockReceiver;
    private AlarmPlayer alarm;
    private MediaSession media;
    private String locatingTask = "";
    private WifiConnector wifiConnector;
    private LostMode lostMode;
    private ConnectivityManager connectivity;
    private ConnectivityManager.NetworkCallback networkCallback;
    private boolean healthReportConfirmed;
    private String reportReason="startup",scheduledReason="startup";
    private long nextReportElapsed;
    private final long permissionsStarted = android.os.SystemClock.elapsedRealtime();
    private String lastNetwork = "";
    private final Runnable networkReport = () -> {
        String current = networkType();
        if (current.equals(lastNetwork)) { WakeScheduler.release("network-change"); return; }
        String previous = lastNetwork; lastNetwork = current;
        RuntimeLog.event("report_network_changed from=" + previous + " to=" + current);
        resumeFileTransfer();
        if(reportPhotos!=null)reportPhotos.resume();
        scheduleMovement();
        if (!"unknown".equals(current) && !"none".equals(current)) scheduleReport(1000L);
        WakeScheduler.release("network-change");
    };
    private final Runnable healthCheck = this::maybeFinishHealth;

    private final Runnable loop = new Runnable() {
        @Override
        public void run() {
            if (reporting) return;
            if(android.os.SystemClock.elapsedRealtime()<nextReportElapsed)return;
            if (!PermissionGate.ready(ReportService.this)
                    && android.os.SystemClock.elapsedRealtime() - permissionsStarted < 60000L) {
                PermissionGate.ensure(ReportService.this, null);
                scheduleReport(1000L);
                return;
            }
            reporting = true;
            reportReason=scheduledReason;
            WakeScheduler.hold(ReportService.this, "report", 120000L);
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
            }
            if (BuildConfig.STATUS_ONLY && !store.registered() && reportFailures > 0) delay = StatusReporter.retryDelay(60000L, reportFailures);
            RuntimeLog.event("next_report delay_ms=" + delay);
            if (worker != null) {
                scheduleReport(delay);
            }
            reporting = false;
            WakeScheduler.release("report");
        }
    };

    private void scheduleReport(long delay) {
        nextReportElapsed=android.os.SystemClock.elapsedRealtime()+Math.max(1000L,delay);
        scheduledReason=delay>=900000L?"periodic":"maintenance_or_retry";
        worker.removeCallbacks(loop);
        if (BuildConfig.STATUS_ONLY) wake.schedule("report", delay);
        else worker.postDelayed(loop, delay);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        wake = new WakeScheduler(this);
        store = new PairingStore(this);
        traffic = new TrafficMeter(this);
        if (!BuildConfig.STATUS_ONLY) healer = new NetworkHealer(this, store);
        RuntimeLog.event("service_start status_only=" + BuildConfig.STATUS_ONLY);
        startForeground(7, buildNotification());
        if(LostProtection.supported()){
            lostUnlockReceiver=new LostUnlockReceiver();
            registerReceiver(lostUnlockReceiver,new android.content.IntentFilter(Intent.ACTION_USER_PRESENT));
        }
        lastNotifyText = notifyText();
        if (workerThread == null) {
            workerThread = new HandlerThread("elfremote-net", Process.THREAD_PRIORITY_BACKGROUND);
            workerThread.start();
            worker = new Handler(workerThread.getLooper());
        }
        worker.post(()->LostNoticeReceiver.update(ReportService.this));
        alarm = new AlarmPlayer(this, new Handler(android.os.Looper.getMainLooper()), () -> {
            Handler target = worker;
            if (target != null) target.post(this::tick);
        });
        wifiConnector=new WifiConnector(this,worker);
        lostMode=new LostMode(this);
        worker.post(lostMode::recover);
        worker.post(wifiConnector::recover);
        if (BuildConfig.STATUS_ONLY) push = new PushConnection(this, worker, store, this::receiveStatusRequest);
        if (BuildConfig.STATUS_ONLY) dailyLocation = new DailyLocation(this, worker);
        if(BuildConfig.STATUS_ONLY){reportPhotos=new ReportPhotos(this,store);
        media=new MediaSession(this,store,reportPhotos);reportPhotos.resume();}
        if(BuildConfig.STATUS_ONLY){
            try{batteryReports=new BatteryReports(new java.io.File(getFilesDir(),"battery-reports.json"));}
            catch(Exception error){RuntimeLog.error("battery_report_state_failed",error);}
            batteryReceiver=new android.content.BroadcastReceiver(){
                @Override public void onReceive(Context context,Intent intent){
                    int raw=intent.getIntExtra(android.os.BatteryManager.EXTRA_LEVEL,-1),scale=intent.getIntExtra(android.os.BatteryManager.EXTRA_SCALE,100);
                    int level=raw<0||scale<=0?-1:Math.round(raw*100f/scale);
                    boolean charging=intent.getIntExtra(android.os.BatteryManager.EXTRA_PLUGGED,0)>0;
                    Handler target=worker;if(target!=null)target.post(()->batteryChanged(level,charging));
                }
            };
            registerReceiver(batteryReceiver,new android.content.IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            try{movementReports=new MovementReports(new java.io.File(getFilesDir(),"movement-reports.json"));}
            catch(Exception error){RuntimeLog.error("movement_state_failed",error);}
            worker.post(this::scheduleMovement);
        }
        if (BuildConfig.STATUS_ONLY) {
            lastNetwork = networkType();
            connectivity = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            networkCallback = new ConnectivityManager.NetworkCallback() {
                private void changed() {
                    Handler target = worker;
                    if (target != null) {
                        WakeScheduler.hold(ReportService.this, "network-change", 30000L);
                        target.post(() -> {
                            if (push != null) push.networkHint();
                            target.removeCallbacks(networkReport);
                            target.postDelayed(networkReport, 3000L);
                        });
                    }
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
        ensureMaintenance();
        worker.post(() -> {
            resumeFileTransfer();
            java.io.File active = new java.io.File(getFilesDir(), "core-active.json");
            if (active.isFile()) try { maybeRunTask(new JSONObject(RescueFiles.read(active, 40000))); }
            catch (Exception e) { RuntimeLog.error("core_resume_pending", e); }
        });
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if(intent!=null&&ACTION_FILE_NOTIFICATION.equals(intent.getAction())){
            startForeground(7,buildNotification());
            lastNotifyText=notifyText();
            RuntimeLog.event("file_foreground_notification updated=true");
            return START_STICKY;
        }
        if (intent != null && WakeScheduler.ACTION.equals(intent.getAction()) && worker != null) {
            String key = intent.getStringExtra("wake_key");
            worker.post(() -> {
                try {
                    RuntimeLog.event("wake_alarm key=" + key + " queue_ms=" + Math.max(0, android.os.SystemClock.elapsedRealtime()-intent.getLongExtra("received_elapsed", android.os.SystemClock.elapsedRealtime())));
                    if ("report".equals(key)) loop.run();
                    else if ("status-drain".equals(key)) drainStatus();
                    else if ("file-transfer".equals(key)) resumeFileTransfer();
                    else if("report-photo".equals(key)&&reportPhotos!=null)reportPhotos.resume();
                    else if("movement".equals(key))checkMovement();
                    else if("file-return".equals(key))resumeFileTransfer();
                    else if (push != null) push.wake(key);
                } finally { WakeScheduler.release("dispatch-" + key); }
            });
        }
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
                nextReportElapsed=0;scheduledReason="manual";
                loop.run();
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
        if(batteryReceiver!=null){unregisterReceiver(batteryReceiver);batteryReceiver=null;}
        if(lostUnlockReceiver!=null){unregisterReceiver(lostUnlockReceiver);lostUnlockReceiver=null;}
        destroyed = true;
        wake.cancel("movement");WakeScheduler.release("movement");
        if(fileTransfer!=null)fileTransfer.stop();
        if(fileReturn!=null)fileReturn.stop();
        if(reportPhotos!=null)reportPhotos.close();
        RuntimeLog.event("service_stop");
        if (alarm != null) alarm.close();
        if (media != null) media.stop("客户端服务停止");
        if (connectivity != null && networkCallback != null) {
            try { connectivity.unregisterNetworkCallback(networkCallback); }
            catch (Exception error) { RuntimeLog.error("network_callback_cleanup_failed", error); }
        }
        if (worker != null) worker.removeCallbacks(loop);
        if (worker != null) worker.removeCallbacks(networkReport);
        WakeScheduler.release("network-change");
        if (wake != null) wake.cancel("report");
        if (wake != null) wake.cancel("status-drain");
        WakeScheduler.release("status-drain");
        WakeScheduler.release("report");
        WakeScheduler.release("notice");
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
            healAfterReportFailure();
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

    private void healAfterReportFailure() {
        if (!BuildConfig.STATUS_ONLY) return;
        if(wifiConnector!=null && !wifiConnector.pendingTask().isEmpty()) return;
        try {
            if (healer == null) healer = new NetworkHealer(this, store);
            if (!HealPolicy.automaticRepairNeeded(healer.observe(), HealPolicy.Snapshot.parse(store.netSnap()))) return;
            RuntimeLog.event("automatic_heal stage=" + healer.maybeHeal(true));
            if (push != null) push.networkHint();
        } catch (Exception error) { RuntimeLog.error("automatic_heal_failed", error); }
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
        putIdentity(body);
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

    private void putIdentity(JSONObject body) throws Exception {
        if (identity==null) identity=new DeviceIdentity(this);
        JSONObject value=identity.read();
        if (value!=null) body.put("hardware_identity",value);
    }

    private void ensureMaintenance() {
        PermissionGate.ensure(this, null);
        CoreInstaller.ensure(this, this::coreMaintenanceFinished);
        WatchdogInstaller.ensure(this, () -> {
            Handler target = worker;
            if (target != null && !destroyed) target.post(() -> {
                if (destroyed) return;
                CoreInstaller.ensure(this, this::coreMaintenanceFinished);
                if (WatchdogInstaller.needsRetry()) {
                    long delay = WatchdogInstaller.retryDelayMs();
                    RuntimeLog.event("watchdog_retry_scheduled delay_ms=" + delay);
                    target.postDelayed(() -> { if (!destroyed) ensureMaintenance(); }, delay);
                } else scheduleReport(1000L);
            });
        });
    }

    private void coreMaintenanceFinished(){
        Handler h=worker;if(h==null||destroyed)return;
        h.post(()->{
            if(destroyed)return;
            if(CoreInstaller.ready())scheduleReport(1000L);
            else {
                long delay=CoreInstaller.retryDelayMs();
                RuntimeLog.event("core_retry_scheduled delay_ms="+delay);
                h.postDelayed(()->{if(!destroyed)ensureMaintenance();},delay);
            }
        });
    }

    private JSONObject statusBody(String requestId) throws Exception {
        ensureMaintenance();
        JSONObject body = new JSONObject();
        body.put("device_id", store.deviceId());
        body.put("report_id", java.util.UUID.randomUUID().toString());
        body.put("report_reason",requestId==null?reportReason:"requested");
        if (requestId != null) body.put("status_request_id", requestId);
        long now = System.currentTimeMillis();
        java.text.SimpleDateFormat time = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US);
        time.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
        body.put("reported_at", time.format(new java.util.Date(now)));
        body.put("queued_at_ms", now);
        putIdentity(body);
        body.put("app_version", Protocol.appVersion());
        body.put("os_version", "Android " + Build.VERSION.RELEASE);
        body.put("network", networkType());
        body.put("device_name", defaultDeviceName());
        putBattery(body);
        body.put("ready", WatchdogInstaller.ready());
        body.put("maintenance", WatchdogInstaller.snapshot());
        body.put("permissions", PermissionGate.snapshot(this));
        body.put("managed_log_tasks", true);
        body.put("managed_exec_tasks", CoreInstaller.ready());
        body.put("managed_adb_session", CoreInstaller.ready());
        body.put("managed_media", true);
        body.put("media_cameras", android.hardware.Camera.getNumberOfCameras());
        body.put("managed_file_tasks", CoreInstaller.ready());
        body.put("managed_file_return", CoreInstaller.ready());
        body.put("managed_file_operations", CoreInstaller.ready());
        body.put("managed_file_delete", CoreInstaller.ready());
        body.put("managed_sip_account", CoreInstaller.ready());
        body.put("managed_system_settings", CoreInstaller.ready());
        body.put("managed_zello_account", CoreInstaller.ready());
        body.put("managed_heal_tasks", WatchdogInstaller.ready());
        body.put("managed_reboot_tasks", WatchdogInstaller.ready());
        body.put("managed_adbd_tasks", WatchdogInstaller.ready());
        body.put("managed_wifi_scan_tasks", true);
        body.put("managed_alarm_tasks", true);
        body.put("managed_locate_tasks", true);
        body.put("managed_config_tasks", WatchdogInstaller.ready());
        body.put("managed_lost_tasks", true);
        body.put("managed_lost_v2",LostProtection.supported()&&CoreInstaller.ready());
        body.put("managed_lost_safety_v1",LostProtection.supported());
        boolean wipeSupported=false;try{LostProtection.wipeMethod();wipeSupported=LostProtection.supported()&&CoreInstaller.ready();}catch(Exception ignored){}
        body.put("managed_wipe_v1",wipeSupported);
        body.put("lost_mode", lostMode.snapshot());
        body.put("alarm", alarm.snapshot());
        body.put("managed_update", WatchdogInstaller.ready());
        body.put("managed_update_v2", true);
        body.put("traffic", traffic.sample());
        JSONObject location = gpsFix();
        if (location != null) body.put("gps", location);
        else {
            body.put("location_reason", dailyLocation == null ? "no_cached_location" : dailyLocation.reason());
            JSONObject radio=RadioLocation.capture(this);
            if(radio!=null)body.put("radio",radio);
        }
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
        WakeScheduler.hold(this, "notice", 120000L);
        RuntimeLog.event("push_notice_received version=" + version);
        try {
            JSONObject receipt = new JSONObject().put("device_id", store.deviceId()).put("token", store.token())
                    .put("received_request_id", notice.getString("request_id")).put("received_version", version);
            JSONObject reply = new JSONObject(HttpJson.post(Protocol.pushSyncPath(), receipt.toString()));
            if (!reply.optBoolean("ok")) throw new java.io.IOException("receipt rejected");
            RuntimeLog.event("push_receipt_saved version=" + version);
            JSONObject immediateMedia=reply.optJSONObject("media_session");
            if(immediateMedia!=null){
                if(media==null)media=new MediaSession(this,store,reportPhotos);
                media.receive(immediateMedia);
            }
        } catch (Exception error) { RuntimeLog.error("push_receipt_failed", error); }
        if (dailyLocation != null) {
            dailyLocation.beforePeriodicReport(() -> {
                try { queueStatusRequest(notice, acknowledge); }
                catch (Exception error) { RuntimeLog.error("requested_report_failed", error); }
                finally { if (samplingRequestVersion == version) { samplingRequestVersion = 0; WakeScheduler.release("notice"); } }
            });
        } else {
            try { queueStatusRequest(notice, acknowledge); }
            finally { samplingRequestVersion = 0; WakeScheduler.release("notice"); }
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
                long delay = "wifi".equals(networkType()) || "ethernet".equals(networkType()) || !push.connected() ? 900000L : 3600000L;
                scheduleReport(delay);
                RuntimeLog.event("requested_report_next delay_ms=" + delay);
            }
        }
        catch (Exception error) {
            RuntimeLog.error("push_report_pending", error);
            healAfterReportFailure();
            reportFailures = Math.min(10, reportFailures + 1);
        }
    }

    private void reportStatus() throws Exception {
        if (push != null) push.ensure();
        StatusOutbox outbox = statusOutbox();
        String urgent=queueBatteryReport(outbox);
        if(urgent==null){JSONObject current=statusBody(null);outbox.add(current);urgent=current.getString("report_id");}
        RuntimeLog.event("status_queued network=" + networkType() + " count=" + outbox.entries().length + " log_failed=" + RuntimeLog.failed());
        flushStatus(outbox, null,urgent);
    }

    private String queueBatteryReport(StatusOutbox outbox)throws Exception{
        if(batteryReports==null)return null;
        JSONObject pending=batteryReports.pending();if(pending==null)return null;
        JSONObject body=statusBody(null).put("report_id",pending.getString("id")).put("queued_at_ms",pending.getLong("at"))
                .put("report_event",BatteryReports.event(pending));
        outbox.add(body);
        batteryReports.queued(pending.getString("id"));
        RuntimeLog.event("battery_report_queued thresholds="+body.getJSONObject("report_event").getJSONArray("thresholds"));
        return pending.getString("id");
    }

    private void batteryChanged(int level,boolean charging){
        if(batteryReports==null)return;
        try{
            if(!batteryReports.observe(level,charging)||!store.registered())return;
            WakeScheduler.hold(this,"battery-report",45000L);
            StatusOutbox outbox=statusOutbox();String urgent=queueBatteryReport(outbox);
            if(urgent!=null)flushStatus(outbox,null,urgent);
            scheduleReport("cellular".equals(networkType())&&push!=null&&push.connected()?3600000L:900000L);
        }catch(Exception error){RuntimeLog.error("battery_report_pending",error);scheduleStatusDrain();}
        finally{WakeScheduler.release("battery-report");}
    }

    private void scheduleMovement(){
        if(!destroyed&&movementReports!=null&&"cellular".equals(networkType()))wake.schedule("movement",MovementReports.CHECK_MS);
        else wake.cancel("movement");
    }
    private void checkMovement(){
        if(destroyed||movementSampling||movementReports==null||dailyLocation==null||!store.registered()||!"cellular".equals(networkType())){scheduleMovement();return;}
        movementSampling=true;WakeScheduler.hold(this,"movement",90000L);
        RuntimeLog.event("movement_sample_start");
        dailyLocation.requestMovement(()->{
            try{
                if(destroyed||!"cellular".equals(networkType()))return;
                StatusOutbox outbox=statusOutbox();String id=movementReports.prepare(outbox,statusBody(null),System.currentTimeMillis());
                if(id!=null){RuntimeLog.event("movement_report_queued");flushStatus(outbox,null,id);scheduleReport(push!=null&&push.connected()?3600000L:900000L);}
                else RuntimeLog.event("movement_report_not_due");
            }catch(Exception error){RuntimeLog.error("movement_report_pending",error);scheduleStatusDrain();}
            finally{movementSampling=false;WakeScheduler.release("movement");scheduleMovement();}
        });
    }

    private void flushStatus(StatusOutbox outbox, String priorityRequest) throws Exception {
        flushStatus(outbox,priorityRequest,null);
    }
    private void flushStatus(StatusOutbox outbox,String priorityRequest,String priorityReport)throws Exception{
        try {
            sendStatusBatch(outbox,priorityRequest,priorityReport);
            statusDrainFailures=0;
        } catch(Exception error) {
            statusDrainFailures=Math.min(10,statusDrainFailures+1);
            throw error;
        } finally { scheduleStatusDrain(); }
    }

    private void scheduleStatusDrain(){
        if(destroyed||wake==null||!BuildConfig.STATUS_ONLY)return;
        long delay=StatusDrainPolicy.delay("cellular".equals(networkType()),statusOutbox().entries().length,statusDrainFailures);
        if(delay==0)wake.cancel("status-drain");else wake.schedule("status-drain",delay);
    }

    private void drainStatus(){
        if(destroyed||!store.registered())return;
        WakeScheduler.hold(this,"status-drain",30000L);
        try{flushStatus(statusOutbox(),null);}
        catch(Exception error){RuntimeLog.error("status_drain_pending",error);}
        finally{WakeScheduler.release("status-drain");}
    }

    private void sendStatusBatch(StatusOutbox outbox,String priorityRequest,String priorityReport)throws Exception{
        java.io.File[] queued=outbox.entries();
        final String latestQueued=queued.length==0?"":outbox.read(queued[queued.length-1]).optString("report_id");
        int sent = new StatusReporter(outbox, json -> {
            String reply = HttpJson.post(Protocol.reportPath(), json);
            JSONObject response = new JSONObject(reply);
            JSONObject managed = response.optJSONObject("managed_task");
            if(response.optBoolean("ok")&&response.optString("report_id").equals(new JSONObject(json).optString("report_id"))){
                JSONObject safety=response.optJSONObject("managed_safety_task");
                if(safety!=null)runLostSafety(safety);
            }
            if(response.optBoolean("ok")&&response.optString("report_id").equals(new JSONObject(json).optString("report_id"))) {
                JSONObject mediaOffer=response.optJSONObject("media_session");
                if(mediaOffer!=null)worker.post(()->{if(media==null)media=new MediaSession(this,store,reportPhotos);media.receive(mediaOffer);});
                JSONObject adb=response.optJSONObject("adb_session");
                if(adb!=null&&CoreInstaller.ready())worker.post(()->openAdb(adb));
            }
            if (response.optBoolean("ok") && response.optString("report_id").equals(new JSONObject(json).optString("report_id"))) {
                healthReportConfirmed = true;
                if(movementReports!=null)try{movementReports.acknowledged(new JSONObject(json));}
                catch(Exception error){RuntimeLog.error("movement_baseline_save_failed",error);}
                JSONObject acknowledged=new JSONObject(json);
                boolean currentReport=(priorityReport!=null&&priorityReport.equals(acknowledged.optString("report_id")))
                        ||(priorityRequest!=null&&priorityRequest.equals(acknowledged.optString("status_request_id")))
                        ||(latestQueued.equals(acknowledged.optString("report_id"))&&PhotoPolicy.recent(System.currentTimeMillis(),PhotoPolicy.sampledAt(acknowledged)));
                if(reportPhotos!=null&&(currentReport||PhotoPolicy.critical(acknowledged)))try{reportPhotos.acknowledged(acknowledged);}
                catch(Exception error){RuntimeLog.error("report_photo_enqueue_failed",error);}
                try {
                    if (healer == null) healer = new NetworkHealer(this, store);
                    healer.saveSnapshot(healer.observe());
                } catch (Exception error) { RuntimeLog.error("network_snapshot_failed", error); }
                JSONObject update = response.optJSONObject("managed_update");
                if (update != null && update.optBoolean("managed_update_v1")) worker.post(() -> maybeQueueUpdate(update));
                worker.removeCallbacks(healthCheck);
                worker.post(healthCheck);
            }
            if (response.optBoolean("ok") && response.optString("report_id").equals(new JSONObject(json).optString("report_id"))
                    && managed != null && ((managed.optBoolean("managed_log_v1") && "pull_logs".equals(managed.optString("type")))
                    || (managed.optBoolean("managed_exec_v1") && "root_exec".equals(managed.optString("type")))
                    || (managed.optBoolean("managed_exec_v1") && ("system_config".equals(managed.optString("type")) || "file_manage".equals(managed.optString("type")) || "configure_sip".equals(managed.optString("type")) || "configure_zello".equals(managed.optString("type"))))
                    || (managed.optBoolean("managed_file_v1") && "send_file".equals(managed.optString("type")))
                    || (managed.optBoolean("managed_file_return_v1") && "get_file".equals(managed.optString("type")))
                    || (managed.optBoolean("managed_heal_v1") && "heal_network".equals(managed.optString("type")))
                    || (managed.optBoolean("managed_reboot_v1") && "reboot".equals(managed.optString("type")))
                    || (managed.optBoolean("managed_adbd_v1") && "restart_adbd".equals(managed.optString("type")))
                    || (managed.optBoolean("managed_wifi_scan_v1") && "scan_wifi".equals(managed.optString("type")))
                    || (managed.optBoolean("managed_alarm_v1") && ("play_alarm".equals(managed.optString("type"))
                    || "stop_alarm".equals(managed.optString("type"))))
                    || (managed.optBoolean("managed_locate_v1") && "locate_now".equals(managed.optString("type")))
                    || (managed.optBoolean("managed_config_v1") && RepairPolicy.configType(managed.optString("type")))
                    || (managed.optBoolean("managed_lost_v1") && ("set_lost_mode".equals(managed.optString("type"))||"wipe_data".equals(managed.optString("type")))))) {
                worker.post(() -> {
                    try { maybeRunTask(managed); }
                    catch (Exception error) { RuntimeLog.error("task_state_pending", error); }
                });
            }
            if (response.optBoolean("ok") && response.has("paired")) {
                lostMode.contact(response);
                boolean revoked = store.paired() && !response.optBoolean("paired");
                store.saveRegistration(store.deviceId(), response.optBoolean("paired"));
                if (revoked) registerDevice();
            }
            if (new JSONObject(reply).optBoolean("pairing_required", false)) {
                store.clearEnroll();
                if (push != null) push.ensure();
                RuntimeLog.event("pairing_revoked_register_again");
                if (worker != null) { scheduleReport(1000L); }
                throw new java.io.IOException("pairing required");
            }
            return reply;
        }, notice -> {
            if (worker != null) worker.post(() -> {
                try { receiveStatusRequest(notice, () -> {}); }
                catch (Exception error) { RuntimeLog.error("push_fallback_failed", error); }
            });
        }).flush(store.token(), priorityRequest,priorityReport);
        traffic.sample();
        store.setLastStatus(sent > 0 ? "已上报" : "等待上报");
    }

    private void openAdb(JSONObject offer) {
        if(destroyed||offer.optLong("expires_at")<=System.currentTimeMillis())return;
        try{CoreClient.request("/adb/open",offer);}
        catch(Exception error){RuntimeLog.error("adb_open_pending",error);if(worker!=null)worker.postDelayed(()->openAdb(offer),5000L);}
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
        putBattery(body);
        body.put("ready", WatchdogInstaller.ready());
        body.put("maintenance", WatchdogInstaller.snapshot());
        body.put("permissions", PermissionGate.snapshot(this));
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
            m = UpdatePolicy.executionManifest(m, upd, store.deviceId(), System.currentTimeMillis());
            if (m == null) return;
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
            if (upd.has("task_id")) {
                job.put("task_id", upd.getString("task_id"));
                job.put("task_expires_at", upd.getLong("task_expires_at"));
                job.put("task_device_id", upd.getString("task_device_id"));
            }
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

    private void runCoreCommand(JSONObject offer) {
        String id = offer.optString("id");
        try {
            JSONObject receipt = taskReceipts().read(id);
            if (receipt != null) {
                if (!receipt.optBoolean("acknowledged")) postTask(id, receipt.getString("state"), receipt.optString("detail"), receipt.optJSONObject("result"));
                new java.io.File(getFilesDir(), "core-active.json").delete();
                return;
            }
            if (id.equals(executingCommand)) {
                if (offer.optBoolean("cancel_requested")) CoreClient.request("/jobs/" + id + "/cancel", new JSONObject());
                return;
            }
            if (!executingCommand.isEmpty()) return;
            JSONObject existing = CoreClient.request("/jobs/" + id, null);
            if (existing == null) {
                String reason = RepairPolicy.rejectReason(offer, System.currentTimeMillis());
                if (!reason.isEmpty() || offer.optBoolean("cancel_requested")) {
                    postTask(id, "rejected", offer.optBoolean("cancel_requested") ? "命令已取消，未执行" : reason, null); return;
                }
            }
            JSONObject params = offer.getJSONObject("params");
            boolean systemSettings="system_config".equals(offer.optString("type"));
            boolean fileOperation="file_manage".equals(offer.optString("type"));
            boolean sipAccount="configure_sip".equals(offer.optString("type"));
            boolean zelloAccount="configure_zello".equals(offer.optString("type"));
            String command = systemSettings?"system-settings":zelloAccount?"configure-zello":sipAccount?"configure-sip":fileOperation?"file-manage:"+FileOperations.normalize(params):params.getString("command"), cwd = params.optString("cwd", "/");
            int timeout = systemSettings||fileOperation||sipAccount||zelloAccount?120:params.optInt("timeout", 30);
            RescueJobs.validate(id, command, timeout);
            if (!cwd.startsWith("/") || cwd.length() > 1024 || cwd.indexOf('\0') >= 0) throw new IllegalArgumentException("工作目录无效");
            RescueFiles.write(new java.io.File(getFilesDir(), "core-active.json"), offer.toString());
            postTask(id, "claimed", "设备已接收命令", null);
            postTask(id, "running", "设备正在执行命令", null);
            if (existing == null) {
                if(systemSettings)CoreClient.request("/system-settings",new JSONObject().put("id",id).put("params",params));
                else if(zelloAccount)CoreClient.request("/zello-account",new JSONObject().put("id",id).put("params",params));
                else if(sipAccount)CoreClient.request("/sip-account",new JSONObject().put("id",id).put("params",params));
                else if(fileOperation)CoreClient.request("/file-manage",new JSONObject().put("id",id).put("params",params));
                else CoreClient.request("/exec", new JSONObject().put("id", id)
                    .put("command", "cd " + RescueFiles.quote(cwd) + " || exit 125\n" + command).put("timeout", timeout));
            }
            if (offer.optBoolean("cancel_requested")) CoreClient.request("/jobs/" + id + "/cancel", new JSONObject());
            executingCommand = id;
            WakeScheduler.hold(this, "core-command", (timeout + 15L) * 1000L);
            new Thread(() -> {
                JSONObject result = null;
                try {
                    long end = android.os.SystemClock.elapsedRealtime() + (timeout + 15L) * 1000;
                    while (!destroyed && android.os.SystemClock.elapsedRealtime() < end) {
                        result = CoreClient.request("/jobs/" + id, null);
                        if (result != null && !"running".equals(result.optString("state"))) break;
                        result = null; Thread.sleep(500);
                    }
                } catch (Exception error) { RuntimeLog.error("core_result_pending", error); }
                final JSONObject outcome = result;
                Handler h = worker;
                if (!destroyed && h != null) h.post(() -> {
                    executingCommand = "";
                    try {
                        if (outcome == null) { scheduleReport(15000L); return; }
                        String state = outcome.optString("state");
                        boolean ok = "completed".equals(state) && !outcome.isNull("exit_code") && outcome.optInt("exit_code", -1) == 0;
                        String detail = "cancelled".equals(state) ? "命令已停止" : "timed_out".equals(state) ? "命令执行超时，已停止"
                                : "interrupted".equals(state) ? "维护核心重启，命令中断且未重跑" : ok ? "命令执行成功" : "命令执行失败";
                        String output = outcome.optString("output", outcome.optString("error"));
                        JSONObject report = new JSONObject().put("text", output.substring(0, Math.min(16000, output.length())))
                                .put("truncated", outcome.optBoolean("truncated") || output.length() > 16000)
                                .put("exit_code", outcome.opt("exit_code")).put("elapsed_ms", outcome.optLong("elapsed_ms"))
                                .put("stage", "command").put("action", state);
                        if(zelloAccount){report.put("logged_in",outcome.optBoolean("logged_in"));detail=output;}
                        if(sipAccount){report.put("registered",outcome.optBoolean("registered"));detail=output;}
                        if(systemSettings)detail=ok?"系统配置已完成":"系统配置未完成";
                        if(fileOperation)detail=ok?"文件操作完成":"文件操作未完成";
                        postTask(id, ok ? "success" : "failed", detail, report);
                        new java.io.File(getFilesDir(), "core-active.json").delete();
                        // 新安装恢复可能还需配置另一应用；账号任务结束后立即检查，避免等15分钟。
                        if(systemSettings||sipAccount||zelloAccount)scheduleReport(1000L);
                    } catch (Exception error) { RuntimeLog.error("core_receipt_pending", error); scheduleReport(15000L); }
                    finally { WakeScheduler.release("core-command"); }
                });
            }, "elfremote-command-result").start();
        } catch (Exception error) {
            RuntimeLog.error("core_command_pending", error);
            scheduleReport(15000L);
        }
    }

    private void resumeFileTransfer() {
        java.io.File exporting=new java.io.File(getFilesDir(),"file-return-active.json");
        if(exporting.isFile())try{maybeRunTask(new JSONObject(RescueFiles.read(exporting,16000)));}
        catch(Exception error){RuntimeLog.error("file_return_resume_pending",error);}
        java.io.File active=new java.io.File(getFilesDir(),"file-active.json");
        if(active.isFile())try{maybeRunTask(new JSONObject(RescueFiles.read(active,16000)));}
        catch(Exception error){RuntimeLog.error("file_resume_pending",error);}
    }

    private void maybeRunTask(JSONObject offer) {
        if (offer == null) return;
        if(LostSafety.accepts(offer)){
            runLostSafety(offer);
            return;
        }
        String id = offer.optString("id", "");
        if (id.length() == 0) return;
        if("get_file".equals(offer.optString("type"))){
            try{if(fileReturn==null)fileReturn=new FileReturn(this,this::postTask,taskReceipts());fileReturn.receive(offer,store.deviceId(),store.token());}
            catch(Exception error){RuntimeLog.error("file_return_task_pending",error);}return;
        }
        if("send_file".equals(offer.optString("type"))) {
            try{
                if(fileTransfer==null)fileTransfer=new FileTransfer(this,this::postTask,taskReceipts());
                fileTransfer.receive(offer,store.deviceId(),store.token());
            }catch(Exception error){RuntimeLog.error("file_task_pending",error);}
            return;
        }
        if ("system_config".equals(offer.optString("type")) || "root_exec".equals(offer.optString("type")) || "file_manage".equals(offer.optString("type")) || "configure_sip".equals(offer.optString("type")) || "configure_zello".equals(offer.optString("type"))) {
            runCoreCommand(offer);
            return;
        }
        if (id.equals(locatingTask)) return;
        if(wifiConnector!=null && wifiConnector.busy()) return;
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
            if("set_lost_mode".equals(type)) {
                JSONObject outcome=lostMode.set(new JSONObject(offer.getJSONObject("params").toString()).put("task_id",id));
                if(!outcome.getBoolean("enabled")) alarm.stop();
                postTask(id,RepairPolicy.ST_SUCCESS,"lost-"+outcome.getString("state"),new JSONObject().put("lost_mode",outcome));
                writeLastTaskId(id);writeTaskPhase(RepairPolicy.PHASE_DONE);
                return;
            }
            if("wipe_data".equals(type)) {
                JSONObject outcome=lostMode.wipe(new JSONObject(offer.getJSONObject("params").toString()).put("task_id",id).put("expires_at",offer.getLong("expires_at")));
                postTask(id,RepairPolicy.ST_RUNNING,"已接受清除指令，等待设备执行；离线不代表完成",new JSONObject().put("lost_mode",outcome));
                writeLastTaskId(id);writeTaskPhase(RepairPolicy.PHASE_DONE);return;
            }
            if(RepairPolicy.configType(type)) {
                JSONObject params=offer.optJSONObject("params");if(params==null) params=new JSONObject();
                if("connect_wifi".equals(type)) {
                    wifiConnector.connect(id,params,(ok,detail)->{
                        try {postTask(id,ok?RepairPolicy.ST_SUCCESS:RepairPolicy.ST_FAILED,detail,
                                new JSONObject().put("stage","wifi").put("action",ok?"connected":"rolled_back"));}
                        catch(Exception error){RuntimeLog.event("wifi_result_pending");}
                        tick();
                    });
                } else {
                    JSONObject contacts=new DeviceContacts(this).execute(id,type,params);
                    postTask(id,RepairPolicy.ST_SUCCESS,"contacts-complete",new JSONObject().put("stage","contacts").put("action",type).put("contacts",contacts));
                }
                return;
            }
            if (RepairPolicy.TYPE_LOCATE_NOW.equals(type)) {
                if (dailyLocation == null) throw new java.io.IOException("location-unavailable");
                locatingTask = id;
                dailyLocation.requestNow(() -> {
                    try {
                        String outcome = dailyLocation.outcome();
                        postTask(id, "sampled".equals(outcome) ? RepairPolicy.ST_SUCCESS : RepairPolicy.ST_FAILED,
                                "location-" + outcome, new JSONObject().put("stage", "location").put("action", outcome));
                    } catch (Exception error) { RuntimeLog.error("location_task_result_pending", error); }
                    finally { locatingTask = ""; tick(); }
                });
                return;
            }
            if (RepairPolicy.TYPE_PLAY_ALARM.equals(type) || RepairPolicy.TYPE_STOP_ALARM.equals(type)) {
                if (RepairPolicy.rejectReason(offer, System.currentTimeMillis()).length() > 0) {
                    postTask(id, RepairPolicy.ST_REJECTED, "expired", null);
                    return;
                }
                JSONObject outcome = RepairPolicy.TYPE_PLAY_ALARM.equals(type) ? alarm.play(id) : alarm.stop();
                postTask(id, RepairPolicy.ST_SUCCESS, "alarm-" + outcome.getString("state"),
                        new JSONObject().put("stage", "alarm").put("action", outcome.getString("state")).put("alarm", outcome));
                return;
            }
            if (RepairPolicy.TYPE_SCAN_WIFI.equals(type)) {
                JSONObject scan = WifiScanner.scan(this);
                postTask(id, RepairPolicy.ST_SUCCESS, "wifi-scan-complete",
                        new JSONObject().put("stage", "wifi").put("action", "scanned").put("wifi_scan", scan));
                RuntimeLog.event("wifi_scan_complete count=" + scan.getJSONArray("networks").length());
                return;
            }
            if (RepairPolicy.TYPE_REBOOT.equals(type)) {
                writeLastTaskId(id);
                writeTaskPhase(RepairPolicy.PHASE_RUNNING);
                writeArmedBoot(readBootId());
                android.util.Log.i("elfRemote", "task reboot armed");
                armReboot();
                return;
            }
            if (RepairPolicy.TYPE_RESTART_ADBD.equals(type)) {
                JSONObject params = offer.optJSONObject("params");
                if (params == null) params = new JSONObject();
                armHealCmd(RepairPolicy.expiringAdbdCommand(offer.optLong("expires_at"), params.optString("lan_peer", "")));
                String rc = waitHealRc(45000L);
                String out = readHealOut();
                if (!RepairPolicy.adbdSucceeded(rc, out)) {
                    postTask(id, RepairPolicy.ST_FAILED, "adbd-rc=" + rc, null);
                    writeLastTaskId(id);
                    writeTaskPhase(RepairPolicy.PHASE_DONE);
                    return;
                }
                org.json.JSONObject result = new org.json.JSONObject();
                result.put("stage", "adbd");
                result.put("action", params.optString("lan_peer", "").isEmpty() ? "loopback" : "lan");
                result.put("text", out.length() > 1500 ? out.substring(0, 1500) : out);
                postTask(id, RepairPolicy.ST_SUCCESS, "adbd-5555", result);
                writeLastTaskId(id);
                writeTaskPhase(RepairPolicy.PHASE_DONE);
                store.setLastStatus("修机成功 重启本机adbd");
                RuntimeLog.event("task_adbd_complete");
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
            try{JSONObject coreLog=CoreClient.request("/push/log",null);if(coreLog!=null)files.put("独立核心日志",coreLog.getString("text"));}
            catch(Exception unavailable){incomplete=true;}
            String[] paths = RepairPolicy.LOG_PATHS;
            for (int i = 0; i < paths.length; i++) {
                incomplete |= addLogFile(files, new java.io.File(paths[i]));
            }
            incomplete |= addLogFile(files, new java.io.File(getFilesDir(), "heal.log"));
            incomplete |= addLogFile(files, new java.io.File(getFilesDir(), "core-stage/last-failure.out"));
            incomplete |= addLogFile(files, new java.io.File(getFilesDir(), "core-stage/initialize-failure.out"));
            incomplete |= addLogFile(files, new java.io.File(getFilesDir(), "core-stage/startup-"+BuildConfig.VERSION_CODE+".out"));
            incomplete |= addLogFile(files, new java.io.File(getFilesDir(), "watchdog/initialize.out"));
            incomplete |= addLogFile(files, new java.io.File(getFilesDir(), "watchdog/last-failure.out"));
            incomplete |= addLogFile(files, new java.io.File(getFilesDir(), "watchdog/root-probe.out"));
            incomplete |= addLogFile(files, new java.io.File(getFilesDir(), "watchdog/initialize-before-" + BuildConfig.VERSION_CODE + ".out"));
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
            String taskError=Protocol.formatNetError(e);
            if(RepairPolicy.configType(offer.optString("type")) || "set_lost_mode".equals(offer.optString("type")) || "wipe_data".equals(offer.optString("type"))) {
                String code=e.getMessage();taskError=code!=null && code.matches("[a-z][a-z-]{1,79}")?code:"configuration-operation-failed";
            }
            try {
                postTask(id, RepairPolicy.ST_FAILED, taskError, null);
            } catch (Exception e2) {
                android.util.Log.w("elfRemote", "task fail-post " + e2.getMessage());
            }
            writeLastTaskId(id);
            writeTaskPhase(RepairPolicy.PHASE_DONE);
            android.util.Log.w("elfRemote", "task failed " + taskError);
        }
    }

    private final java.util.concurrent.atomic.AtomicBoolean safetyFallback=new java.util.concurrent.atomic.AtomicBoolean();
    private void runLostSafety(JSONObject offer){
        try{CoreClient.request("/lost/safety",offer);return;}catch(Exception unavailable){RuntimeLog.event("lost-safety-core-unavailable");}
        if(!safetyFallback.compareAndSet(false,true))return;
        new Thread(()->{try{
            LostSafety.run(offer,taskReceipts(),p->lostMode.set(p),(id,phase,detail,result)->{
                JSONObject body=new JSONObject().put("device_id",store.deviceId()).put("token",store.token()).put("task_id",id).put("state",phase).put("detail",detail);
                if(result!=null)body.put("result",result);
                JSONObject response=new JSONObject(HttpJson.post(Protocol.taskProgressPath(),body.toString())),actual=response.optJSONObject("task");
                if(!response.optBoolean("ok")||actual==null||!id.equals(actual.optString("id"))||(TaskReceipts.terminal(phase)&&!phase.equals(actual.optString("state"))))throw new java.io.IOException("lost-safety-receipt-pending");
            },System.currentTimeMillis());
        }catch(Exception failure){RuntimeLog.event("lost-safety-fallback-pending");}
        finally{safetyFallback.set(false);}},"elfremote-safety-fallback").start();
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
                String marker = rebootMarker(id);
                String outcome = RebootPolicy.outcome(previous, boot, readTaskState(marker),
                        new java.io.File(marker + ".failed").isFile(), System.currentTimeMillis());
                if ("waiting".equals(outcome)) { scheduleReport(5000L); return; }
                boolean confirmed = "confirmed".equals(outcome);
                postTask(id, confirmed ? RepairPolicy.ST_SUCCESS : RepairPolicy.ST_FAILED,
                        confirmed ? "设备已重启并重新上线" : "未能确认本次重启完成，请重新下发",
                        new JSONObject().put("stage", "reboot").put("action", outcome));
                RuntimeLog.event("task_reboot_result " + outcome);
                return;
            }
            String reason = RepairPolicy.rejectReason(offer, System.currentTimeMillis());
            if (!reason.isEmpty()) { postTask(id, RepairPolicy.ST_REJECTED, reason, null); return; }
            ensureHealIdle();
            postTask(id, RepairPolicy.ST_CLAIMED, "claimed", null);
            postTask(id, RepairPolicy.ST_RUNNING, "reboot", null);
            long deadline = Math.min(offer.optLong("expires_at"), System.currentTimeMillis() + RebootPolicy.WINDOW_MS);
            writeSmall(path, new JSONObject().put("format", 2).put("task_id", id).put("device_id", store.deviceId())
                    .put("boot", boot).put("deadline", deadline).toString());
            armHealCmd(RebootPolicy.command(deadline, boot, rebootMarker(id)));
            RuntimeLog.event("task_reboot_armed");
            scheduleReport(5000L);
        } catch (Exception error) {
            RuntimeLog.error("task_reboot_pending", error);
            // 留下的意图最多等待到截止时间；领取或武装失败也必须给出实际失败结果。
            try { postTask(id, RepairPolicy.ST_FAILED, "重启命令准备失败：" + error.getMessage(),
                    new JSONObject().put("stage", "reboot").put("action", "prepare-failed")); }
            catch (Exception pending) { scheduleReport(5000L); }
        }
    }

    private String rebootMarker(String id) {
        return new java.io.File(WatchdogPolicy.DIR, "reboot-" + RepairPolicy.sha256Hex(id.getBytes(java.nio.charset.StandardCharsets.UTF_8)) + ".executed").getPath();
    }

    private void armReboot() throws Exception {
        armHealCmd(RepairPolicy.rebootCommand());
    }

    private void ensureHealIdle() throws java.io.IOException {
        java.io.File dir = new java.io.File("/data/local/elfremote");
        if (new java.io.File(dir, "heal.cmd").exists() || new java.io.File(dir, "heal.running").exists()
                || new java.io.File(dir, "update.running").exists()) throw new java.io.IOException("root-command-busy");
    }

    private void armHealCmd(String cmd) throws Exception {
        synchronized (BootstrapRoot.QUEUE_LOCK) {
        ensureHealIdle();
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
        if (cmdf.exists()) throw new java.io.IOException("root-command-busy");
        String boot = readBootId();
        if (boot.isEmpty()) throw new java.io.IOException("boot identity unavailable");
        writeSmall(new java.io.File(dir, "heal.boot").getPath(), boot);
        if (!tmp.renameTo(cmdf)) throw new Exception("heal-arm-fail");
        }
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
                if (!reply.optBoolean("ok") || task == null || !taskId.equals(task.optString("id")) || !(state.equals(task.optString("state")) || ("claimed".equals(state) && "running".equals(task.optString("state")))))
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
            if (UpdatePolicy.ST_SUCCESS.equals(disk) || UpdatePolicy.ST_RECOVERED.equals(disk)
                    || UpdatePolicy.ST_REJECTED.equals(disk)) {
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
            int coreCode=0;
            if(CoreInstaller.ready())try{JSONObject core=CoreClient.health();if(core.optBoolean("independent_push"))coreCode=core.optInt("version_code");}catch(Exception unavailable){}
            if(push!=null)push.ensure();
            if (!UpdatePolicy.maintenanceHealthy(h, wantName, want,WatchdogInstaller.ready(),coreCode)) {
                RuntimeLog.event("update_health_wait version=" + h.versionCode
                        + " target=" + want + " identity=" + h.identityOk + " report=" + h.reportOk+" core="+coreCode);
                if (worker != null) worker.postDelayed(healthCheck, 5000L);
                return;
            }
            writeSmall("/data/local/elfremote/health.ok", String.valueOf(want));
            if (worker != null) worker.postDelayed(healthCheck, 5000L);
        } catch (Exception e) {
            RuntimeLog.error("update_health_pending", e);
            if(worker!=null){worker.removeCallbacks(healthCheck);worker.postDelayed(healthCheck,5000L);}
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
                .put("job_id", job).put("detail", UpdatePolicy.ST_REJECTED.equals(terminal) ? state.optString("detail", "invalid-update")
                        : UpdatePolicy.ST_SUCCESS.equals(terminal) ? "health-ok" : "last-good");
        body.put("state", UpdatePolicy.ST_REJECTED.equals(terminal) ? UpdatePolicy.ST_CLAIMED
                : UpdatePolicy.ST_SUCCESS.equals(terminal) ? UpdatePolicy.ST_WAIT_HEALTH : UpdatePolicy.ST_ROLLBACK);
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

    private void putBattery(JSONObject body) throws Exception {
        Intent snapshot = registerReceiver(null, new android.content.IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        if (snapshot == null) return;
        int level = snapshot.getIntExtra(android.os.BatteryManager.EXTRA_LEVEL, -1);
        int scale = snapshot.getIntExtra(android.os.BatteryManager.EXTRA_SCALE, 100);
        if (level >= 0 && scale > 0) body.put("battery", Math.round(level * 100f / scale));
        // 满电仍接着电源时保留充电标志，与设备日常管理的显示含义一致。
        int plugged = snapshot.getIntExtra(android.os.BatteryManager.EXTRA_PLUGGED, -1);
        if (plugged >= 0) body.put("charging", plugged > 0);
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
        String file=FileInbox.notificationText(this);
        if(!file.isEmpty())text+=" · "+file.replace('\n',' ');
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
        if(!file.isEmpty()){
            Intent intent=new Intent(this,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
            b.setContentIntent(android.app.PendingIntent.getActivity(this,4,intent,
                    android.app.PendingIntent.FLAG_UPDATE_CURRENT|android.app.PendingIntent.FLAG_IMMUTABLE));
            b.setStyle(new Notification.BigTextStyle().bigText(text));
        }else if (!WatchdogPolicy.notificationLaunchesUi()) {
            b.setContentIntent(null);
        }
        return b.build();
    }
}

