package org.onetwoone.gateway.remote;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.telecom.TelecomManager;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.lang.ref.WeakReference;

/** Full-screen message that can always be cleared by the remote management state. */
public final class GatewayLostModeActivity extends Activity {
    private static final String CHANNEL="gateway-lost-mode";
    private static final int NOTIFICATION_ID=2402;
    private static WeakReference<GatewayLostModeActivity> current=new WeakReference<>(null);
    private static volatile boolean resumed;
    private final Handler handler=new Handler();

    static void open(Context context){Intent intent=intent(context);showFullScreenNotification(context,intent);context.startActivity(intent);}
    static void close(Context context){NotificationManager manager=(NotificationManager)context.getSystemService(NOTIFICATION_SERVICE);if(manager!=null)manager.cancel(NOTIFICATION_ID);closeOpenInstance();}
    static void closeOpenInstance(){GatewayLostModeActivity value=current.get();if(value!=null)value.runOnUiThread(value::finishAndRemoveTask);}
    static boolean isVisible(){GatewayLostModeActivity value=current.get();return resumed&&value!=null&&!value.isFinishing();}

    private static Intent intent(Context context){return new Intent(context,GatewayLostModeActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_SINGLE_TOP|Intent.FLAG_ACTIVITY_CLEAR_TOP);}
    private static void showFullScreenNotification(Context context,Intent intent) {
        NotificationManager manager=(NotificationManager)context.getSystemService(NOTIFICATION_SERVICE);if(manager==null)return;
        if(android.os.Build.VERSION.SDK_INT>=26) {
            NotificationChannel channel=new NotificationChannel(CHANNEL,"设备丢失信息",NotificationManager.IMPORTANCE_HIGH);
            channel.setSound(null,null);channel.enableVibration(false);channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            manager.createNotificationChannel(channel);
        }
        int flags=PendingIntent.FLAG_UPDATE_CURRENT;
        if(android.os.Build.VERSION.SDK_INT>=23)flags|=PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pending=PendingIntent.getActivity(context,NOTIFICATION_ID,intent,flags);
        Notification.Builder builder=android.os.Build.VERSION.SDK_INT>=26?new Notification.Builder(context,CHANNEL):new Notification.Builder(context);
        Notification notification=builder.setSmallIcon(android.R.drawable.stat_sys_warning).setContentTitle("设备已进入丢失模式")
                .setContentText("点击查看设备信息").setCategory(Notification.CATEGORY_ALARM).setPriority(Notification.PRIORITY_MAX)
                .setVisibility(Notification.VISIBILITY_PUBLIC).setOngoing(true).setAutoCancel(false)
                .setContentIntent(pending).setFullScreenIntent(pending,true).build();
        manager.notify(NOTIFICATION_ID,notification);
    }

    @Override protected void onCreate(Bundle state){super.onCreate(state);current=new WeakReference<>(this);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON|WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED|WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        if(android.os.Build.VERSION.SDK_INT>=27){setShowWhenLocked(true);setTurnScreenOn(true);}render();}
    @Override protected void onNewIntent(Intent intent){super.onNewIntent(intent);render();}
    @Override protected void onResume(){super.onResume();if(!active()){finishAndRemoveTask();return;}resumed=true;immersive();}
    @Override protected void onPause(){resumed=false;super.onPause();}
    @Override protected void onStop(){super.onStop();handler.postDelayed(()->{if(active()&&!inCall())open(getApplicationContext());},1000L);}
    @Override protected void onDestroy(){handler.removeCallbacksAndMessages(null);resumed=false;if(current.get()==this)current.clear();super.onDestroy();}
    @Override public void onBackPressed(){if(!active())super.onBackPressed();}

    private void render(){if(!active()){finish();return;}String message=getSharedPreferences("gateway-lost-display",MODE_PRIVATE).getString("message","");
        LinearLayout root=new LinearLayout(this);root.setOrientation(LinearLayout.VERTICAL);root.setGravity(Gravity.CENTER);root.setPadding(48,64,48,64);root.setBackgroundColor(Color.rgb(18,22,27));
        TextView title=text("设备已进入丢失模式",26,Color.WHITE);TextView body=text(message,22,Color.rgb(242,245,247));body.setPadding(0,36,0,0);
        root.addView(title,new LinearLayout.LayoutParams(-1,-2));root.addView(body,new LinearLayout.LayoutParams(-1,-2));setContentView(root);immersive();}
    private TextView text(String value,int size,int color){TextView view=new TextView(this);view.setText(value);view.setTextSize(size);view.setTextColor(color);view.setGravity(Gravity.CENTER);view.setLineSpacing(0,1.15f);return view;}
    private boolean active(){return getSharedPreferences("gateway-lost-display",MODE_PRIVATE).getBoolean("active",false);}
    private boolean inCall(){TelecomManager telecom=(TelecomManager)getSystemService(TELECOM_SERVICE);try{return telecom!=null&&telecom.isInCall();}catch(SecurityException ignored){return true;}}
    private void immersive(){getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY|View.SYSTEM_UI_FLAG_FULLSCREEN|View.SYSTEM_UI_FLAG_HIDE_NAVIGATION|View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN|View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION|View.SYSTEM_UI_FLAG_LAYOUT_STABLE);}
}
