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

    private static volatile boolean running;
    private static long retryAt;
    private static int failures;

    static boolean ready(Context ctx) {
        for (String permission : PermissionPolicy.RUNTIME)
            if (ctx.checkSelfPermission(permission) != android.content.pm.PackageManager.PERMISSION_GRANTED) return false;
        return ignoringBattery(ctx);
    }

    static org.json.JSONObject snapshot(Context ctx) throws Exception {
        org.json.JSONArray missing = new org.json.JSONArray();
        for (String permission : PermissionPolicy.RUNTIME)
            if (ctx.checkSelfPermission(permission) != android.content.pm.PackageManager.PERMISSION_GRANTED) missing.put(permission);
        return new org.json.JSONObject().put("ready", ready(ctx)).put("initializing", running)
                .put("missing", missing).put("background", ignoringBattery(ctx));
    }

    // 首次启动、升级或清数据后都读真实权限；不依赖会过期的“已经授权”标记。
    static synchronized void ensure(Context context, Runnable done) {
        if (running || !WatchdogInstaller.ready()) return;
        if (ready(context)) { if (done != null) done.run(); return; }
        if (android.os.SystemClock.elapsedRealtime() < retryAt) return;
        running = true;
        Context app = context.getApplicationContext();
        new Thread(() -> {
            try {
                java.io.File dir = new java.io.File(app.getFilesDir(), "permissions");
                if (!dir.isDirectory() && !dir.mkdirs()) throw new java.io.IOException("permission-stage");
                RescueFiles.write(new java.io.File(dir,"before.json"), snapshot(app).toString());
                java.io.File script = new java.io.File(dir,"initialize.sh");
                RescueFiles.write(script, PermissionPolicy.commands());
                RuntimeLog.event("permissions_initialize_begin");
                if (CoreInstaller.ready()) CoreClient.request("/permissions/initialize", new org.json.JSONObject(),30000);
                else BootstrapRoot.throughWatchdog(script, new java.io.File(dir,"initialize.out"), 25);
                if (!ready(app)) throw new java.io.IOException("permissions-readback-incomplete");
                failures = 0;
            } catch (Exception error) {
                failures++; RuntimeLog.error("permissions_initialize_failed", error);
            } finally {
                retryAt = android.os.SystemClock.elapsedRealtime() + Math.min(900000L, 60000L << Math.min(4, failures));
                running = false;
                try { RescueFiles.write(new java.io.File(app.getFilesDir(),"permissions/current.json"),snapshot(app).toString()); }
                catch (Exception ignored) { }
                RuntimeLog.event("permissions_ready=" + ready(app));
                if (done != null) done.run();
            }
        }, "elfremote-permissions").start();
    }

    static boolean ignoringBattery(Context ctx) {
        if (Build.VERSION.SDK_INT < 23) return true;
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        return pm != null && pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
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
