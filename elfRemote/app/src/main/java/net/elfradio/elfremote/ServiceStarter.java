package net.elfradio.elfremote;

import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

final class ServiceStarter {
    private static final String TAG = "elfRemote";

    static void start(Context ctx) {
        start(ctx, null);
    }

    static void startNow(Context ctx) {
        start(ctx, ReportService.ACTION_REPORT_NOW);
    }

    static void renew(Context ctx) {
        start(ctx, ReportService.ACTION_RENEW);
    }

    static void start(Context ctx, String action) {
        Intent i = new Intent(ctx, ReportService.class);
        if (action != null) i.setAction(action);
        try {
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i);
            else ctx.startService(i);
        } catch (IllegalStateException e) {
            Log.w(TAG, "skip background service start: " + e.getMessage());
        } catch (RuntimeException e) {
            Log.w(TAG, "service start failed", e);
        }
    }

    private ServiceStarter() {}
}
