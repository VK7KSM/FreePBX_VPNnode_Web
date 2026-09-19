package net.elfradio.elfremote;
import org.junit.Test;
import static org.junit.Assert.*;

public class AlarmToneTest {
    @Test public void loopCountIsFiniteAndNeverEndsEarly(){
        assertEquals(1400,AlarmTone.SEGMENT_MS);
        for(int durationMs=1;durationMs<=60000;durationMs+=137){
            int loops=AlarmTone.loopCount(durationMs);
            assertTrue("循环次数必须有限，不得为 -1，时长 "+durationMs,loops>=0);
            assertTrue("时长 "+durationMs+" 被截断",(long)(loops+1)*AlarmTone.SEGMENT_MS>=durationMs);
        }
        // 与网关 toneLoopCount 同语义：返回的是再重复几遍，总遍数为该值加一。
        // 默认 10 秒向上取整到 8 遍共 11.2 秒，兜底不早于上层定时器停止。
        assertEquals(7,AlarmTone.loopCount(AlarmPlayer.DURATION_MS));
        assertEquals(21,AlarmTone.loopCount(30000));
    }

    @Test public void boundedForAbsurdOrNonPositiveDurations(){
        for(int durationMs:new int[]{Integer.MIN_VALUE,-1,0,1,1399,1400,1401,Integer.MAX_VALUE}){
            int loops=AlarmTone.loopCount(durationMs);
            assertTrue("必须有限循环，不得为 -1",loops>=0);
            assertTrue("不得超过上限",loops<=AlarmTone.MAX_PLAYS-1);
        }
        assertEquals(0,AlarmTone.loopCount(0));
        assertEquals(0,AlarmTone.loopCount(1400));
        assertEquals(1,AlarmTone.loopCount(1401));
    }

    @Test public void samplesLoopSeamlesslyAndAreLoudEnough(){
        short[] samples=AlarmTone.samples();
        assertEquals(AlarmTone.COUNT,samples.length);
        // 片段首尾都淡入淡出到接近静音，循环接缝处才不会爆音
        assertTrue(Math.abs(samples[0])<2000);
        assertTrue(Math.abs(samples[samples.length-1])<2000);
        int peak=0;for(short value:samples)peak=Math.max(peak,Math.abs(value));
        assertTrue("警报必须够响，这正是 ToneGenerator 版本听不见的原因",peak>18000);
        // 相邻两个半段频率不同，否则就不是双音
        assertFalse(sameShape(samples,AlarmTone.HALF));
    }

    private static boolean sameShape(short[] samples,int offset){
        for(int i=200;i<600;i++)if(Math.abs(samples[i]-samples[i+offset])>500)return false;
        return true;
    }
}
