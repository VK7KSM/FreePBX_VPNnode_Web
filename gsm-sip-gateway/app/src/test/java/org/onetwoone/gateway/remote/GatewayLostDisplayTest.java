package org.onetwoone.gateway.remote;

import android.content.Context;
import android.content.SharedPreferences;
import java.io.IOException;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE,sdk=28)
public class GatewayLostDisplayTest {
    private SharedPreferences prefs;private FakeLauncher launcher;private GatewayLostDisplay display;
    @Before public void setup(){prefs=RuntimeEnvironment.getApplication().getSharedPreferences("lost-display-test",Context.MODE_PRIVATE);prefs.edit().clear().commit();launcher=new FakeLauncher();display=new GatewayLostDisplay(prefs,launcher);}
    @Test public void persistsNormalizedMessageAndClearsReversibly()throws Exception {JSONObject shown=display.show("  找到后请联系\r\n管理员  ");assertTrue(shown.getBoolean("active"));assertEquals(1,launcher.opens);assertEquals("找到后请联系\n管理员",prefs.getString("message",""));
        JSONObject cleared=display.clear();assertFalse(cleared.getBoolean("active"));assertEquals(1,launcher.closes);assertFalse(prefs.contains("message"));}
    @Test public void repeatsIdempotentlyAndOnlyReopensWhenIdle()throws Exception {display.show("测试");long changed=prefs.getLong("changed_at_ms",0);display.show("测试");assertEquals(changed,prefs.getLong("changed_at_ms",0));display.ensureVisible(null);display.ensureVisible(true);display.ensureVisible(false);assertEquals(3,launcher.opens);}
    @Test public void rejectsEmptyOversizedAndControlMessages()throws Exception {rejected("");rejected("\u0001bad");StringBuilder text=new StringBuilder();while(text.length()<501)text.append('a');rejected(text.toString());assertEquals(0,launcher.opens);}
    @Test public void refusesToVerifyWhenWindowNeverBecomesVisible()throws Exception {launcher.visible=false;assertFalse(GatewayLostDisplay.awaitVisible(launcher,0));}
    private void rejected(String value)throws Exception{try{display.show(value);fail();}catch(IOException expected){}}
    private static final class FakeLauncher implements GatewayLostDisplay.Launcher{int opens,closes;boolean visible=true;public void open(){opens++;}public void close(){closes++;}public boolean visible(){return visible;}}
}
