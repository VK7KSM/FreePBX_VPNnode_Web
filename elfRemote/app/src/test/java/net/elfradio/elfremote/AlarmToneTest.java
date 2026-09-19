package net.elfradio.elfremote;
import org.junit.Test;
import static org.junit.Assert.*;

public class AlarmToneTest {
    /** 实际播放的片段数是 setLoopPoints 的次数加一。 */
    private static long playedMs(int loops){return (long)(loops+1)*AlarmTone.COUNT*1000/AlarmTone.RATE;}

    @Test public void loopCountIsFiniteAndNeverEndsEarly(){
        for(int durationMs:new int[]{1,500,1000,10000,30000,60000,600000}){
            int loops=AlarmTone.loopCount(durationMs);
            assertTrue("循环次数必须有限，不能是 -1 无限循环，时长 "+durationMs,loops>0);
            assertTrue("播放不能早于请求时长结束，时长 "+durationMs,playedMs(loops)>=durationMs);
        }
        assertEquals(8,AlarmTone.loopCount(AlarmPlayer.DURATION_MS));
        assertEquals(22,AlarmTone.loopCount(30000));
    }

    @Test public void nonPositiveDurationDoesNotLoopAndAbsurdDurationIsCapped(){
        assertEquals(0,AlarmTone.loopCount(0));
        assertEquals(0,AlarmTone.loopCount(-1));
        assertEquals(1000,AlarmTone.loopCount(Integer.MAX_VALUE));
    }

    @Test public void samplesLoopSeamlesslyAndAreLoudEnough(){
        short[] samples=AlarmTone.samples();
        assertEquals(AlarmTone.COUNT,samples.length);
        // 片段首尾都淡入淡出到接近静音，循环接缝处才不会爆音
        assertTrue(Math.abs(samples[0])<2000);
        assertTrue(Math.abs(samples[samples.length-1])<2000);
        int peak=0;for(short value:samples)peak=Math.max(peak,Math.abs(value));
        assertTrue("警报必须够响，这正是 ToneGenerator 版本听不见的原因",peak>18000);
        // 两个半段频率不同，否则就不是双音
        assertFalse(sameShape(samples,0,AlarmTone.HALF));
    }

    private static boolean sameShape(short[] samples,int from,int offset){
        for(int i=from;i<from+400;i++)if(Math.abs(samples[i]-samples[i+offset])>500)return false;
        return true;
    }
}
