package net.elfradio.elfremote;

import android.app.AlarmManager;
import android.content.Context;
import android.os.*;
import java.io.Closeable;
import java.util.*;

/** 复用XX已验证的系统所有者闹钟；不用应用PendingIntent维持核心连接。 */
final class CoreWake implements Closeable {
    final Context context;
    private final AlarmManager alarms;
    private final Handler handler;
    private final Map<String,AlarmManager.OnAlarmListener> listeners=new HashMap<>();
    private final Map<String,PowerManager.WakeLock> locks=new HashMap<>();
    private final Map<String,TimerTask> timeouts=new HashMap<>();
    private final Timer timer=new Timer("elfremote-core-wake-timeout",true);
    private static Context sharedSystemContext;
    static synchronized Context systemContext()throws Exception {
        if(sharedSystemContext!=null)return sharedSystemContext;
        if(Looper.getMainLooper()==null)Looper.prepareMainLooper();
        Object activity=Class.forName("android.app.ActivityThread").getMethod("systemMain").invoke(null);
        sharedSystemContext=(Context)activity.getClass().getMethod("getSystemContext").invoke(activity);
        return sharedSystemContext;
    }
    CoreWake(Context context,Handler handler){this.context=context;this.handler=handler;alarms=(AlarmManager)context.getSystemService(Context.ALARM_SERVICE);}
    synchronized void schedule(String key,long delay,Runnable action){
        cancel(key);long due=SystemClock.elapsedRealtime()+Math.max(1000,delay);
        AlarmManager.OnAlarmListener listener=new AlarmManager.OnAlarmListener(){public void onAlarm(){
            synchronized(CoreWake.this){if(listeners.get(key)!=this)return;listeners.remove(key);}
            RuntimeLog.event("core_wake key="+key+" late_ms="+Math.max(0,SystemClock.elapsedRealtime()-due));
            action.run();
        }};
        listeners.put(key,listener);
        alarms.setExact(AlarmManager.ELAPSED_REALTIME_WAKEUP,due,"elfRemote:core-"+key,listener,handler);
    }
    synchronized void cancel(String key){AlarmManager.OnAlarmListener listener=listeners.remove(key);if(listener!=null)alarms.cancel(listener);}
    synchronized void hold(String key,long timeout){
        release(key);PowerManager.WakeLock lock=((PowerManager)context.getSystemService(Context.POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"elfRemote:core-"+key);
        lock.setReferenceCounted(false);lock.acquire();locks.put(key,lock);
        TimerTask end=new TimerTask(){public void run(){synchronized(CoreWake.this){if(timeouts.get(key)==this)release(key);}}};timeouts.put(key,end);timer.schedule(end,Math.min(120000,Math.max(1000,timeout)));
    }
    synchronized void release(String key){TimerTask end=timeouts.remove(key);if(end!=null)end.cancel();PowerManager.WakeLock lock=locks.remove(key);if(lock!=null&&lock.isHeld())lock.release();}
    public synchronized void close(){for(String key:new ArrayList<>(listeners.keySet()))cancel(key);for(String key:new ArrayList<>(locks.keySet()))release(key);timer.cancel();}
}
