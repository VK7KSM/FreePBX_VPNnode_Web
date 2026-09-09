package net.elfradio.elfremote;

import android.content.Context;
import android.content.SharedPreferences;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.SystemClock;

final class DailyLocation {
    static final long INTERVAL_MS = 900000L;
    static final long TIMEOUT_MS = 60000L;
    private final LocationManager manager;
    private final Context context;
    private final SharedPreferences prefs;
    private final Handler worker;
    private LocationListener listener;
    private Runnable completion;
    private final Runnable timeout = () -> finish("timeout");
    private String reason = "not_sampled";
    private boolean gpsRequested;
    private long freshSinceNanos;
    private long sampleTimeoutMs=TIMEOUT_MS;

    DailyLocation(Context context, Handler worker) {
        this.context = context.getApplicationContext();
        this.manager = (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
        this.prefs = context.getSharedPreferences("daily-location", Context.MODE_PRIVATE);
        this.worker = worker;
    }

    static boolean due(long previous, long now) {
        return previous <= 0 || now < previous || now - previous >= INTERVAL_MS;
    }

    static boolean recent(long sampleNanos, long nowNanos) {
        return sampleNanos > 0 && nowNanos >= sampleNanos && nowNanos - sampleNanos <= 900000000000L;
    }

    static boolean shouldStart(long sampleAttempt, long permissionAttempt, boolean granted, long now) {
        return due(sampleAttempt, now) || (!granted && due(permissionAttempt, now));
    }

    String reason() { return "sampled".equals(reason) || "recent_cache".equals(reason) ? "no_cached_location" : reason; }
    String outcome() { return reason; }

    static boolean freshForRequest(long sample, long now, long since) {
        return recent(sample, now) && (since == 0 || sample >= since);
    }

    void requestNow(Runnable then) {
        freshSinceNanos = SystemClock.elapsedRealtimeNanos();
        beforePeriodicReport(then);
    }

    void requestMovement(Runnable then){
        if(completion==null){freshSinceNanos=SystemClock.elapsedRealtimeNanos();sampleTimeoutMs=20000L;}
        beforePeriodicReport(then);
    }

    void beforePeriodicReport(Runnable then) {
        if (completion != null) {
            Runnable previous = completion;
            completion = () -> { previous.run(); then.run(); };
            return;
        }
        long now = System.currentTimeMillis();
        boolean granted = PermissionGate.hasLocation(context);
        if (freshSinceNanos == 0 && !"not_sampled".equals(reason) && !shouldStart(prefs.getLong("attempt_at", 0), prefs.getLong("permission_attempt_at", 0), granted, now)) { then.run(); return; }
        SharedPreferences.Editor editor = prefs.edit().putLong("attempt_at", now);
        if (!granted) editor.putLong("permission_attempt_at", now);
        if (!editor.commit()) {
            reason = "schedule_unavailable"; freshSinceNanos = 0; then.run(); return;
        }
        completion = then;
        try {
            if (manager == null) { finish("provider_unavailable"); return; }
            if (!enabled(LocationManager.GPS_PROVIDER) && !enabled(LocationManager.NETWORK_PROVIDER)) {
                finish("location_disabled"); return;
            }
        } catch (Exception error) {
            RuntimeLog.error("daily_location_provider_check_failed", error);
            finish("provider_unavailable"); return;
        }
        if (!granted) {
            PermissionGate.initializeLocation(context, worker, () -> {
                if (completion == null) return;
                if (PermissionGate.hasLocation(context)) startSampling();
                else finish("permission_denied");
            });
        } else startSampling();
    }

    private void startSampling() {
        if (manager == null) { finish("provider_unavailable"); return; }
        try {
            boolean gps = enabled(LocationManager.GPS_PROVIDER);
            boolean network = enabled(LocationManager.NETWORK_PROVIDER);
            if (!gps && !network) { finish("location_disabled"); return; }
            for (String provider : new String[]{LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER}) {
                if (!enabled(provider)) continue;
                Location saved = manager.getLastKnownLocation(provider);
                if (saved != null && (!gps || LocationManager.GPS_PROVIDER.equals(provider))
                        && freshSinceNanos == 0 && recent(saved.getElapsedRealtimeNanos(), SystemClock.elapsedRealtimeNanos())) {
                    finish("recent_cache"); return;
                }
            }
            gpsRequested = gps;
            listener = new LocationListener() {
                @Override public void onLocationChanged(Location location) {
                    if (completion == null || !freshForRequest(location.getElapsedRealtimeNanos(), SystemClock.elapsedRealtimeNanos(), freshSinceNanos)) return;
                    if (!gpsRequested || LocationManager.GPS_PROVIDER.equals(location.getProvider())) finish("sampled");
                }
                @Override public void onStatusChanged(String provider, int status, Bundle extras) {}
                @Override public void onProviderEnabled(String provider) {}
                @Override public void onProviderDisabled(String provider) {
                    if (LocationManager.GPS_PROVIDER.equals(provider)) gpsRequested = false;
                }
            };
            // 同一工作线程收取回调，超时移除监听；不持有永久唤醒锁，也不修改定位开关。
            worker.postDelayed(timeout, sampleTimeoutMs);
            if (gps) manager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000L, 0, listener, worker.getLooper());
            if (network) manager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 1000L, 0, listener, worker.getLooper());
            reason = "sampling";
            RuntimeLog.event("daily_location_start gps=" + gps + " network=" + network);
        } catch (SecurityException denied) { finish("permission_denied"); }
        catch (Exception error) { RuntimeLog.error("daily_location_failed", error); finish("provider_unavailable"); }
    }

    private boolean enabled(String provider) {
        return manager.getAllProviders().contains(provider) && manager.isProviderEnabled(provider);
    }

    private void finish(String outcome) {
        reason = outcome;
        freshSinceNanos = 0;
        sampleTimeoutMs=TIMEOUT_MS;
        worker.removeCallbacks(timeout);
        if (listener != null) {
            try { manager.removeUpdates(listener); }
            catch (Exception error) { RuntimeLog.error("daily_location_cleanup_failed", error); }
            listener = null;
        }
        Runnable then = completion;
        completion = null;
        RuntimeLog.event("daily_location_end reason=" + outcome);
        if (then != null) then.run();
    }

    void close() { completion = null; finish("service_stopped"); }
}
