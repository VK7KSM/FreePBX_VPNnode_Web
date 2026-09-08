package net.elfradio.elfremote;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.PowerManager;
import android.os.SystemClock;
import java.util.HashMap;
import java.util.Map;

/** 使用休眠仍计时的系统闹钟；唤醒锁有硬超时，不用于持续保持设备清醒。 */
final class WakeScheduler {
    static final String ACTION = "net.elfradio.elfremote.WAKE";
    private static final Map<String, PowerManager.WakeLock> locks = new HashMap<>();
    private final Context context;
    private final AlarmManager alarms;
    WakeScheduler(Context context) {
        this.context = context.getApplicationContext();
        alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
    }
    private PendingIntent intent(String key) {
        Intent i = new Intent(context, WakeReceiver.class).setAction(ACTION + "." + key).putExtra("wake_key", key);
        return PendingIntent.getBroadcast(context, 0, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
    void schedule(String key, long delayMs) {
        alarms.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP,
                SystemClock.elapsedRealtime() + Math.max(1000L, delayMs), intent(key));
    }
    void cancel(String key) { alarms.cancel(intent(key)); }
    static synchronized void hold(Context ctx, String key, long timeoutMs) {
        PowerManager.WakeLock lock = locks.get(key);
        if (lock == null) {
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            lock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "elfRemote:" + key);
            lock.setReferenceCounted(false); locks.put(key, lock);
        }
        lock.acquire(timeoutMs);
    }
    static synchronized void release(String key) {
        PowerManager.WakeLock lock = locks.get(key);
        if (lock != null && lock.isHeld()) lock.release();
    }
}
