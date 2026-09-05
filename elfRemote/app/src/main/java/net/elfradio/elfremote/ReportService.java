package net.elfradio.elfremote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import org.json.JSONObject;

public final class ReportService extends Service {
    static final String ACTION_REPORT_NOW = "net.elfradio.elfremote.REPORT_NOW";
    private static final String CHANNEL = "elfremote";
    private final Handler handler = new Handler(Looper.getMainLooper());
    private PairingStore store;
    private boolean loopStarted;

    private final Runnable loop = new Runnable() {
        @Override
        public void run() {
            new Thread(ReportService.this::tick, "elfremote-net").start();
            long delay = store.paired() ? 30000L : 3000L;
            handler.postDelayed(this, delay);
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        store = new PairingStore(this);
        startForeground(7, buildNotification());
        if (!loopStarted) {
            loopStarted = true;
            handler.post(loop);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_REPORT_NOW.equals(intent.getAction())) {
            new Thread(this::tick, "elfremote-now").start();
        }
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(loop);
        super.onDestroy();
    }

    private void tick() {
        try {
            if (!store.paired()) enrollOrPoll();
            else report();
        } catch (Exception e) {
            android.util.Log.w("elfRemote", "tick failed", e);
            store.setLastStatus(Protocol.formatNetError(e));
        }
        handler.post(() -> startForeground(7, buildNotification()));
    }

    private void enrollOrPoll() throws Exception {
        if (store.code().length() != 6 || store.enrollId().length() == 0) {
            JSONObject body = new JSONObject();
            body.put("token_sha256", store.tokenSha256());
            body.put("app_version", Protocol.APP_VERSION);
            body.put("os_version", "Android " + Build.VERSION.RELEASE);
            body.put("model_hint", "D22");
            JSONObject res = Protocol.parseObject(HttpJson.post(Protocol.enrollPath(), body.toString()));
            if (!Protocol.isOk(res)) {
                store.setLastStatus(res.optString("msg", "申请配对码失败"));
                return;
            }
            store.saveEnroll(res.getString("code"), res.getString("enroll_id"));
            store.setLastStatus(getString(R.string.waiting_pair));
            return;
        }
        JSONObject res = Protocol.parseObject(HttpJson.get(
                Protocol.enrollStatusPath(store.code(), store.enrollId())));
        if (Protocol.isOk(res) && res.optBoolean("paired", false)) {
            store.savePaired(res.getString("device_id"));
            store.setLastStatus(getString(R.string.paired));
            report();
        } else {
            store.setLastStatus(getString(R.string.waiting_pair));
        }
    }

    private void report() throws Exception {
        JSONObject body = new JSONObject();
        body.put("device_id", store.deviceId());
        body.put("token", store.token());
        body.put("app_version", Protocol.APP_VERSION);
        body.put("os_version", "Android " + Build.VERSION.RELEASE);
        body.put("network", networkType());
        body.put("battery", batteryPct());
        body.put("ready", true);
        JSONObject res = Protocol.parseObject(HttpJson.post(Protocol.reportPath(), body.toString()));
        if (Protocol.isOk(res)) store.setLastStatus("已上报");
        else store.setLastStatus(res.optString("msg", "上报失败"));
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
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) nm.createNotificationChannel(ch);
        }
        PendingIntent pi = PendingIntent.getActivity(
                this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_UPDATE_CURRENT);
        String text = store.paired()
                ? getString(R.string.notify_online)
                : getString(R.string.notify_waiting);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL)
                : new Notification.Builder(this);
        return b.setContentTitle(getString(R.string.notify_title))
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_sys_upload)
                .setContentIntent(pi)
                .setOngoing(true)
                .build();
    }
}
