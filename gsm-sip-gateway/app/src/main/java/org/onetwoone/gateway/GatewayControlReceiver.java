package org.onetwoone.gateway;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

import org.onetwoone.gateway.config.GatewayConfig;

/**
 * Internal broadcast API for same-application service control.
 *
 * Поддерживаемые действия (actions):
 * - org.onetwoone.gateway.START         - запустить шлюз
 * - org.onetwoone.gateway.STOP          - остановить шлюз
 * - org.onetwoone.gateway.CONFIGURE     - настроить конфигурацию SIP
 * - org.onetwoone.gateway.GET_STATUS    - получить статус (результат в результирующем Intent)
 *
 * Параметры для CONFIGURE (extras):
 * - sip_server (String)          - адрес SIP сервера
 * - sip_port (int)               - порт SIP сервера
 * - sip_user (String)            - SIP пользователь
 * - sip_password (String)        - SIP пароль
 * - use_tls (boolean)            - использовать TLS (порт 5061)
 * - sip_realm (String)           - SIP realm (пусто = "*", любой realm)
 * - sim1_destination (String)    - SIP ext для SIM1 (GSM→SIP)
 * - sim2_destination (String)    - SIP ext для SIM2 (GSM→SIP)
 * - incoming_mode (int)          - режим входящих звонков (0=SIP_FIRST, 1=ANSWER_FIRST)
 * - audio_card (int)             - ALSA sound card
 * - capture_device (int)         - PCM for GSM→SIP capture
 * - playback_device (int)        - PCM for SIP→GSM injection
 * - capture_route (String)       - VOC_REC mixer route
 * - injection_route (String)     - Incall_Music mixer route
 * - audio_route (String)         - legacy route applied to both directions
 * - tx_gain (float)              - GSM to SIP gain in dB (-20 to +20)
 * - rx_gain (float)              - SIP to GSM gain in dB (-20 to +20)
 *
 * Пример использования из другого приложения:
 *
 * // Запустить шлюз
 * Intent intent = new Intent("org.onetwoone.gateway.START");
 * intent.setPackage("org.onetwoone.gateway");
 * sendBroadcast(intent);
 *
 * // Настроить SIP
 * Intent config = new Intent("org.onetwoone.gateway.CONFIGURE");
 * config.setPackage("org.onetwoone.gateway");
 * config.putExtra("sip_server", "192.168.1.100");
 * config.putExtra("sip_port", 5060);
 * config.putExtra("sip_user", "gateway");
 * config.putExtra("sip_password", "secret123");
 * config.putExtra("sim1_destination", "101");
 * config.putExtra("sim2_destination", "102");
 * sendBroadcast(config);
 *
 * // Остановить шлюз
 * Intent stop = new Intent("org.onetwoone.gateway.STOP");
 * stop.setPackage("org.onetwoone.gateway");
 * sendBroadcast(stop);
 */
public class GatewayControlReceiver extends BroadcastReceiver {
    private static final String TAG = "GatewayControl";

    // Actions
    public static final String ACTION_START = "org.onetwoone.gateway.START";
    public static final String ACTION_STOP = "org.onetwoone.gateway.STOP";
    public static final String ACTION_CONFIGURE = "org.onetwoone.gateway.CONFIGURE";
    public static final String ACTION_GET_STATUS = "org.onetwoone.gateway.GET_STATUS";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (action == null) return;

        Log.i(TAG, "Received action: " + action);

