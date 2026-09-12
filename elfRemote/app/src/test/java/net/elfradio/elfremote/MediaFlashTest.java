package net.elfradio.elfremote;
import org.junit.Test;import static org.junit.Assert.*;import java.util.*;
public class MediaFlashTest {
 @Test public void stoppedAndOldCallbacksCannotRelight(){
  List<Boolean> output=new ArrayList<>();List<Runnable> callbacks=new ArrayList<>();
  MediaFlash f=new MediaFlash(output::add,new MediaFlash.Scheduler(){public void post(Runnable r,long ms){assertEquals(500,ms);callbacks.add(r);}public void remove(Runnable r){}});
  f.start();assertEquals(Boolean.TRUE,output.get(0));Runnable old=callbacks.get(0);f.stop();assertEquals(Boolean.FALSE,output.get(output.size()-1));int count=output.size();old.run();assertEquals(count,output.size());
  f.start();count=output.size();old.run();assertEquals(count,output.size());f.stop();
 }
 @Test public void failedHardwareDoesNotKeepScheduling(){
  int[] scheduled={0},off={0};MediaFlash f=new MediaFlash(on->{if(on)throw new Exception("unavailable");off[0]++;},new MediaFlash.Scheduler(){public void post(Runnable r,long ms){scheduled[0]++;}public void remove(Runnable r){}});
  f.start();assertEquals(0,scheduled[0]);assertEquals(1,off[0]);f.stop();assertEquals(2,off[0]);
 }
}
