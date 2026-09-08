package net.elfradio.elfremote;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

final class PermissionGate {
    static boolean hasLocation(Context ctx) {
        return ctx.checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION) == android.content.pm.PackageManager.PERMISSION_GRANTED
                && ctx.checkSelfPermission(android.Manifest.permission.ACCESS_COARSE_LOCATION) == android.content.pm.PackageManager.PERMISSION_GRANTED;
    }

    static void initializeLocation(Context ctx, android.os.Handler worker, Runnable done) {
        new Thread(() -> {
            Process process = null;
            try {
                // 仅授予本应用已声明的两项权限；不接收服务器命令或修改定位开关。
                String command = "pm grant --user 0 net.elfradio.elfremote android.permission.ACCESS_COARSE_LOCATION >/dev/null 2>&1"
                        + " && pm grant --user 0 net.elfradio.elfremote android.permission.ACCESS_FINE_LOCATION >/dev/null 2>&1";
                process = new ProcessBuilder("su", "-c", command).start();
                long deadline = android.os.SystemClock.elapsedRealtime() + 3000L;
                while (android.os.SystemClock.elapsedRealtime() < deadline) {
                    try { process.exitValue(); break; }
                    catch (IllegalThreadStateException running) { Thread.sleep(50L); }
                }
            } catch (Exception error) { RuntimeLog.error("location_permission_init_failed", error); }
            finally {
                if (process != null) {
                    process.destroy();
                    try { process.getInputStream().close(); process.getErrorStream().close(); process.getOutputStream().close(); }
                    catch (Exception ignored) {}
                }
                RuntimeLog.event("location_permission_ready=" + hasLocation(ctx));
                worker.post(done);
            }
        }, "elfremote-location-permission").start();
    }

    static boolean ignoringBattery(Context ctx) {
        if (Build.VERSION.SDK_INT < 23) return true;
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        return pm != null && pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
    }

    static void initializeBackground(Context ctx) {
        if (ignoringBattery(ctx)) return;
        new Thread(() -> {
            Process process = null;
            try {
                // 仅豁免本应用，不关闭系统休眠，也不请求用户现场点击。
                process = new ProcessBuilder("su", "-c", "dumpsys deviceidle whitelist +net.elfradio.elfremote >/dev/null 2>&1").start();
                long until = android.os.SystemClock.elapsedRealtime() + 3000L;
                while (android.os.SystemClock.elapsedRealtime() < until) {
                    try { process.exitValue(); break; }
                    catch (IllegalThreadStateException running) { Thread.sleep(50L); }
                }
            } catch (Exception e) { RuntimeLog.error("background_permission_failed", e); }
            finally {
                if (process != null) process.destroy();
                RuntimeLog.event("background_permission_ready=" + ignoringBattery(ctx));
            }
        }, "elfremote-background-permission").start();
    }

    static void requestIgnoreBattery(Context ctx) {
        if (ignoringBattery(ctx)) return;
        Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
        i.setData(Uri.parse("package:" + ctx.getPackageName()));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            ctx.startActivity(i);
        } catch (Exception e) {
            Intent fallback = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
            fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(fallback);
        }
    }

    static void openAppDetails(Context ctx) {
        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        i.setData(Uri.parse("package:" + ctx.getPackageName()));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        ctx.startActivity(i);
    }

    static boolean requestLauncherShortcut(Context ctx) {
        Intent launch = new Intent(ctx, MainActivity.class);
        launch.setAction(Intent.ACTION_MAIN);
        launch.addCategory(Intent.CATEGORY_LAUNCHER);
        Intent add = new Intent("com.android.launcher.action.INSTALL_SHORTCUT");
        add.putExtra(Intent.EXTRA_SHORTCUT_INTENT, launch);
        add.putExtra(Intent.EXTRA_SHORTCUT_NAME, ctx.getString(R.string.app_name));
        add.putExtra("duplicate", false);
        ctx.sendBroadcast(add);
        return true;
    }

    private PermissionGate() {}
}
