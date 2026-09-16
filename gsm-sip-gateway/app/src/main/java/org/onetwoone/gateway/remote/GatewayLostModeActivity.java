package org.onetwoone.gateway.remote;

import android.app.Activity;
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
    private static WeakReference<GatewayLostModeActivity> current=new WeakReference<>(null);
    private final Handler handler=new Handler();

    static void open(Context context){Intent intent=new Intent(context,GatewayLostModeActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_SINGLE_TOP|Intent.FLAG_ACTIVITY_CLEAR_TOP);context.startActivity(intent);}
    static void closeOpenInstance(){GatewayLostModeActivity value=current.get();if(value!=null)value.runOnUiThread(value::finishAndRemoveTask);}

    @Override protected void onCreate(Bundle state){super.onCreate(state);current=new WeakReference<>(this);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON|WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED|WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        if(android.os.Build.VERSION.SDK_INT>=27){setShowWhenLocked(true);setTurnScreenOn(true);}render();}
    @Override protected void onNewIntent(Intent intent){super.onNewIntent(intent);render();}
    @Override protected void onResume(){super.onResume();if(!active()){finishAndRemoveTask();return;}immersive();}
    @Override protected void onStop(){super.onStop();handler.postDelayed(()->{if(active()&&!inCall())open(getApplicationContext());},1000L);}
    @Override protected void onDestroy(){handler.removeCallbacksAndMessages(null);if(current.get()==this)current.clear();super.onDestroy();}
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
