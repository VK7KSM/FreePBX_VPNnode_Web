package net.elfradio.elfremote;

import android.os.SystemClock;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;
import java.io.File;
import java.io.IOException;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

/** 初始化可复用已经安装的root守护，不依赖电脑ADB，不修改Magisk授权。 */
final class BootstrapRoot {
    static final Object QUEUE_LOCK = new Object();

    static void run(File script, File output, int timeoutSeconds) throws Exception {
        synchronized (QUEUE_LOCK) {
            File probe = new File(script.getParentFile(), "root-probe.out");
            Process check = null;
            boolean direct = false;
            try {
                check = new ProcessBuilder("su", "-c", "id -u").redirectErrorStream(true).redirectOutput(probe).start();
                direct = check.waitFor(8, TimeUnit.SECONDS) && check.exitValue() == 0
                    && "0".equals(RescueFiles.read(probe, 4096).trim()); }
            catch (IOException unavailable) { RescueFiles.write(probe, "su-unavailable\n"); }
            finally { if (check != null) check.destroy(); }
            if (direct) {
                Process process = new ProcessBuilder("su", "-c", "sh " + RescueFiles.quote(script.getPath()))
                        .redirectErrorStream(true).redirectOutput(output).start();
                try {
                    if (!process.waitFor(timeoutSeconds, TimeUnit.SECONDS)) throw new IOException("bootstrap-command-timeout");
                    if (process.exitValue() != 0) throw new IOException("bootstrap-command-exit-" + process.exitValue());
                } finally { process.destroy(); }
                return;
            }
            throughWatchdog(script, output, timeoutSeconds);
        }
    }

    static void throughWatchdog(File script, File output, int timeoutSeconds) throws Exception {
        synchronized (QUEUE_LOCK) {
            File dir = new File(WatchdogPolicy.DIR);
            StructStat st = Os.lstat(dir.getPath());
            int uid = android.os.Process.myUid();
            if (!OsConstants.S_ISDIR(st.st_mode) || st.st_uid != 0 || st.st_gid != uid
                    || (st.st_mode & 07777) != 02770) throw new IOException("bootstrap-watchdog-directory");
            ensureIdle();
            String name = "bootstrap-" + UUID.randomUUID();
            File folder = new File(dir, name);
            if (!folder.mkdir()) throw new IOException("bootstrap-stage");
            File frozen = new File(folder, "apply.sh"), result = new File(folder, "result.out"), rc = new File(folder, "result.rc");
            RescueFiles.write(frozen, RescueFiles.read(script, 131072));
            String command = wrapper(frozen.getPath(), result.getPath(), rc.getPath(), uid,
                    System.currentTimeMillis() / 1000 + 60);
            File queued = new File(folder, "queue.sh");
            RescueFiles.write(queued, command);
            ensureIdle();
            RescueFiles.write(new File(dir, "heal.boot"), RescueFiles.read(new File("/proc/sys/kernel/random/boot_id"), 128));
            if (!queued.renameTo(new File(dir, "heal.cmd"))) throw new IOException("bootstrap-queue");
            RuntimeLog.event("bootstrap_using_existing_watchdog");
            long until = SystemClock.elapsedRealtime() + (timeoutSeconds + 30L) * 1000;
            while (!rc.isFile() && SystemClock.elapsedRealtime() < until) Thread.sleep(200);
            if (!rc.isFile()) throw new IOException("bootstrap-watchdog-timeout");
            RescueFiles.write(output, RescueFiles.read(result, 65536));
            int code = Integer.parseInt(RescueFiles.read(rc, 32).trim());
            // 唯一回执已落盘；等待旧守护完成队列清理，不使用共享heal.rc判断成功。
            long settle = SystemClock.elapsedRealtime() + 5000;
            while (new File(dir, "heal.running").exists() && SystemClock.elapsedRealtime() < settle) Thread.sleep(100);
            if (code != 0) throw new IOException("bootstrap-watchdog-exit-" + code);
            if (!new File(dir, "heal.running").exists()) {
                frozen.delete(); result.delete(); rc.delete(); folder.delete();
            }
        }
    }

    static void ensureIdle() throws IOException {
        for (String name : new String[]{"heal.cmd", "heal.running", "update.running"})
            if (new File(WatchdogPolicy.DIR, name).exists()) throw new IOException("root-command-busy");
    }

    static String wrapper(String script, String output, String rc, int uid, long expires) {
        if (uid < 10000 || expires <= 0) throw new IllegalArgumentException("无效的初始化执行参数");
        String out = RescueFiles.quote(output), temp = RescueFiles.quote(rc + ".tmp");
        return "#!/system/bin/sh\nif [ \"$(date +%s)\" -lt " + expires + " ]; then\n"
                + "sh " + RescueFiles.quote(script) + " > " + out + " 2>&1\ncode=$?\n"
                + "else\necho bootstrap-expired > " + out + "\ncode=75\nfi\n"
                + "echo $code > " + temp + "\nchown 0:" + uid + " " + out + " " + temp + " || exit 1\n"
                + "chmod 0660 " + out + " " + temp + " || exit 1\n"
                + "mv " + temp + " " + RescueFiles.quote(rc) + "\n";
    }
    private BootstrapRoot() { }
}
