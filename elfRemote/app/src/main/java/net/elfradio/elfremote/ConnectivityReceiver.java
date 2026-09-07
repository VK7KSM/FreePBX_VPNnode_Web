package net.elfradio.elfremote;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public final class ConnectivityReceiver extends BroadcastReceiver {
    private static volatile long lastMs;

    @Override
    public void onReceive(Context context, Intent intent) {
        long now = System.currentTimeMillis();
        if (now - lastMs < 5000L) return;
        lastMs = now;
        ServiceStarter.startNow(context);
    }
}
