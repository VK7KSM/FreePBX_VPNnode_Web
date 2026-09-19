package org.onetwoone.gateway.remote;

import android.app.*;
import android.content.*;
import android.net.*;
import android.os.*;
import org.json.JSONObject;
import org.onetwoone.gateway.PjsipSipService;

/** Reports gateway health and hands authenticated maintenance offers to isolated workers. */
public final class GatewayRemoteService extends Service {
    static final String ACTION_PUSH="org.onetwoone.gateway.remote.PUSH";
    private HandlerThread thread;
    private Handler worker;
    private HandlerThread coreThread;
    private Handler coreWorker;
    private AlarmManager coreAlarms;
    private AlarmManager.OnAlarmListener coreAlarm;
    private GatewayAppHealth appHealth;
    private GatewayUpdateLauncher updates;
    private int coreFailures;
    private final Runnable coreCheck=this::checkCore;
    private final Runnable coreTick=this::tickCore;
    private GatewayRemoteStore store;
    private GatewayManagedSipTasks sipTasks;
    private GatewayManagedWifiTasks wifiTasks;
    private GatewayManagedFileTasks fileTasks;
    private GatewayManagedTransferTasks transferTasks;
    private GatewayManagedExecTasks execTasks;
    private GatewayLocationSampler location;
    private GatewayManagedLostTasks lostTasks;
    private GatewayLostDisplay lostDisplay;
    private GatewayManagedProxyTasks proxyTasks;
    private GatewayManagedCompanionTasks companionTasks;
    private GatewayDesktopSession desktop;
    private boolean proxyAssetsChecked;
    private boolean desktopAssetsChecked;
    private volatile boolean stopped;
    private int failures;
    private volatile long nextAttempt;
    private JSONObject pendingReport;
    private final Runnable report = this::tick;

