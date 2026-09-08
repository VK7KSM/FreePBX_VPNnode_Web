package net.elfradio.elfremote;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

public final class WakeReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        String key = intent.getStringExtra("wake_key");
        if (!"report".equals(key) && !"retry".equals(key) && !"ping".equals(key)) return;
        WakeScheduler.hold(context, "dispatch", 10000L);
        try {
            Intent service = new Intent(context, ReportService.class).setAction(WakeScheduler.ACTION).putExtra("wake_key", key);
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(service);
            else context.startService(service);
        } catch (Exception e) { WakeScheduler.release("dispatch"); RuntimeLog.error("wake_dispatch_failed", e); }
    }
}
