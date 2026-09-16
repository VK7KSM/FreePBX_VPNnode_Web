package org.onetwoone.gateway.remote;

import android.content.Context;
import android.app.NotificationManager;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE,sdk=28)
public class GatewayLostModeActivityTest {
    @Before public void setup(){RuntimeEnvironment.getApplication().getSharedPreferences("gateway-lost-display",Context.MODE_PRIVATE)
            .edit().clear().putBoolean("active",true).putString("message","请联系管理员").commit();}
    @Test public void rendersMessageAndBlocksBackUntilRemoteClear(){ActivityController<GatewayLostModeActivity> controller=Robolectric.buildActivity(GatewayLostModeActivity.class).create().start().resume();GatewayLostModeActivity activity=controller.get();
        ViewGroup content=activity.findViewById(android.R.id.content);LinearLayout root=(LinearLayout)content.getChildAt(0);
        assertEquals("设备已进入丢失模式",((TextView)root.getChildAt(0)).getText().toString());
        assertEquals("请联系管理员",((TextView)root.getChildAt(1)).getText().toString());
        assertEquals(android.view.View.SYSTEM_UI_FLAG_VISIBLE,activity.getWindow().getDecorView().getSystemUiVisibility());
        assertFalse(activity.isFinishing());activity.onBackPressed();assertFalse(activity.isFinishing());
        GatewayLostModeActivity.closeOpenInstance();assertTrue(activity.isFinishing());controller.destroy();}
    @Test public void fullScreenNotificationPersistsUntilRemoteClear(){Context context=RuntimeEnvironment.getApplication();GatewayLostModeActivity.open(context);
        NotificationManager manager=(NotificationManager)context.getSystemService(Context.NOTIFICATION_SERVICE);
        assertEquals(1,Shadows.shadowOf(manager).getAllNotifications().size());
        GatewayLostModeActivity.close(context);assertEquals(0,Shadows.shadowOf(manager).getAllNotifications().size());}
}
