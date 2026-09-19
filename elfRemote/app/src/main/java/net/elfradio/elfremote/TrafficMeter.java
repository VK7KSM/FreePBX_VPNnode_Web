package net.elfradio.elfremote;

import android.content.Context;
import android.net.TrafficStats;
import android.os.Process;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.AtomicFile;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileReader;
import java.nio.charset.StandardCharsets;

final class TrafficMeter {
    private final Context context;
    private final AtomicFile file;
    private final String unknownBoot = "unknown-" + java.util.UUID.randomUUID();
    private TrafficLedger ledger;
    private boolean initialized, unreadable;

    TrafficMeter(Context context) {
        this.context = context;
        file = new AtomicFile(new File(context.getFilesDir(), "uid-traffic.json"));
    }

    synchronized JSONObject sample() {
        try {
            if (!initialized) {
                try {
                    JSONObject saved = file.getBaseFile().exists() || new File(file.getBaseFile().getPath() + ".bak").exists()
                            ? new JSONObject(new String(file.readFully(), StandardCharsets.UTF_8)) : null;
                    ledger = new TrafficLedger(saved);
                } catch (Exception error) {
                    unreadable = true;
                    RuntimeLog.error("traffic_state_unreadable", error);
                }
                initialized = true;
            }
            if (unreadable) return new JSONObject().put("available", false).put("reason", "saved_state_unreadable");
            JSONObject counters;
            String source;
            try (FileReader input = new FileReader("/proc/net/xt_qtaguid/stats")) {
                counters = UidTraffic.parse(input, Process.myUid());
                source = "qtaguid_uid";
            } catch (Exception unavailable) {
                long rx = TrafficStats.getUidRxBytes(Process.myUid()), tx = TrafficStats.getUidTxBytes(Process.myUid());
                if (rx < 0 || tx < 0) return new JSONObject().put("available", false).put("reason", "uid_counter_unsupported");
                counters = new JSONObject().put("unattributed", new JSONObject().put("rx_bytes", rx).put("tx_bytes", tx));
                source = "trafficstats_uid";
            }
            int bootCount = Settings.Global.getInt(context.getContentResolver(), Settings.Global.BOOT_COUNT, -1);
            TrafficLedger next = new TrafficLedger(ledger.saved());
            JSONObject result = next.sample(counters, source, bootCount < 0 ? unknownBoot : "count-" + bootCount,
                    SystemClock.elapsedRealtime(), System.currentTimeMillis());
            FileOutputStream output = null;
            try {
                output = file.startWrite();
                output.write(next.saved().toString().getBytes(StandardCharsets.UTF_8));
                file.finishWrite(output);
                ledger = next;
            } catch (Exception error) {
                if (output != null) file.failWrite(output);
                throw error;
            }
            RuntimeLog.event("traffic_sample source=" + source + " rx=" + result.getLong("rx_bytes") + " tx=" + result.getLong("tx_bytes") + " gaps=" + result.getInt("gaps"));
            return result;
        } catch (Exception error) {
            RuntimeLog.error("traffic_sample_failed", error);
            try { return new JSONObject().put("available", false).put("reason", "counter_or_persistence_failed"); }
            catch (Exception ignored) { return null; }
        }
    }
}
