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
    private final Runnable timeout = this::samplingTimedOut;
    private final Runnable retry = this::startSampling;
    private String reason = "not_sampled";
    private boolean gpsRequested;
    private long freshSinceNanos;
    private long sampleTimeoutMs=TIMEOUT_MS;
    private boolean movementSample;
    private boolean retried;
    private long startedElapsed;

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
        begin(then, false);
    }

    void requestMovement(Runnable then){
        if(completion==null)freshSinceNanos=SystemClock.elapsedRealtimeNanos();
        begin(then, true);
    }

    void beforePeriodicReport(Runnable then) {
        begin(then, false);
    }

    // 短移动采样不更新完整采样的节拍，否则每五分钟的尝试会永久推迟整点完整采样。
    static long nextFullAttempt(long previous, long now, boolean movement) {
        return movement ? previous : now;
    }

    static long retryDelay(boolean movement, boolean retried) {
        return !movement && !retried ? 5000L : 0;
    }

    private void begin(Runnable then, boolean movement) {
        if (completion != null) {
            if (!movement && movementSample) {
                movementSample = false;
                sampleTimeoutMs = TIMEOUT_MS;
                prefs.edit().putLong("full_attempt_at", System.currentTimeMillis()).apply();
                worker.removeCallbacks(timeout);
                worker.postDelayed(timeout, sampleTimeoutMs);
                WakeScheduler.hold(context, "location", 120000L);
            }
            Runnable previous = completion;
            completion = () -> { previous.run(); then.run(); };
            return;
        }
        long now = System.currentTimeMillis();
        boolean granted = PermissionGate.hasLocation(context);
        if (freshSinceNanos == 0 && !"not_sampled".equals(reason) && !shouldStart(prefs.getLong("full_attempt_at", 0), prefs.getLong("permission_attempt_at", 0), granted, now)) { then.run(); return; }
        SharedPreferences.Editor editor = prefs.edit().putLong("attempt_at", now)
                .putLong("full_attempt_at", nextFullAttempt(prefs.getLong("full_attempt_at", 0), now, movement));
        if (!granted) editor.putLong("permission_attempt_at", now);
        if (!editor.commit()) {
            reason = "schedule_unavailable"; freshSinceNanos = 0; then.run(); return;
        }
        completion = then;
        movementSample = movement;
        sampleTimeoutMs = movement ? 20000L : TIMEOUT_MS;
        retried = false;
        startedElapsed = SystemClock.elapsedRealtime();
        WakeScheduler.hold(context, "location", movement ? 30000L : 120000L);
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
            // 同一工作线程收取回调；仅在有限采样窗口持有唤醒锁，不修改定位开关。
            worker.removeCallbacks(timeout);
            worker.postDelayed(timeout, sampleTimeoutMs);
            if (gps) manager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000L, 0, listener, worker.getLooper());
            if (network) manager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 1000L, 0, listener, worker.getLooper());
            reason = "sampling";
            RuntimeLog.event("daily_location_start gps=" + gps + " network=" + network
                    + " movement=" + movementSample + " timeout_ms=" + sampleTimeoutMs + " retry=" + retried);
        } catch (SecurityException denied) { finish("permission_denied"); }
        catch (Exception error) { RuntimeLog.error("daily_location_failed", error); finish("provider_unavailable"); }
    }

    private boolean enabled(String provider) {
        return manager.getAllProviders().contains(provider) && manager.isProviderEnabled(provider);
    }

    private void samplingTimedOut() {
        long delay = retryDelay(movementSample, retried);
        if (delay == 0) { finish("timeout"); return; }
        // MTK偶发NMEA超时后会自行恢复；释放本次请求，稍后重新注册一次，不重启系统服务。
        retried = true;
        removeListener();
        sampleTimeoutMs = 30000L;
        freshSinceNanos = SystemClock.elapsedRealtimeNanos();
        RuntimeLog.event("daily_location_retry delay_ms=" + delay);
        worker.postDelayed(retry, delay);
    }

    private void removeListener() {
        if (listener == null) return;
        try { manager.removeUpdates(listener); }
        catch (Exception error) { RuntimeLog.error("daily_location_cleanup_failed", error); }
        listener = null;
    }

    private void finish(String outcome) {
        reason = outcome;
        freshSinceNanos = 0;
        sampleTimeoutMs=TIMEOUT_MS;
        worker.removeCallbacks(timeout);
        worker.removeCallbacks(retry);
        removeListener();
        WakeScheduler.release("location");
        Runnable then = completion;
        completion = null;
        RuntimeLog.event("daily_location_end reason=" + outcome + " movement=" + movementSample
                + " retried=" + retried + " duration_ms=" + Math.max(0, SystemClock.elapsedRealtime() - startedElapsed));
        if (then != null) then.run();
    }

    void close() { completion = null; finish("service_stopped"); }
}
