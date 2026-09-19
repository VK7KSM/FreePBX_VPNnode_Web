package net.elfradio.elfremote;

import android.app.*;
import android.content.*;
import android.graphics.Color;
import android.os.*;
import android.view.*;
import android.widget.*;
import org.json.JSONObject;
import java.lang.ref.WeakReference;

/** 只显示丢失状态；系统锁屏负责身份验证，独立核心负责计时与清除。 */
public final class LostScreenActivity extends Activity {
    private static WeakReference<LostScreenActivity> visible=new WeakReference<>(null);
    private static boolean shownThisProcess;
    private TextView title,description;
    private Chronometer countdown;
    private static SharedPreferences prefs(Context c){return c.getSharedPreferences("lost-display",Context.MODE_PRIVATE);}
    static synchronized void refresh(Context context,JSONObject mode){
        boolean enabled=mode.optBoolean("enabled"),before=prefs(context).getBoolean("enabled",false);
        SharedPreferences.Editor e=prefs(context).edit().putBoolean("enabled",enabled).putLong("deadline",mode.optLong("deadline_at"));
        if(mode.has("message"))e.putString("message",mode.optString("message"));
        e.apply();
        LostScreenActivity current=visible.get();
        if(current!=null){current.runOnUiThread(current::render);return;}
        if(!enabled){shownThisProcess=false;return;}
        if(!before||!shownThisProcess){
            try{context.startActivity(new Intent(context,LostScreenActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_SINGLE_TOP));shownThisProcess=true;}
            catch(Exception failure){RuntimeLog.error("lost-screen-pending",failure);}
        }
    }
    @Override public void onCreate(Bundle saved){
        super.onCreate(saved);visible=new WeakReference<>(this);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED|WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        LinearLayout body=new LinearLayout(this);body.setOrientation(LinearLayout.VERTICAL);body.setGravity(Gravity.CENTER);
        int pad=(int)(12*getResources().getDisplayMetrics().density);body.setPadding(pad,pad,pad,pad);body.setBackgroundColor(Color.rgb(20,29,47));
        title=new TextView(this);title.setTextColor(Color.WHITE);title.setTextSize(19);title.setGravity(Gravity.CENTER);body.addView(title);
        countdown=new Chronometer(this);countdown.setTextColor(Color.rgb(245,196,81));countdown.setTextSize(26);countdown.setGravity(Gravity.CENTER);countdown.setCountDown(true);body.addView(countdown);
        description=new TextView(this);description.setTextColor(Color.rgb(186,196,210));description.setTextSize(13);description.setGravity(Gravity.CENTER);description.setPadding(0,pad,0,pad);body.addView(description);
        Button unlock=new Button(this);unlock.setText("输入系统密码");unlock.setTextSize(13);body.addView(unlock);
        unlock.setOnClickListener(v->((KeyguardManager)getSystemService(KEYGUARD_SERVICE)).requestDismissKeyguard(this,new KeyguardManager.KeyguardDismissCallback(){
            @Override public void onDismissSucceeded(){
                new Thread(()->{try{if(new LostMode(LostScreenActivity.this).localUnlock())ServiceStarter.startNow(LostScreenActivity.this);}
                    catch(Exception error){RuntimeLog.error("lost-local-unlock-pending",error);}},"lost-system-unlock").start();
            }
        }));
        setContentView(body);render();
    }
    private void render(){
        SharedPreferences s=prefs(this);if(!s.getBoolean("enabled",false)){finish();return;}
        long deadline=s.getLong("deadline",0);title.setText(deadline>0?"设备数据清除倒计时":"设备已锁定");
        countdown.stop();countdown.setVisibility(deadline>0?View.VISIBLE:View.GONE);
        if(deadline>0){countdown.setBase(SystemClock.elapsedRealtime()+Math.max(0,deadline-System.currentTimeMillis()));countdown.start();}
        String message=s.getString("message","");description.setText(message+(deadline>0?"\n退出丢失模式可取消清除":""));
    }
    @Override protected void onStart(){super.onStart();visible=new WeakReference<>(this);render();}
    @Override protected void onStop(){countdown.stop();super.onStop();}
    @Override protected void onDestroy(){if(visible.get()==this)visible.clear();super.onDestroy();}
}
