package net.elfradio.elfremote;

import android.content.Context;
import android.os.SystemClock;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

/** 冻结APK独立于主应用运行；只在旧核心空闲时交接。 */
final class CoreInstaller {
    static final String DIR = "/data/local/elfremote/core";
    private static volatile boolean running, ready;
    private static long retryAt;

    static boolean ready() { return ready; }
    static synchronized void ensure(Context context, Runnable finished) {
        if (running || !WatchdogInstaller.ready() || SystemClock.elapsedRealtime() < retryAt) return;
        running = true;
        Context app = context.getApplicationContext();
        new Thread(() -> {
            boolean before = ready;
            try {
                JSONObject health = null;
                try { health = CoreClient.health(); } catch (Exception unavailable) { }
                if (health == null || health.optInt("version_code") != BuildConfig.VERSION_CODE) install(app);
                ready = CoreClient.health().optInt("version_code") == BuildConfig.VERSION_CODE;
                if (ready) CoreClient.request("/resume", new JSONObject());
                retryAt = SystemClock.elapsedRealtime() + (ready ? 60000 : 15000);
            } catch (Exception error) {
                ready = false; retryAt = SystemClock.elapsedRealtime() + 15000;
                RuntimeLog.error("core_initialize_failed", error);
            } finally {
                running = false;
                if (before != ready && finished != null) finished.run();
            }
        }, "elfremote-core-install").start();
    }

    private static void install(Context app) throws Exception {
        File stage = new File(app.getFilesDir(), "core-stage");
        if (!stage.isDirectory() && !stage.mkdirs()) throw new IOException("core-stage");
        String apk = app.getApplicationInfo().sourceDir;
        String hash = RescueFiles.sha256(new File(apk));
        String target = DIR + "/payload-" + hash + ".apk";
        // 先关闭入队门，再确认旧任务为空；与核心的submit互斥协议配合。
        su(stage, "mkdir -p " + DIR + "\nchmod 0700 " + DIR + "\ntouch " + DIR + "/upgrading\n");
        String previous = null;
        boolean switched = false;
        try {
            JSONObject old = null;
            try { old = CoreClient.health(); } catch (Exception unavailable) { }
            if (old != null && CoreClient.request("/prepare-upgrade", new JSONObject()).optBoolean("busy"))
                throw new IOException("core-busy-retry-later");
            File oldLauncher = new File(stage, "previous-launch.sh");
            su(stage, "if [ -f " + DIR + "/launch.sh ]; then cat " + DIR + "/launch.sh > "
                    + RescueFiles.quote(oldLauncher.getPath()) + "; chmod 0644 " + RescueFiles.quote(oldLauncher.getPath()) + "; fi\n");
            if (oldLauncher.isFile()) previous = RescueFiles.read(oldLauncher, 16000);
            String launcher = launchScript(target);
            File stagedLauncher = new File(stage, "launch.sh");
            RescueFiles.write(stagedLauncher, launcher);
            su(stage, "cp " + RescueFiles.quote(apk) + " " + target + ".new\n"
                    + "test \"$(sha256sum " + target + ".new | cut -d ' ' -f 1)\" = " + hash + "\n"
                    + "chmod 0600 " + target + ".new\nmv " + target + ".new " + target + "\n"
                    + "cp " + RescueFiles.quote(stagedLauncher.getPath()) + " " + DIR + "/launch.sh.new\n"
                    + "chmod 0700 " + DIR + "/launch.sh.new\nmv " + DIR + "/launch.sh.new " + DIR + "/launch.sh\n"
                    + "echo " + hash + " > " + DIR + "/generation.new\nmv " + DIR + "/generation.new " + DIR + "/generation\n");
            switched = true;
            // 旧进程观察generation后退出；独立守护或本次启动器随后启动新载荷。
            for (int i = 0; i < 12; i++) {
                su(stage, "sh " + DIR + "/launch.sh\n");
                try { if (CoreClient.health().optInt("version_code") == BuildConfig.VERSION_CODE) return; }
                catch (Exception waiting) { }
                Thread.sleep(1000);
            }
            throw new IOException("core-health-timeout");
        } catch (Exception error) {
            if (switched && previous != null) {
                File rollback = new File(stage, "rollback.sh"); RescueFiles.write(rollback, previous);
                su(stage, "cp " + RescueFiles.quote(rollback.getPath()) + " " + DIR + "/launch.sh\n"
                        + "echo rollback-" + System.currentTimeMillis() + " > " + DIR + "/generation\n");
            }
            throw error;
        } finally { su(stage, "rm -f " + DIR + "/upgrading\n"); }
    }

    static String launchScript(String apk) {
        return "#!/system/bin/sh\nset -e\nD=" + DIR + "\n"
                + "p=$(cat \"$D/daemon.pid\" 2>/dev/null || true)\n"
                + "case \"$p\" in ''|*[!0-9]*) ;; *) if [ -r /proc/$p/cmdline ] && tr '\\000' ' ' < /proc/$p/cmdline | grep -q 'net.elfradio.elfremote.RescueDaemon'; then exit 0; fi;; esac\n"
                + "[ -f \"$D/generation\" ] || exit 1\n"
                + "cd \"$D\"\n"
                + "[ ! -f daemon.log ] || [ $(wc -c < daemon.log) -lt 262144 ] || mv daemon.log daemon.previous.log\n"
                + "CLASSPATH=" + RescueFiles.quote(apk) + " /system/bin/app_process /system/bin net.elfradio.elfremote.RescueDaemon \"$D\" \"$D/generation\" </dev/null >>daemon.log 2>&1 &\n";
    }

    private static void su(File stage, String commands) throws Exception {
        File script = new File(stage, "apply.sh");
        RescueFiles.write(script, "#!/system/bin/sh\nset -e\n" + commands);
        Process p = new ProcessBuilder("su", "-c", "sh " + RescueFiles.quote(script.getPath()))
                .redirectErrorStream(true).redirectOutput(new File(stage, "apply.out")).start();
        try {
            if (!p.waitFor(20, TimeUnit.SECONDS) || p.exitValue() != 0) throw new IOException("core-apply-failed");
        } finally { p.destroy(); }
    }
    private CoreInstaller() {}
}
