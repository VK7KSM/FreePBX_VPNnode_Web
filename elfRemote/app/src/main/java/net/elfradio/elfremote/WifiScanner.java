package net.elfradio.elfremote;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.wifi.ScanResult;
import android.net.wifi.WifiManager;
import android.os.SystemClock;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

final class WifiScanner {
    static JSONObject scan(Context context) throws Exception {
        WifiManager wifi = (WifiManager) context.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wifi == null || !wifi.isWifiEnabled()) throw new IOException("wifi-disabled");
        CountDownLatch completed = new CountDownLatch(1);
        boolean[] updated = {false};
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override public void onReceive(Context ignored, Intent intent) {
                updated[0] = intent.getBooleanExtra(WifiManager.EXTRA_RESULTS_UPDATED, false);
                completed.countDown();
            }
        };
        context.registerReceiver(receiver, new IntentFilter(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION));
        try {
            long started = SystemClock.elapsedRealtime() * 1000L;
            if (!wifi.startScan()) throw new IOException("wifi-scan-rejected");
            if (!completed.await(20, TimeUnit.SECONDS)) throw new IOException("wifi-scan-timeout");
            if (!updated[0]) throw new IOException("wifi-scan-not-updated");
            JSONArray fresh = new JSONArray();
            java.util.List<ScanResult> results = wifi.getScanResults();
            boolean receivedFresh = results.isEmpty();
            for (ScanResult result : results) {
                receivedFresh |= result.timestamp >= started;
                if (result.timestamp >= started && result.SSID != null && !result.SSID.isEmpty()) {
                    fresh.put(new JSONObject().put("ssid", result.SSID).put("rssi", result.level)
                            .put("sec", WifiScanPolicy.security(result.capabilities)));
                }
            }
            if (!receivedFresh) throw new IOException("wifi-scan-stale");
            return new JSONObject().put("sampled_at_ms", System.currentTimeMillis())
                    .put("networks", WifiScanPolicy.networks(fresh));
        } finally { context.unregisterReceiver(receiver); }
    }
    private WifiScanner() {}
}