    public static void start(Context context) {
        Intent intent = new Intent(context, GatewayRemoteService.class);
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent); else context.startService(intent);
    }
    @Override public void onCreate() {
        super.onCreate();
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel("gateway-management", "elfRemote Gateway", NotificationManager.IMPORTANCE_MIN);
            channel.setSound(null, null); channel.enableVibration(false); manager.createNotificationChannel(channel);
        }
        Notification.Builder notification = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this,"gateway-management") : new Notification.Builder(this);
        startForeground(2401, notification.setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
                .setContentTitle("elfRemote Gateway").setContentText(getString(org.onetwoone.gateway.R.string.remote_notification)).setOngoing(true).setShowWhen(false).build());
        store = new GatewayRemoteStore(this);
        updates=new GatewayUpdateLauncher(this,store);
        try {appHealth=new GatewayAppHealth(this);} catch(java.io.IOException unavailable) {
            store.prefs.edit().putString("health_endpoint_error",unavailable.getClass().getSimpleName()).apply();
        }
        thread = new HandlerThread("gateway-management"); thread.start(); worker = new Handler(thread.getLooper());
        sipTasks = new GatewayManagedSipTasks(this,store,this::scheduleImmediateReport);
        wifiTasks = new GatewayManagedWifiTasks(this,store,worker,this::scheduleImmediateReport);
        fileTasks = new GatewayManagedFileTasks(this,store,this::scheduleImmediateReport);
        transferTasks = new GatewayManagedTransferTasks(this,store,this::scheduleImmediateReport);
        execTasks = new GatewayManagedExecTasks(this,store,this::scheduleImmediateReport);
        lostDisplay = new GatewayLostDisplay(this);
        location = new GatewayLocationSampler(this,worker,this::scheduleImmediateReport);
        lostTasks = new GatewayManagedLostTasks(this,store,location,new GatewayAlarmPlayer(this,worker,this::scheduleImmediateReport),lostDisplay,this::scheduleImmediateReport);
        proxyTasks = new GatewayManagedProxyTasks(this,store,this::scheduleImmediateReport);
        companionTasks = new GatewayManagedCompanionTasks(this,store,this::scheduleImmediateReport);
        desktop = new GatewayDesktopSession(this,new java.io.File(getFilesDir(),"desktop"));
        worker.post(wifiTasks::tick);
        worker.post(fileTasks::tick);
        worker.post(transferTasks::tick);
        worker.post(execTasks::tick);
        worker.post(lostTasks::tick);
        worker.post(proxyTasks::tick);
        worker.post(companionTasks::tick);
        location.begin();
        coreThread=new HandlerThread("gateway-core-monitor");coreThread.start();
        coreWorker=new Handler(coreThread.getLooper());coreAlarms=getSystemService(AlarmManager.class);
        coreAlarm=()->coreWorker.post(coreTick);coreWorker.post(coreCheck);
    }
    private void checkCore() {
        if(stopped)return;
        long delay=60_000L;
        try {
            if(!proxyAssetsChecked)try {
                GatewayProxyAssets.manifest(this);JSONObject proxyAsset=GatewayProxyAssets.stage(this);
                store.prefs.edit().putString("proxy_asset",proxyAsset.toString()).remove("proxy_asset_error").apply();proxyAssetsChecked=true;
            } catch(Exception unavailable) {
                store.prefs.edit().remove("proxy_asset").putString("proxy_asset_error",unavailable.getClass().getSimpleName()).apply();
            }
            JSONObject health=GatewayCoreClient.ensure(this);
            boolean ready=health.optInt("uid",-1)==0;
            try {
                if(!desktopAssetsChecked){GatewayScrcpyAsset.stage(this);desktopAssetsChecked=true;}
                JSONObject screen=GatewayCoreClient.prepareDesktop(this);
                store.prefs.edit().putBoolean("desktop_ready",screen.optBoolean("installed")).remove("desktop_error").apply();
            } catch(Exception unavailable){
                desktopAssetsChecked=false;
                store.prefs.edit().putBoolean("desktop_ready",false).putString("desktop_error",unavailable.getClass().getSimpleName()).apply();
            }
            try {JSONObject proxy=GatewayCoreClient.prepareProxy(this);GatewayProxyRoute.setPreferred(proxy.optBoolean("proxy_reachable")&&proxy.optBoolean("http_ready"));store.prefs.edit().putString("proxy_runtime",proxy.toString()).remove("proxy_runtime_error").apply();}
            catch(Exception unavailable){store.prefs.edit().remove("proxy_runtime").putString("proxy_runtime_error",unavailable.getClass().getSimpleName()).apply();}
            JSONObject push=store.prefs.getBoolean("paired",false)&&!store.deviceId().isEmpty()
                    ?GatewayCoreClient.configurePush(this,store.deviceId(),store.token()):null;
            store.prefs.edit().putBoolean("core_ready",ready).putInt("core_version",health.optInt("version_code"))
                    .putBoolean("push_connected",push!=null&&push.optBoolean("connected")).apply();
            try {
                JSONObject assets=GatewayPixelAssets.verify(this);
                JSONObject modules=GatewayCoreClient.pixelModuleHealth(this);
                store.prefs.edit().putBoolean("pixel_assets_verified",assets.optBoolean("verified"))
                        .putString("pixel_module_health",modules.toString()).remove("pixel_module_error").apply();
            } catch(Exception unavailable) {
                store.prefs.edit().putBoolean("pixel_assets_verified",false)
                        .putString("pixel_module_error",unavailable.getClass().getSimpleName()).apply();
            }
            try {store.prefs.edit().putString("pixel_runtime_health",GatewayCoreClient.pixelRuntimeHealth(this).toString()).remove("pixel_runtime_health_error").apply();}
            catch(Exception unavailable){store.prefs.edit().remove("pixel_runtime_health").putString("pixel_runtime_health_error",unavailable.getClass().getSimpleName()).apply();}
            try {
                JSONObject mobile=GatewayCoreClient.mobileStatus(this),status=mobile.getJSONObject("mobile_status");
                android.content.SharedPreferences.Editor edit=store.prefs.edit().putString("mobile_status",status.toString());
                String category=mobile.optString("mobile_error","");
                if(category.isEmpty())edit.remove("mobile_status_error");else edit.putString("mobile_status_error",category);
                edit.apply();
            } catch(Exception unavailable) {
                store.prefs.edit().remove("mobile_status").putString("mobile_status_error",unavailable.getClass().getSimpleName()).apply();
            }
            scheduleCoreWake(push==null?-1:push.optLong("next_wake_delay_ms",-1));
            coreFailures=0;
        } catch(Exception unavailable) {
            store.prefs.edit().putBoolean("core_ready",false).apply();
            delay=GatewayRemotePolicy.retryDelay(++coreFailures);
        }
        if(!stopped)coreWorker.postDelayed(coreCheck,delay);
        try {updates.tick();}catch(Exception error) {
            store.prefs.edit().putString("update_error",error.getClass().getSimpleName()).apply();
        }
        sipTasks.tick();
        transferTasks.tick();
        proxyTasks.tick();
        companionTasks.tick();
        PjsipSipService service=PjsipSipService.getInstance();lostDisplay.ensureVisible(service==null?null:service.remoteBusy());
    }
    private void tickCore(){
        if(stopped)return;
        try{GatewayCoreClient.tickPush(this);}catch(Exception unavailable){store.prefs.edit().putBoolean("push_connected",false).apply();}
        coreWorker.removeCallbacks(coreCheck);coreWorker.postDelayed(coreCheck,1000);
    }
    private void scheduleCoreWake(long delay){
        coreWorker.removeCallbacks(coreTick);if(coreAlarms!=null&&coreAlarm!=null)try{coreAlarms.cancel(coreAlarm);}catch(Exception ignored){}
        if(delay<0||stopped)return;long bounded=Math.max(1000,Math.min(900000,delay));
        try{coreAlarms.setExact(AlarmManager.ELAPSED_REALTIME_WAKEUP,SystemClock.elapsedRealtime()+bounded,"elfRemote:gateway-core",coreAlarm,coreWorker);}
        catch(SecurityException unavailable){coreWorker.postDelayed(coreTick,bounded);}
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        worker.post(() -> {
            worker.removeCallbacks(report);
            if(intent!=null&&ACTION_PUSH.equals(intent.getAction())) {
                consumePush();worker.post(report);
            } else worker.postDelayed(report, Math.max(0, nextAttempt - SystemClock.elapsedRealtime()));
        });
        return START_STICKY;
    }
    private void consumePush() {
        try {
            JSONObject status=GatewayCoreClient.pushStatus(this),pending=status.optJSONObject("pending");if(pending==null)return;
            JSONObject reply=pending.getJSONObject("reply");desktop.accept(reply);updates.accept(reply);sipTasks.accept(reply);wifiTasks.accept(reply);fileTasks.accept(reply);transferTasks.accept(reply);execTasks.accept(reply);lostTasks.accept(reply);proxyTasks.accept(reply);companionTasks.accept(reply);
            JSONObject request=reply.optJSONObject("status_request");
            if(request!=null&&request.optString("request_id").matches("[A-Za-z0-9-]{1,96}"))
                if(!store.prefs.edit().putString("status_request_id",request.getString("request_id")).commit())
                    throw new java.io.IOException("push receipt persistence failed");
            updates.tick();GatewayCoreClient.acknowledgePush(this,pending.getString("delivery_id"));
            store.prefs.edit().putString("push_error","").putBoolean("push_connected",status.optBoolean("connected")).apply();
        } catch(Exception error){store.prefs.edit().putString("push_error",error.getClass().getSimpleName()).apply();}
    }
    private void tick() {
        if (stopped) return;
        long delay = GatewayRemotePolicy.REPORT_MS;
        try {
            if (store.deviceId().isEmpty() || (!store.prefs.getBoolean("paired",false) && store.enrollmentExpired())) {
                JSONObject registration = GatewayRemotePolicy.profile().put("token",store.token())
                        .put("token_sha256",GatewayRemoteStore.hash(store.token())).put("device_name","Pixel Gateway")
                        .put("app_version",version()).put("os_version","Android "+Build.VERSION.RELEASE);
                store.registered(GatewayRemoteHttp.request("/api/devices/enroll",registration));
            }
            if (!store.prefs.getBoolean("paired",false)) {
                String query = "/api/devices/enroll-status?code=" + java.net.URLEncoder.encode(store.prefs.getString("code",""),"UTF-8")
                        + "&enroll_id=" + java.net.URLEncoder.encode(store.prefs.getString("enroll_id",""),"UTF-8");
                JSONObject status = GatewayRemoteHttp.request(query,null);
                if (status.optBoolean("paired")) store.registered(status);
            }
            if (pendingReport == null && store.prefs.contains("pending_report")) {
                pendingReport = GatewayReportOutbox.resume(store.prefs.getString("pending_report","{}"),version());
                if(pendingReport==null&&!store.prefs.edit().remove("pending_report").commit())
                    throw new java.io.IOException("stale report cleanup failed");
            }
            if (pendingReport == null) pendingReport = snapshot();
            if (!store.prefs.edit().putString("pending_report",pendingReport.toString()).commit()) {
                throw new java.io.IOException("report persistence failed");
            }
            JSONObject reply=GatewayRemoteHttp.request("/api/devices/report",pendingReport);
            if(!pendingReport.getString("report_id").equals(reply.optString("report_id")))
                throw new java.io.IOException("report acknowledgement mismatch");
            desktop.accept(reply);updates.accept(reply);sipTasks.accept(reply);wifiTasks.accept(reply);fileTasks.accept(reply);transferTasks.accept(reply);execTasks.accept(reply);lostTasks.accept(reply);proxyTasks.accept(reply);companionTasks.accept(reply);
            if (!store.prefs.edit().remove("pending_report").commit()) {
                throw new java.io.IOException("report acknowledgement persistence failed");
            }
            String reportedRequest=pendingReport.optString("status_request_id");
            if(!reportedRequest.isEmpty()&&reportedRequest.equals(store.prefs.getString("status_request_id","")))
                store.prefs.edit().remove("status_request_id").apply();
            pendingReport = null;
            failures = 0;
            store.prefs.edit().putString("last_error", "").putLong("last_report", System.currentTimeMillis()).apply();
        } catch (Exception error) {
            delay = GatewayRemotePolicy.retryDelay(++failures);
            if (error instanceof GatewayRemoteHttp.RetryLater) delay = Math.max(delay,((GatewayRemoteHttp.RetryLater)error).delayMs);
            if (error instanceof GatewayRemoteHttp.PairingRequired) {
                // Backend no longer knows our device id: forget it and re-enrol next tick with the same token.
                try { store.forgetRegistration(); pendingReport = null; failures = 0; delay = 5_000L; }
                catch (Exception reset) { error = reset; }
            }
            // Never persist server response bodies or credentials in diagnostics.
            store.prefs.edit().putString("last_error", error instanceof java.io.IOException ? error.getMessage() : error.getClass().getSimpleName()).apply();
        } finally {
            nextAttempt = SystemClock.elapsedRealtime() + delay;
            if (!stopped) { worker.removeCallbacks(report); worker.postDelayed(report, delay); }
        }
    }
    private void scheduleImmediateReport() {
        Handler current=worker;if(current==null||stopped)return;
        current.post(()->{if(stopped)return;current.removeCallbacks(report);current.post(report);});
    }
    private String version() throws Exception { return getPackageManager().getPackageInfo(getPackageName(),0).versionName; }
    private JSONObject snapshot() throws Exception {
        JSONObject body = GatewayRemotePolicy.profile().put("device_id",store.deviceId()).put("token",store.token())
                .put("app_version",version()).put("os_version","Android "+Build.VERSION.RELEASE)
                .put("report_id",java.util.UUID.randomUUID().toString()).put("sampled_at_ms",System.currentTimeMillis())
                .put("queued_at_ms",System.currentTimeMillis()).put("status_only",true)
                .put("reported_at",java.time.Instant.now().toString()).put("ready",false);
        String statusRequest=store.prefs.getString("status_request_id","");if(!statusRequest.isEmpty())body.put("status_request_id",statusRequest);
        ConnectivityManager cm = getSystemService(ConnectivityManager.class);
        NetworkCapabilities net = cm.getNetworkCapabilities(cm.getActiveNetwork());
        String network=net == null ? "unknown" : net.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ? "wifi" : net.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) ? "cellular" : net.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) ? "ethernet" : "unknown";
        body.put("network",network);JSONObject fix=location.best(network);if(fix!=null)body.put(fix.getString("bucket"),fix.getJSONObject("value"));
        body.put("battery",JSONObject.NULL).put("battery_present",JSONObject.NULL).put("charging",JSONObject.NULL);
        Intent battery = registerReceiver(null,new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        if (battery != null) {
            int scale=battery.getIntExtra(BatteryManager.EXTRA_SCALE,100),level=battery.getIntExtra(BatteryManager.EXTRA_LEVEL,-1);
            if (scale>0&&level>=0) body.put("battery",Math.round(level*100f/scale));
            body.put("charging",battery.getIntExtra(BatteryManager.EXTRA_PLUGGED,0)!=0);
            body.put("battery_present",battery.getBooleanExtra(BatteryManager.EXTRA_PRESENT,true));
        }
        PjsipSipService gateway=PjsipSipService.getInstance();
        Boolean busy=gateway==null ? null : gateway.remoteBusy();
        body.put("gateway", new JSONObject().put("running",gateway!=null && gateway.isRunning())
                .put("sip_registered",gateway!=null && gateway.isSipRegistered()).put("busy",busy==null?JSONObject.NULL:busy));
        JSONObject sip=sipTasks.targets();body.put("managed_sip_account",sip.getBoolean("managed_sip_account"))
                .put("sip_targets",sip.getJSONArray("sip_targets")).put("sip_registrations",sipTasks.registrations());
        body.put("pixel_runtime",GatewayPixelStatus.snapshot(
                store.prefs.getBoolean("pixel_assets_verified",false),
                store.prefs.getString("pixel_module_health",""),
                store.prefs.getString("pixel_module_error","")));
        String runtimeHealth=store.prefs.getString("pixel_runtime_health","");
        if(!runtimeHealth.isEmpty())body.put("pixel_health",new JSONObject(runtimeHealth));
        body.put("mobile_network",GatewayMobileStatus.stored(store.prefs.getString("mobile_status","")));
        body.put("alarm",lostTasks.alarmSnapshot());
        body.put("lost_display",lostDisplay.snapshot());
        body.put("proxy_runtime",proxyRuntimeStatus());
        // 只有核心里确实装好了 scrcpy 服务端才敢报这项能力，否则面板会给一台开不出画面的设备放行远程桌面。
        body.put("managed_desktop_v1",store.prefs.getBoolean("desktop_ready",false));
        return body;
    }
    private JSONObject proxyRuntimeStatus()throws Exception {
        String runtime=store.prefs.getString("proxy_runtime","");if(!runtime.isEmpty())return new JSONObject(runtime);
        String raw=store.prefs.getString("proxy_asset","");boolean assetVerified=!raw.isEmpty()&&new JSONObject(raw).optBoolean("verified");
        String error=store.prefs.getString("proxy_runtime_error",store.prefs.getString("proxy_asset_error","unavailable"));
        return new JSONObject().put("schema_version",1).put("bundled",true).put("version",GatewayProxyAssets.VERSION).put("abi","arm64-v8a")
                .put("asset_verified",assetVerified).put("core_verified",false).put("configured",false).put("running",false)
                .put("http_ready",false).put("socks_ready",false).put("proxy_reachable",false).put("management_via","direct")
                .put("write_locked",true).put("error",error);
    }
    @Override public void onDestroy() {
        stopped=true;if(desktop!=null)desktop.close();if(transferTasks!=null)transferTasks.close();if(lostTasks!=null)lostTasks.close();if(location!=null)location.close();worker.removeCallbacksAndMessages(null); thread.quitSafely();
        if(appHealth!=null)try{appHealth.close();}catch(java.io.IOException ignored){}
        if(coreAlarms!=null&&coreAlarm!=null)try{coreAlarms.cancel(coreAlarm);}catch(Exception ignored){}
        coreWorker.removeCallbacksAndMessages(null);coreThread.quitSafely();super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
