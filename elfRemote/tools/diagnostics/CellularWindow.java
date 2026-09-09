package net.elfradio.elfremote.diagnostics;

import android.app.AlarmManager;
import android.content.Context;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;
import java.io.File;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** 单次蜂窝测试的本地采样和Wi-Fi恢复，不建立网络连接。 */
public final class CellularWindow {
    public static void main(String[] args) throws Exception {
        if (android.os.Process.myUid() != 0 || args.length != 2) throw new IllegalArgumentException("需要root与明确测试参数");
        int seconds = Integer.parseInt(args[0]);
        if (seconds != 5 && seconds != 7200) throw new IllegalArgumentException("仅支持5秒验收或两小时观察");
        File folder = new File(args[1]);
        if (!folder.getPath().matches("/data/local/elfremote/cellular-window-[0-9]+") || !folder.mkdir())
            throw new IllegalArgumentException("必须使用全新的测试目录");
        int uid = android.system.Os.stat("/data/user/0/net.elfradio.elfremote").st_uid;
        if (uid < 10000) throw new IllegalStateException("应用身份异常");
        Looper.prepareMainLooper();
        Object activity = Class.forName("android.app.ActivityThread").getMethod("systemMain").invoke(null);
        Context context = (Context) activity.getClass().getMethod("getSystemContext").invoke(activity);
        HandlerThread thread = new HandlerThread("elfremote-cellular-restore"); thread.start();
        AlarmManager alarm = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        CountDownLatch done = new CountDownLatch(1);
        AlarmManager.OnAlarmListener listener = new AlarmManager.OnAlarmListener() {
            @Override public void onAlarm() { done.countDown(); }
        };
        boolean armed = false;
        int status = 1;
        try {
            capture(folder, "before.txt", uid);
            long start = SystemClock.elapsedRealtime();
            alarm.setExact(AlarmManager.ELAPSED_REALTIME_WAKEUP, start + seconds * 1000L,
                    "elfRemote:cellular-test-restore", listener, new Handler(thread.getLooper()));
            armed = true;
            System.out.println("RESTORE_ARMED seconds=" + seconds + " elapsed_ms=" + start); System.out.flush();
            boolean fired = done.await(seconds + 120L, TimeUnit.SECONDS);
            System.out.println("RESTORE_DUE alarm_fired=" + fired + " elapsed_ms=" + (SystemClock.elapsedRealtime() - start));
            capture(folder, "after-cellular.txt", uid);
            status = fired ? 0 : 2;
        } finally {
            if (armed) {
                Process restore = new ProcessBuilder("/system/bin/svc", "wifi", "enable").redirectErrorStream(true)
                        .redirectOutput(new File(folder, "restore.txt")).start();
                boolean finished = restore.waitFor(20, TimeUnit.SECONDS);
                System.out.println("WIFI_RESTORE finished=" + finished + " exit=" + (finished ? restore.exitValue() : -1));
                restore.destroy();
            }
            alarm.cancel(listener); thread.quitSafely();
        }
        System.exit(status);
    }
    private static void capture(File folder, String name, int uid) throws Exception {
        String command = "date -u; cat /proc/uptime; cat /proc/sys/kernel/random/boot_id; "
                + "settings get global wifi_on; settings get global mobile_data; dumpsys battery; "
                + "awk 'NR==1 || $4==" + uid + "' /proc/net/xt_qtaguid/stats; cat /proc/net/dev";
        Process p = new ProcessBuilder("/system/bin/sh", "-c", command).redirectErrorStream(true)
                .redirectOutput(new File(folder, name)).start();
        try { if (!p.waitFor(20, TimeUnit.SECONDS) || p.exitValue() != 0) throw new IllegalStateException("采样失败"); }
        finally { p.destroy(); }
    }
}
