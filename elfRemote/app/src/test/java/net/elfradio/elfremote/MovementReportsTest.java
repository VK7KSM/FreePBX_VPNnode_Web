package net.elfradio.elfremote;
import org.json.*;
import org.junit.Test;
import static org.junit.Assert.*;

public class MovementReportsTest {
    private static final long NOW=1788900000000L;
    private static String at(long time){java.text.SimpleDateFormat f=new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",java.util.Locale.US);f.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));return f.format(new java.util.Date(time));}
    private static JSONObject gps(double meters,long time)throws Exception{return new JSONObject().put("lat",Math.toDegrees(meters/6371000)).put("lng",0).put("acc_m",20).put("provider","gps").put("at",at(time));}
    private static JSONObject report(String id,double meters,long time)throws Exception{return new JSONObject().put("device_id","lab").put("report_id",id).put("queued_at_ms",time).put("gps",gps(meters,time)).put("network","cellular");}
    private static void cleanup(java.nio.file.Path dir)throws Exception{try(java.util.stream.Stream<java.nio.file.Path> files=java.nio.file.Files.walk(dir)){for(java.nio.file.Path f:files.sorted(java.util.Comparator.reverseOrder()).toArray(java.nio.file.Path[]::new))java.nio.file.Files.delete(f);}}
    @Test public void accurateFreshGpsRequiredAndDatelineDistance()throws Exception{
        assertTrue(MovementReports.fresh(gps(0,NOW),NOW));assertFalse(MovementReports.fresh(gps(0,NOW-120001),NOW));assertFalse(MovementReports.fresh(gps(0,NOW+1),NOW));
        assertFalse(MovementReports.valid(gps(0,NOW).put("provider","network")));assertFalse(MovementReports.valid(gps(0,NOW).put("acc_m",201)));
        assertFalse(MovementReports.valid(gps(0,NOW).put("lat",91)));assertFalse(MovementReports.valid(gps(0,NOW).put("acc_m",JSONObject.NULL)));
        assertEquals(222.39,MovementReports.distance(gps(0,NOW).put("lng",179.999),gps(0,NOW).put("lng",-179.999)),.1);
    }
    @Test public void thresholdPendingRetryAndRestartBaseline()throws Exception{
        java.nio.file.Path dir=java.nio.file.Files.createTempDirectory("movement");try{
            java.io.File state=dir.resolve("state.json").toFile();MovementReports r=new MovementReports(state);StatusOutbox outbox=new StatusOutbox(dir.resolve("outbox").toFile(),16);
            r.acknowledged(report("baseline",0,NOW-10000));
            assertNull(r.prepare(outbox,report("below",3000,NOW),NOW));
            assertNull(r.prepare(outbox,report("margin",3039,NOW),NOW));
            JSONObject moved=report("moved",3050,NOW);assertEquals("moved",r.prepare(outbox,moved,NOW));assertEquals("movement",moved.getJSONObject("report_event").getString("type"));
            r=new MovementReports(state);assertEquals("moved",r.prepare(outbox,report("retry",7000,NOW+1000),NOW+1000));assertEquals(1,outbox.entries().length);
            r.acknowledged(moved);outbox.entries()[0].delete();r=new MovementReports(state);
            assertNull(r.prepare(outbox,report("still",3050,NOW+1000),NOW+1000));
            r.acknowledged(report("late",0,NOW-5000));assertNull(r.prepare(outbox,report("still-two",3050,NOW+2000),NOW+2000));
            assertEquals("next",r.prepare(outbox,report("next",7000,NOW+3000),NOW+3000));
        }finally{cleanup(dir);}
    }
    @Test public void wifiDoesNotTriggerAndFirstGpsSeedsOnlyOnce()throws Exception{
        java.nio.file.Path dir=java.nio.file.Files.createTempDirectory("movement-first");try{
            MovementReports r=new MovementReports(dir.resolve("state.json").toFile());StatusOutbox o=new StatusOutbox(dir.resolve("outbox").toFile(),16);
            assertNull(r.prepare(o,report("wifi",0,NOW).put("network","wifi"),NOW));
            JSONObject first=report("first",0,NOW);assertEquals("first",r.prepare(o,first,NOW));assertFalse(first.has("report_event"));
            assertEquals("first",r.prepare(o,report("again",100,NOW+1),NOW+1));assertEquals(1,o.entries().length);
        }finally{cleanup(dir);}
    }
}
