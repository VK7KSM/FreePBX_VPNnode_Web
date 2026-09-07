package net.elfradio.elfremote;

import android.content.Context;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;

final class WatchdogInstaller {
    private static final String TAG = "elfRemote";
    private static volatile boolean attempted;

    static void ensure(Context ctx) {
        if (ctx == null || attempted) return;
        attempted = true;
        final Context app = ctx.getApplicationContext();
        new Thread(() -> run(app), "elfremote-wd-install").start();
    }

    static void run(Context ctx) {
        try {
            File staged = new File(ctx.getFilesDir(), "watchdog");
            WatchdogPolicy.stage(staged);
            File apply = new File(staged, "apply.sh");
            java.io.FileOutputStream out = new java.io.FileOutputStream(apply);
            try {
                out.write(WatchdogPolicy.applyCommands(staged.getAbsolutePath())
                        .getBytes("UTF-8"));
            } finally {
                out.close();
            }
            apply.setReadable(true, false);
            apply.setExecutable(true, false);
            execSu("sh " + apply.getAbsolutePath());
        } catch (Exception e) {
            Log.w(TAG, "watchdog install skipped: " + e.getMessage());
        }
    }

    private static void execSu(String cmd) throws Exception {
        Process p;
        try {
            ProcessBuilder pb = new ProcessBuilder("su", "-c", cmd);
            pb.redirectErrorStream(true);
            p = pb.start();
        } catch (Exception e) {
            Log.w(TAG, "no su; watchdog stays undeployed");
            return;
        }
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        InputStream in = p.getInputStream();
        byte[] buf = new byte[256];
        int n;
        while ((n = in.read(buf)) >= 0) bos.write(buf, 0, n);
        int code = p.waitFor();
        if (code != 0) {
            String msg = bos.toString("UTF-8");
            if (msg.length() > 180) msg = msg.substring(0, 180);
            Log.w(TAG, "watchdog apply exit=" + code + " " + msg);
        } else {
            Log.i(TAG, "watchdog apply ok");
        }
    }

    private WatchdogInstaller() {}
}
