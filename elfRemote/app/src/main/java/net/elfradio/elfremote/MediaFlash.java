package net.elfradio.elfremote;

/** 警报闪光的有界生命周期；关闭后不允许排队回调重新点亮。 */
final class MediaFlash {
    interface Output { void set(boolean enabled)throws Exception; }
    interface Scheduler { void post(Runnable r,long delay);void remove(Runnable r); }
    private final Output output;private final Scheduler scheduler;
    private boolean active,on;private long generation;
    private Runnable pending;
    MediaFlash(Output o,Scheduler s){output=o;scheduler=s;}
    synchronized void start(){if(active)return;active=true;long owner=++generation;toggle(owner);}
    private synchronized void toggle(long owner){
        if(!active||owner!=generation)return;
        try {on=!on;output.set(on);pending=()->toggle(owner);scheduler.post(pending,500);}
        catch(Exception error){stop();}
    }
    synchronized void stop(){active=false;generation++;if(pending!=null)scheduler.remove(pending);pending=null;on=false;try{output.set(false);}catch(Exception ignored){}}
}
