package org.onetwoone.gateway;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

/**
 * Автозапуск GSM-SIP шлюза при загрузке системы
 *
 * Запускается автоматически после BOOT_COMPLETED
 * Гарантирует что шлюз работает всегда после перезагрузки устройства
 */
public class BootReceiver extends BroadcastReceiver {
    private static final String TAG = "GatewayBoot";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
            Log.i(TAG, "Boot completed, starting gateway services");

            // Start SIP service
            Intent serviceIntent = new Intent(context, PjsipSipService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent);
            } else {
                context.startService(serviceIntent);
            }
            Log.i(TAG, "SIP service started");

        }
    }
}
