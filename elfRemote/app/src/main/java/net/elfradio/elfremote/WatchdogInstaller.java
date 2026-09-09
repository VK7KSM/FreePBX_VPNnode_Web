package net.elfradio.elfremote;

import android.content.Context;
import android.os.SystemClock;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

/** 生产客户端首次启动也部署独立守护；通过应用自己的root通道核验。 */
final class WatchdogInstaller {
    private static volatile boolean running, ready, handoffPending;
    private static volatile String state = "pending";
    private static long nextAttempt;
    private static int failures;

    static boolean ready() { return ready; }
    static boolean needsRetry() { return !ready || handoffPending; }
    static long retryDelayMs() { return Math.max(1000L, nextAttempt - SystemClock.elapsedRealtime()); }
    static JSONObject snapshot() throws Exception {
        return new JSONObject().put("state", state).put("ready", ready);
    }
    static synchronized void ensure(Context ctx, Runnable completed) {
        if (ctx == null || running || SystemClock.elapsedRealtime() < nextAttempt) return;
        running = true;
        final Context app = ctx.getApplicationContext();
        new Thread(() -> {
            boolean wasReady = ready;
            boolean wasPending = handoffPending;
            try {
                File staged = new File(app.getFilesDir(), "watchdog");
                WatchdogPolicy.stage(staged);
                File output = new File(staged, "initialize.out");
                File previous = new File(staged, "initialize-before-" + BuildConfig.VERSION_CODE + ".out");
                if (output.isFile() && !previous.exists()) {
                    RescueFiles.write(previous, RescueFiles.read(output, 65536));
                }
                File apply = new File(staged, "apply.sh");
                try (FileOutputStream out = new FileOutputStream(apply)) {
                    out.write(WatchdogPolicy.applyCommands(staged.getAbsolutePath()).getBytes(StandardCharsets.UTF_8));
                    out.getFD().sync();
                }
                // 输出仅存应用私有文件，不把root错误正文送入服务器或公开日志。
                Process process = new ProcessBuilder("su", "-c", "sh '" + apply.getAbsolutePath() + "'")
                        .redirectErrorStream(true).redirectOutput(output).start();
                try {
                    if (!process.waitFor(45, TimeUnit.SECONDS)) throw new java.io.IOException("bootstrap-timeout");
                    if (process.exitValue() != 0) throw new java.io.IOException("bootstrap-not-ready");
                } finally { process.destroy(); }
                File check = new File(WatchdogPolicy.DIR, "app-write-check.tmp");
                try (FileOutputStream out = new FileOutputStream(check)) { out.write(1); out.getFD().sync(); }
                if (!check.delete()) throw new java.io.IOException("bootstrap-write-check");
                ready = true; state = "ready"; failures = 0;
                PermissionGate.initializeBackground(app);
                handoffPending = new File(WatchdogPolicy.DIR, "watchdog.restart").isFile();
                nextAttempt = SystemClock.elapsedRealtime() + (handoffPending ? 15000L : 3600000L);
            } catch (Exception error) {
                try {
                    File staged = new File(app.getFilesDir(), "watchdog");
                    String detail = error.getClass().getSimpleName() + ": " + error.getMessage() + "\n";
                    File output = new File(staged, "initialize.out");
                    if (output.isFile()) detail += RescueFiles.read(output, 65536);
                    RescueFiles.write(new File(staged, "last-failure.out"), detail);
                } catch (Exception unavailable) { RuntimeLog.error("bootstrap_diagnostic_failed", unavailable); }
                ready = false; state = "initialization_failed";
                nextAttempt = SystemClock.elapsedRealtime() + Math.min(900000L, 60000L << Math.min(4, failures++));
                RuntimeLog.error("bootstrap_failed", error);
            } finally {
                RuntimeLog.event("bootstrap_ready=" + ready);
                running = false;
                if (completed != null && (wasReady != ready || wasPending || needsRetry())) completed.run();
            }
        }, "elfremote-bootstrap").start();
    }
    private WatchdogInstaller() {}
}
