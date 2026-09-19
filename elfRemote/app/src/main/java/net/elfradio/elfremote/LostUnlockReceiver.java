package net.elfradio.elfremote;

import android.content.*;

/** 系统确认用户已解锁后退出防丢状态，不接收自定义的解锁广播。 */
public final class LostUnlockReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context,Intent intent){
        if(!Intent.ACTION_USER_PRESENT.equals(intent.getAction()))return;
        PendingResult pending=goAsync();
        new Thread(()->{try{if(new LostMode(context).localUnlock())ServiceStarter.startNow(context);}
            catch(Exception e){RuntimeLog.event("lost-local-unlock-pending");}finally{pending.finish();}},"elfremote-local-unlock").start();
    }
}