        switch (action) {
            case ACTION_START:
                startGateway(context);
                break;

            case ACTION_STOP:
                stopGateway(context);
                break;

            case ACTION_CONFIGURE:
                configure(context, intent);
                break;

            case ACTION_GET_STATUS:
                // TODO: реализовать получение статуса (нужен ResultReceiver или ContentProvider)
                Log.i(TAG, "GET_STATUS not yet implemented");
                break;

            default:
                Log.w(TAG, "Unknown action: " + action);
        }
    }

    private void startGateway(Context context) {
        Log.i(TAG, "Starting gateway service");
        Intent intent = new Intent(context, PjsipSipService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }

    }

    private void stopGateway(Context context) {
        Log.i(TAG, "Stopping gateway service");
        PjsipSipService service = PjsipSipService.getInstance();
        if (service != null) {
            service.stop();
        } else {
            // Fallback if service not running
            Intent intent = new Intent(context, PjsipSipService.class);
            context.stopService(intent);
        }
    }

    private void configure(Context context, Intent intent) {
        Log.i(TAG, "Configuring gateway");

        // Show current config
        if (intent.getBooleanExtra("show", false)) {
            showConfig(context);
            return;
        }

        boolean changed = false;

        // Сохраняем SIP конфигурацию в SharedPreferences
        SharedPreferences prefs = context.getSharedPreferences("gateway_prefs", Context.MODE_PRIVATE);
        SharedPreferences.Editor editor = prefs.edit();

        if (intent.hasExtra("sip_server")) {
            String server = intent.getStringExtra("sip_server");
            editor.putString("sip_server", server);
            Log.i(TAG, "Set sip_server: " + server);
            changed = true;
        }

        if (intent.hasExtra("sip_port")) {
            int port = intent.getIntExtra("sip_port", 5060);
            editor.putInt("sip_port", port);
            Log.i(TAG, "Set sip_port: " + port);
            changed = true;
        }

        if (intent.hasExtra("sip_user")) {
            String user = intent.getStringExtra("sip_user");
            editor.putString("sip_user", user);
            Log.i(TAG, "Set sip_user: " + user);
            changed = true;
        }

        if (intent.hasExtra("sip_password")) {
            String password = intent.getStringExtra("sip_password");
            editor.putString("sip_password", password);
            Log.i(TAG, "Set sip_password: ***");
            changed = true;
        }

        if (intent.hasExtra("use_tls")) {
            boolean useTls = intent.getBooleanExtra("use_tls", false);
            editor.putBoolean("use_tls", useTls);
            Log.i(TAG, "Set use_tls: " + useTls);
            changed = true;
        }

        if (intent.hasExtra("sip_realm")) {
            String realm = intent.getStringExtra("sip_realm");
            editor.putString("sip_realm", realm);
            Log.i(TAG, "Set sip_realm: " + (realm.isEmpty() ? "*" : realm));
            changed = true;
        }

        if (intent.hasExtra("sim1_destination")) {
            String dest = intent.getStringExtra("sim1_destination");
            editor.putString("sim1_destination", dest);
            Log.i(TAG, "Set sim1_destination: " + dest);
            changed = true;
        }

        if (intent.hasExtra("sim2_destination")) {
            String dest = intent.getStringExtra("sim2_destination");
            editor.putString("sim2_destination", dest);
            Log.i(TAG, "Set sim2_destination: " + dest);
            changed = true;
        }

        if (intent.hasExtra("incoming_mode")) {
            int mode = intent.getIntExtra("incoming_mode", GatewayInCallService.MODE_SIP_FIRST);
            editor.putInt("incoming_call_mode", mode);
            Log.i(TAG, "Set incoming_mode: " + mode);
            changed = true;
        }

        // Audio settings (stored in gsm_audio_config)
        SharedPreferences audioPrefs = context.getSharedPreferences("gsm_audio_config", Context.MODE_PRIVATE);
        SharedPreferences.Editor audioEditor = audioPrefs.edit();

        if (intent.hasExtra("audio_card")) {
            int card = intent.getIntExtra("audio_card", 0);
            audioEditor.putInt("card", card);
            Log.i(TAG, "Set audio_card: " + card);
            changed = true;
        }

        if (intent.hasExtra("audio_route")) {
            String route = intent.getStringExtra("audio_route");
            audioEditor.putString("capture_route", route);
            audioEditor.putString("injection_route", route);
            audioEditor.putString("multimedia_route", route);
            Log.w(TAG, "Set legacy audio_route for both directions: " + route);
            changed = true;
        }

        if (intent.hasExtra("capture_device")) {
            int device = intent.getIntExtra("capture_device", GatewayConfig.PIXEL_CAPTURE_DEVICE);
            audioEditor.putInt("capture_device", device);
            Log.i(TAG, "Set capture_device: " + device);
            changed = true;
        }

        if (intent.hasExtra("playback_device")) {
            int device = intent.getIntExtra("playback_device", GatewayConfig.PIXEL_PLAYBACK_DEVICE);
            audioEditor.putInt("playback_device", device);
            Log.i(TAG, "Set playback_device: " + device);
            changed = true;
        }

        if (intent.hasExtra("capture_route")) {
            String route = intent.getStringExtra("capture_route");
            audioEditor.putString("capture_route", route);
            Log.i(TAG, "Set capture_route: " + route);
            changed = true;
        }

        if (intent.hasExtra("injection_route")) {
            String route = intent.getStringExtra("injection_route");
            audioEditor.putString("injection_route", route);
            Log.i(TAG, "Set injection_route: " + route);
            changed = true;
        }

        if (intent.hasExtra("tx_gain")) {
            float gain = intent.getFloatExtra("tx_gain", 0.0f);
            if (isValidGain(gain)) {
                audioEditor.putFloat("tx_gain", gain);
                Log.i(TAG, "Set tx_gain: " + gain + " dB");
                changed = true;
            } else {
                Log.w(TAG, "Ignoring invalid tx_gain: " + gain);
            }
        }

        if (intent.hasExtra("rx_gain")) {
            float gain = intent.getFloatExtra("rx_gain", 0.0f);
            if (isValidGain(gain)) {
                audioEditor.putFloat("rx_gain", gain);
                Log.i(TAG, "Set rx_gain: " + gain + " dB");
                changed = true;
            } else {
                Log.w(TAG, "Ignoring invalid rx_gain: " + gain);
            }
        }

        if (intent.hasExtra("remember_forwarded_sms_id")) {
            long smsId = intent.getLongExtra("remember_forwarded_sms_id", -1L);
            if (smsId >= 0) {
                SmsHandler.rememberForwardedSms(context, smsId);
                Log.i(TAG, "Remembered forwarded SMS id: " + smsId);
            }
        }

        // Device mute preset
        if (intent.hasExtra("mute_preset")) {
            String preset = intent.getStringExtra("mute_preset");
            SharedPreferences mutePrefs = context.getSharedPreferences("device_mute_prefs", Context.MODE_PRIVATE);
            mutePrefs.edit().putString("mute_preset", preset).apply();
            Log.i(TAG, "Set mute_preset: " + preset);
            changed = true;
        }

        if (changed) {
            editor.apply();
            audioEditor.apply();
            Log.i(TAG, "Configuration saved");
        }

        // Restart SIP service if requested
        if (intent.getBooleanExtra("restart", false)) {
            Log.i(TAG, "Restarting SIP service...");
            stopGateway(context);
            // Small delay before restart
            new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
                startGateway(context);
            }, 500);
        }
    }

    private void showConfig(Context context) {
        SharedPreferences prefs = context.getSharedPreferences("gateway_prefs", Context.MODE_PRIVATE);
        SharedPreferences audioPrefs = context.getSharedPreferences("gsm_audio_config", Context.MODE_PRIVATE);
        SharedPreferences mutePrefs = context.getSharedPreferences("device_mute_prefs", Context.MODE_PRIVATE);

        Log.i(TAG, "=== Current Configuration ===");
        Log.i(TAG, "sip_server: " + prefs.getString("sip_server", "(not set)"));
        Log.i(TAG, "sip_port: " + prefs.getInt("sip_port", 5060));
        Log.i(TAG, "sip_user: " + prefs.getString("sip_user", "(not set)"));
        Log.i(TAG, "sip_password: " + (prefs.contains("sip_password") ? "****" : "(not set)"));
        Log.i(TAG, "use_tls: " + prefs.getBoolean("use_tls", false));
        String realm = prefs.getString("sip_realm", "");
        Log.i(TAG, "sip_realm: " + (realm.isEmpty() ? "* (any)" : realm));
        Log.i(TAG, "sim1_destination: " + prefs.getString("sim1_destination", "(not set)"));
        Log.i(TAG, "sim2_destination: " + prefs.getString("sim2_destination", "(not set)"));
        Log.i(TAG, "audio_card: " + audioPrefs.getInt("card", 0));
        Log.i(TAG, "capture_device: " + audioPrefs.getInt("capture_device", GatewayConfig.PIXEL_CAPTURE_DEVICE));
        Log.i(TAG, "playback_device: " + audioPrefs.getInt("playback_device", GatewayConfig.PIXEL_PLAYBACK_DEVICE));
        String legacyRoute = audioPrefs.getString("multimedia_route", null);
        Log.i(TAG, "capture_route: " + audioPrefs.getString("capture_route",
            legacyRoute != null ? legacyRoute : GatewayConfig.PIXEL_CAPTURE_ROUTE));
        Log.i(TAG, "injection_route: " + audioPrefs.getString("injection_route",
            legacyRoute != null ? legacyRoute : GatewayConfig.PIXEL_INJECTION_ROUTE));
        Log.i(TAG, "tx_gain: " + audioPrefs.getFloat("tx_gain", 0.0f) + " dB");
        Log.i(TAG, "rx_gain: " + audioPrefs.getFloat("rx_gain", 0.0f) + " dB");
        Log.i(TAG, "mute_preset: " + mutePrefs.getString("mute_preset", DeviceMuteManager.PRESET_PIXEL_3_XL));
        Log.i(TAG, "=============================");
    }

    private static boolean isValidGain(float gain) {
        return !Float.isNaN(gain) && !Float.isInfinite(gain) && gain >= -20.0f && gain <= 20.0f;
    }
}
