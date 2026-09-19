package net.elfradio.elfremote;
import org.json.*;
import org.junit.Test;
import static org.junit.Assert.*;
public class PhotoPolicyTest {
    @Test public void wifiAndCriticalBatteryAreTheOnlyAutomaticPhotoTriggers()throws Exception{
        JSONObject r=new JSONObject().put("network","wifi");assertTrue(PhotoPolicy.wanted(r));assertFalse(PhotoPolicy.critical(r));
        r.put("network","cellular");assertFalse(PhotoPolicy.wanted(r));
        JSONObject e=new JSONObject().put("type","low_battery").put("thresholds",new JSONArray("[2]")).put("level",2);r.put("report_event",e);
        assertFalse(PhotoPolicy.wanted(r));e.put("level",1);assertTrue(PhotoPolicy.wanted(r));assertTrue(PhotoPolicy.critical(r));
        e.put("thresholds",new JSONArray("[10]"));assertFalse(PhotoPolicy.wanted(r));
    }
    @Test public void networkSwitchPausesOrdinaryPhotoAndCriticalStillRequiresConnection(){
        assertTrue(PhotoPolicy.networkAllowed(true,true,false));assertFalse(PhotoPolicy.networkAllowed(false,true,false));
        assertTrue(PhotoPolicy.networkAllowed(false,true,true));assertFalse(PhotoPolicy.networkAllowed(false,false,true));
    }
    @Test public void ordinaryPhotosHaveFifteenMinuteCadenceAndSkipStaleReports(){
        long now=2000000L;
        assertFalse(PhotoPolicy.due(now,now-6000));assertFalse(PhotoPolicy.due(now,now-899999));
        assertTrue(PhotoPolicy.due(now,now-900000));assertTrue(PhotoPolicy.due(now,0));
        assertFalse(PhotoPolicy.recent(now,now-900001));assertTrue(PhotoPolicy.recent(now,now-1000));
    }
    @Test public void transmittedReportKeepsSampleTimeAfterOutboxRemovesPrivateTimestamp()throws Exception {
        java.io.File folder=java.nio.file.Files.createTempDirectory("photo-report").toFile();
        try{
            StatusOutbox outbox=new StatusOutbox(folder,4);
            long at=1788995200000L;
            JSONObject body=new JSONObject().put("report_id","fixture").put("queued_at_ms",at).put("reported_at","2026-09-09T23:06:40.000Z").put("network","wifi");
            outbox.add(body);
            new StatusReporter(outbox,text->{JSONObject sent=new JSONObject(text);assertFalse(sent.has("queued_at_ms"));
                assertEquals(at,PhotoPolicy.sampledAt(sent));assertTrue(PhotoPolicy.recent(at+1000,PhotoPolicy.sampledAt(sent)));
                return "{ok:true,report_id:fixture}";
            }).flush("test-token");
        }finally{for(java.io.File f:folder.listFiles())f.delete();folder.delete();}
    }
}
