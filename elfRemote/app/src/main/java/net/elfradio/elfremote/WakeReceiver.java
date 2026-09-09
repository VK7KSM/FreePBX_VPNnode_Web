package net.elfradio.elfremote;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

public final class WakeReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        String key = intent.getStringExtra("wake_key");
        if (!"report".equals(key) && !"retry".equals(key) && !"ping".equals(key) && !"connect-timeout".equals(key)
                && !"file-transfer".equals(key) && !"report-photo".equals(key) && !"movement".equals(key) && !"file-return".equals(key)) return;
        long received = android.os.SystemClock.elapsedRealtime();
        long due = intent.getLongExtra("due_elapsed", received);
        RuntimeLog.event("wake_received key=" + key + " late_ms=" + Math.max(0, received-due));
        WakeScheduler.hold(context, "dispatch-" + key, 120000L);
        try {
            Intent service = new Intent(context, ReportService.class).setAction(WakeScheduler.ACTION).putExtra("wake_key", key).putExtra("received_elapsed", received);
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(service);
            else context.startService(service);
        } catch (Exception e) { WakeScheduler.release("dispatch-" + key); RuntimeLog.error("wake_dispatch_failed", e); }
    }
}
