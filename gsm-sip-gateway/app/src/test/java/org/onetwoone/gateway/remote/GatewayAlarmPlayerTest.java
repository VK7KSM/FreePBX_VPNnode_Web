package org.onetwoone.gateway.remote;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowLooper;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE,sdk=28)
public class GatewayAlarmPlayerTest {
    private SharedPreferences state;private FakeVolume volume;private FakeTone tone;private GatewayAlarmPlayer alarm;
    @Before public void setup(){state=RuntimeEnvironment.getApplication().getSharedPreferences("alarm-test",Context.MODE_PRIVATE);state.edit().clear().commit();
        volume=new FakeVolume(2,7);tone=new FakeTone();alarm=new GatewayAlarmPlayer(state,new Handler(),()->{},volume,()->tone);}
    @Test public void raisesAndRestoresVolumeOnStop()throws Exception {assertEquals("playing",alarm.play("one",false).getString("state"));assertEquals(7,volume.value);
        assertEquals("stopped",alarm.stop().getString("state"));assertEquals(2,volume.value);assertTrue(tone.stopped);}
    @Test public void repeatedPlayIsIdempotent()throws Exception {alarm.play("one",false);alarm.play("one",false);assertEquals(1,tone.starts);alarm.stop();}
    @Test public void replacementAlarmPreservesOriginalVolume()throws Exception {alarm.play("one",false);alarm.play("two",false);assertEquals(2,tone.starts);alarm.stop();assertEquals(2,volume.value);}
    @Test public void automaticallyStopsAndRestoresVolume()throws Exception {alarm.play("one",false);ShadowLooper.idleMainLooper(GatewayAlarmPlayer.DURATION_MS+1,java.util.concurrent.TimeUnit.MILLISECONDS);
        assertEquals("completed",alarm.snapshot().getString("state"));assertEquals(2,volume.value);}
    @Test public void refusesAlarmDuringCall()throws Exception {try{alarm.play("one",true);fail();}catch(Exception expected){assertEquals("gateway-busy",expected.getMessage());}assertEquals(2,volume.value);assertEquals(0,tone.starts);}
    @Test public void refusesAlarmWhenGatewayStateIsUnknown()throws Exception {try{alarm.play("one",null);fail();}catch(Exception expected){assertEquals("gateway-busy",expected.getMessage());}assertEquals(0,tone.starts);}
    @Test public void constructionRecoversInterruptedVolume()throws Exception{state.edit().putString("state","playing").putBoolean("volume_saved",true).putInt("saved_volume",3).commit();volume.value=7;
        alarm=new GatewayAlarmPlayer(state,new Handler(),()->{},volume,()->tone);assertEquals(3,volume.value);assertEquals("interrupted",alarm.snapshot().optString("state"));}
    @Test public void toneLoopCountCoversRequestedDurationWithoutTruncating(){
        int segment=GatewayAlarmPlayer.TONE_COUNT*1000/GatewayAlarmPlayer.TONE_RATE;
        assertEquals(1400,segment);
        // 默认 10 秒：向上取整到 8 遍（11.2 秒），保证兜底不早于上层定时器停止
        assertEquals(7,GatewayAlarmPlayer.toneLoopCount(GatewayAlarmPlayer.DURATION_MS));
        assertTrue((GatewayAlarmPlayer.toneLoopCount(GatewayAlarmPlayer.DURATION_MS)+1)*segment>=GatewayAlarmPlayer.DURATION_MS);
        for(int duration=1;duration<=60000;duration+=137)
            assertTrue("时长 "+duration+" 被截断",(GatewayAlarmPlayer.toneLoopCount(duration)+1)*segment>=duration);
    }
    @Test public void toneLoopCountIsAlwaysAFiniteBoundedLoop(){
        for(int duration:new int[]{Integer.MIN_VALUE,-1,0,1,1399,1400,1401,Integer.MAX_VALUE}){
            int loops=GatewayAlarmPlayer.toneLoopCount(duration);
            assertTrue("必须有限循环，不得为 -1",loops>=0);
            assertTrue("不得超过上限",loops<=GatewayAlarmPlayer.TONE_MAX_LOOPS-1);
        }
        assertEquals(0,GatewayAlarmPlayer.toneLoopCount(0));
        assertEquals(0,GatewayAlarmPlayer.toneLoopCount(1400));
        assertEquals(1,GatewayAlarmPlayer.toneLoopCount(1401));
    }
    private static final class FakeVolume implements GatewayAlarmPlayer.Volume {int value;final int max;FakeVolume(int value,int max){this.value=value;this.max=max;}public int current(){return value;}public int maximum(){return max;}public void set(int value){this.value=value;}}
    private static final class FakeTone implements GatewayAlarmPlayer.Tone {int starts;boolean stopped;public boolean start(int duration){starts++;return true;}public void stop(){stopped=true;}}
}
