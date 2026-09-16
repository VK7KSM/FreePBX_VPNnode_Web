package org.onetwoone.gateway.remote;

import android.content.Context;
import android.os.*;
import java.io.Closeable;
import java.util.*;

/** root 核心保存到期动作；应用 UID 负责系统闹钟，Handler 作为清醒状态下的兜底。 */
final class GatewayCoreWake implements Closeable {
    private static final class Entry {final long due;final Runnable action,fallback;Entry(long due,Runnable action,Runnable fallback){this.due=due;this.action=action;this.fallback=fallback;}}
    private final Context context;private final Handler handler;private final Map<String,Entry> entries=new HashMap<>();
    private final Map<String,PowerManager.WakeLock> locks=new HashMap<>();
    private final Map<String,TimerTask> timeouts=new HashMap<>();
    private final Timer timer=new Timer("gateway-core-wake-timeout",true);
    GatewayCoreWake(Context context,Handler handler){this.context=context;this.handler=handler;}
    synchronized void schedule(String key,long delay,Runnable action){
        cancel(key);long due=SystemClock.elapsedRealtime()+Math.max(1000,delay);
        final Entry[] owner=new Entry[1];Runnable fallback=()->fire(key,owner[0]);owner[0]=new Entry(due,action,fallback);
        entries.put(key,owner[0]);handler.postDelayed(fallback,Math.max(1000,delay));
    }
    synchronized void cancel(String key){Entry entry=entries.remove(key);if(entry!=null)handler.removeCallbacks(entry.fallback);}
    void runDue(){for(String key:dueKeys())fire(key,null);}
    synchronized long nextDelay(){long now=SystemClock.elapsedRealtime(),next=Long.MAX_VALUE;for(Entry entry:entries.values())next=Math.min(next,entry.due);return next==Long.MAX_VALUE?-1:Math.max(0,next-now);}
    private synchronized List<String> dueKeys(){long now=SystemClock.elapsedRealtime();List<String> keys=new ArrayList<>();for(Map.Entry<String,Entry> item:entries.entrySet())if(item.getValue().due<=now)keys.add(item.getKey());return keys;}
    private void fire(String key,Entry expected){Runnable action; synchronized(this){Entry entry=entries.get(key);if(entry==null||(expected!=null&&entry!=expected)||entry.due>SystemClock.elapsedRealtime())return;entries.remove(key);handler.removeCallbacks(entry.fallback);action=entry.action;}action.run();}
    synchronized void hold(String key,long timeout){
        release(key);PowerManager manager=context.getSystemService(PowerManager.class);
        PowerManager.WakeLock lock=manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"elfRemote:gateway-"+key);
        lock.setReferenceCounted(false);lock.acquire();locks.put(key,lock);
        TimerTask end=new TimerTask(){public void run(){synchronized(GatewayCoreWake.this){if(timeouts.get(key)==this)release(key);}}};
        timeouts.put(key,end);timer.schedule(end,Math.min(120000,Math.max(1000,timeout)));
    }
    synchronized void release(String key){TimerTask end=timeouts.remove(key);if(end!=null)end.cancel();PowerManager.WakeLock lock=locks.remove(key);if(lock!=null&&lock.isHeld())lock.release();}
    public synchronized void close(){for(String key:new ArrayList<>(entries.keySet()))cancel(key);for(String key:new ArrayList<>(locks.keySet()))release(key);timer.cancel();}
}
