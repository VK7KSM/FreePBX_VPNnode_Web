package org.onetwoone.gateway.power;

import android.content.Context;
import android.net.wifi.WifiManager;
import android.os.PowerManager;
import android.util.Log;

import org.onetwoone.gateway.RootHelper;

/**
 * Manages power-related settings for the gateway service.
 *
 * Responsibilities:
 * - CPU WakeLock to keep service alive with screen off
 * - Battery optimization disabling via root
 */
public class PowerController {
    private static final String TAG = "PowerCtrl";

    private final Context context;
    private final PowerManager powerManager;
    private final WifiManager wifiManager;

    private PowerManager.WakeLock cpuWakeLock;
    private WifiManager.WifiLock wifiHighPerformanceLock;

    public PowerController(Context context) {
        this.context = context.getApplicationContext();
        this.powerManager = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        this.wifiManager = (WifiManager) context.getApplicationContext()
            .getSystemService(Context.WIFI_SERVICE);
    }

    /**
     * Acquire CPU WakeLock to keep the service running with screen off.
     * This should be called when the service starts.
     */
    public void acquireCpuWakeLock() {
        if (powerManager == null) {
            Log.w(TAG, "PowerManager not available");
            return;
        }

        if (cpuWakeLock != null && cpuWakeLock.isHeld()) {
            Log.d(TAG, "CPU WakeLock already held");
            return;
        }

        cpuWakeLock = powerManager.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "Gateway::CpuWakeLock"
        );
        cpuWakeLock.setReferenceCounted(false);
        cpuWakeLock.acquire();

        Log.i(TAG, "CPU WakeLock acquired - service will stay alive");
    }

    /**
     * Release CPU WakeLock.
     * This should be called when the service stops.
     */
    public void releaseCpuWakeLock() {
        if (cpuWakeLock != null && cpuWakeLock.isHeld()) {
            cpuWakeLock.release();
            Log.i(TAG, "CPU WakeLock released");
        }
        cpuWakeLock = null;
    }

    /**
     * Check if CPU WakeLock is held.
     */
    public boolean isCpuWakeLockHeld() {
        return cpuWakeLock != null && cpuWakeLock.isHeld();
    }

    /**
     * Keep WiFi out of power-save batching while this always-on gateway runs.
     */
    public void acquireWifiHighPerformanceLock() {
        if (wifiManager == null) {
            Log.w(TAG, "WifiManager not available");
            return;
        }

        if (wifiHighPerformanceLock != null && wifiHighPerformanceLock.isHeld()) {
            Log.d(TAG, "WiFi high-performance lock already held");
            return;
        }

        wifiHighPerformanceLock = wifiManager.createWifiLock(
            WifiManager.WIFI_MODE_FULL_HIGH_PERF,
            "Gateway::WifiHighPerformanceLock"
        );
        wifiHighPerformanceLock.setReferenceCounted(false);
        wifiHighPerformanceLock.acquire();

        Log.i(TAG, "WiFi high-performance lock acquired");
    }

    public void releaseWifiHighPerformanceLock() {
        if (wifiHighPerformanceLock != null && wifiHighPerformanceLock.isHeld()) {
            wifiHighPerformanceLock.release();
            Log.i(TAG, "WiFi high-performance lock released");
        }
        wifiHighPerformanceLock = null;
    }

    /**
     * Disable all battery optimizations using root access.
     * This runs asynchronously and should be called once at service startup.
     */
    public void disableBatteryOptimizationsAsync() {
        new Thread(() -> {
            disableBatteryOptimizations();
        }, "BatteryOptDisable").start();
    }

    /**
     * Disable battery optimizations synchronously.
     */
    public void disableBatteryOptimizations() {
        String pkg = context.getPackageName();
        Log.i(TAG, "Disabling battery optimizations for " + pkg);

        // Add to Doze whitelist
        RootHelper.execRoot("dumpsys deviceidle whitelist +" + pkg);

        // Allow running in background
        RootHelper.execRoot("cmd appops set " + pkg + " RUN_IN_BACKGROUND allow");
        RootHelper.execRoot("cmd appops set " + pkg + " RUN_ANY_IN_BACKGROUND allow");

        // Allow wake lock
        RootHelper.execRoot("cmd appops set " + pkg + " WAKE_LOCK allow");

        // Disable app standby
        RootHelper.execRoot("am set-inactive " + pkg + " false");

        // Set high priority (persistent process level)
        int pid = android.os.Process.myPid();
        RootHelper.execRoot("echo -12 > /proc/" + pid + "/oom_score_adj");

        Log.i(TAG, "Battery optimizations disabled");
    }

    /**
     * Release all resources.
     * Should be called when the service is destroyed.
     */
    public void release() {
        releaseWifiHighPerformanceLock();
        releaseCpuWakeLock();
    }
}
