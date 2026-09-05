package net.elfradio.elfremote;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

final class PermissionGate {
    static boolean ignoringBattery(Context ctx) {
        if (Build.VERSION.SDK_INT < 23) return true;
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        return pm != null && pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
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
