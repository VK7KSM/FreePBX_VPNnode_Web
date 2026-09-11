package net.elfradio.elfremote;

import android.app.*;
import android.content.*;
import org.json.JSONObject;

/** 应用UID负责可见通知；倒计时及擦除仍由独立核心执行。 */
public final class LostNoticeReceiver extends BroadcastReceiver {
    static void update(Context context){
        if(!LostProtection.supported())return;
        try{
            JSONObject mode=CoreClient.request("/lost/status",null);if(mode==null)return;
            NotificationManager manager=(NotificationManager)context.getSystemService(Context.NOTIFICATION_SERVICE);
            long deadline=mode.optLong("deadline_at");
            if(deadline<=0){manager.cancel(9124);return;}
            String channel="elfremote-lost";
            NotificationChannel c=new NotificationChannel(channel,"丢失模式",NotificationManager.IMPORTANCE_DEFAULT);
            c.setSound(null,null);c.enableVibration(false);c.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);manager.createNotificationChannel(c);
            manager.notify(9124,new Notification.Builder(context,channel).setSmallIcon(android.R.drawable.ic_lock_lock)
                    .setContentTitle("设备数据清除倒计时").setContentText("退出丢失模式可取消")
                    .setWhen(deadline).setUsesChronometer(true).setChronometerCountDown(true).setShowWhen(true)
                    .setOngoing(true).setOnlyAlertOnce(true).setVisibility(Notification.VISIBILITY_PUBLIC).build());
        }catch(Exception error){RuntimeLog.error("lost-notice-pending",error);}
    }
    @Override public void onReceive(Context context,Intent intent){
        PendingResult pending=goAsync();new Thread(()->{try{update(context);}finally{pending.finish();}},"elfremote-lost-notice").start();
    }
}
