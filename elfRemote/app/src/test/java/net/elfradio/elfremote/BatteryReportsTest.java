package net.elfradio.elfremote;
import org.json.*;
import org.junit.Test;
import static org.junit.Assert.*;

public class BatteryReportsTest {
    @Test public void strictThresholdsAndSingleMergedEvent()throws Exception{
        JSONObject s=BatteryReports.observe(new JSONObject(),10,false,1,"a");assertFalse(s.has("pending"));
        s=BatteryReports.observe(s,9,false,2,"b");assertEquals("[10]",BatteryReports.event(s.getJSONObject("pending")).getJSONArray("thresholds").toString());
        s.remove("pending");s=BatteryReports.observe(s,5,false,3,"c");assertFalse(s.has("pending"));
        s=BatteryReports.observe(s,1,false,4,"d");assertEquals("[5,2]",BatteryReports.event(s.getJSONObject("pending")).getJSONArray("thresholds").toString());
        s.remove("pending");assertFalse(BatteryReports.observe(new JSONObject(s.toString()),1,false,5,"e").has("pending"));
    }
    @Test public void chargingRearmsOnlyAboveThresholdAndInvalidSamplesDoNothing()throws Exception{
        JSONObject s=BatteryReports.observe(new JSONObject(),1,false,1,"a");assertEquals("[10,5,2]",BatteryReports.event(s.getJSONObject("pending")).getJSONArray("thresholds").toString());s.remove("pending");
        s=BatteryReports.observe(s,10,true,2,"b");s=BatteryReports.observe(s,9,false,3,"c");assertFalse(s.has("pending"));
        s=BatteryReports.observe(s,11,true,4,"d");s=BatteryReports.observe(s,9,false,5,"e");assertEquals("[10]",BatteryReports.event(s.getJSONObject("pending")).getJSONArray("thresholds").toString());
        assertEquals(s.toString(),BatteryReports.observe(s,-1,false,6,"f").toString());
    }
    @Test public void pendingSurvivesRestartUntilQueueCommit()throws Exception{
        java.nio.file.Path dir=java.nio.file.Files.createTempDirectory("battery-report");java.io.File file=dir.resolve("state.json").toFile();
        try{
            BatteryReports r=new BatteryReports(file);assertTrue(r.observe(1,false));String id=r.pending().getString("id");
            r=new BatteryReports(file);assertEquals(id,r.pending().getString("id"));r.queued("wrong");assertNotNull(r.pending());r.queued(id);
            r=new BatteryReports(file);assertFalse(r.observe(1,false));assertNull(r.pending());
        }finally{file.delete();dir.toFile().delete();}
    }
}
