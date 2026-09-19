package net.elfradio.elfremote;
import org.junit.Test;
import static org.junit.Assert.*;
public class MediaAudioMeterTest {
    @Test public void shortSoundBetweenLogTicksIsIncluded(){MediaAudioMeter meter=new MediaAudioMeter();assertNull(meter.add(new byte[]{0,0},0));assertNull(meter.add(new byte[]{0,(byte)128},100));String result=meter.add(new byte[]{0,0},5000);assertTrue(result.contains("peak=32768"));assertTrue(result.contains("samples=3"));assertEquals("rms=0 peak=0 samples=1",meter.add(new byte[]{0,0},10000));}
}
