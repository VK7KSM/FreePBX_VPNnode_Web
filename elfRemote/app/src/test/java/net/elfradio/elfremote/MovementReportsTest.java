package net.elfradio.elfremote;
import org.json.*;
import org.junit.Test;
import static org.junit.Assert.*;

public class MovementReportsTest {
    @Test public void ordinaryOfflineHistoryCannotSuppressNewThreeKilometerMovement()throws Exception{
        java.nio.file.Path dir=java.nio.file.Files.createTempDirectory("movement-backlog");try{
            MovementReports r=new MovementReports(dir.resolve("state.json").toFile());StatusOutbox box=new StatusOutbox(dir.resolve("outbox").toFile(),16);
            r.acknowledged(report("baseline",0,NOW-10000));
            box.add(report("old-wifi",0,NOW-5000).put("network","wifi"));
            JSONObject moved=report("moved",2000,NOW);
            assertEquals("moved",r.prepare(box,moved,NOW));assertEquals("movement",moved.getJSONObject("report_event").getString("type"));
            assertEquals(2,box.entries().length);
        }finally{cleanup(dir);}
    }
    private static final long NOW=1788900000000L;
    private static String at(long time){java.text.SimpleDateFormat f=new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",java.util.Locale.US);f.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));return f.format(new java.util.Date(time));}
    private static JSONObject gps(double meters,long time)throws Exception{return new JSONObject().put("lat",Math.toDegrees(meters/6371000)).put("lng",0).put("acc_m",20).put("provider","gps").put("at",at(time));}
    private static JSONObject report(String id,double meters,long time)throws Exception{return new JSONObject().put("device_id","lab").put("report_id",id).put("queued_at_ms",time).put("gps",gps(meters,time)).put("network","cellular");}
    private static void cleanup(java.nio.file.Path dir)throws Exception{try(java.util.stream.Stream<java.nio.file.Path> files=java.nio.file.Files.walk(dir)){for(java.nio.file.Path f:files.sorted(java.util.Comparator.reverseOrder()).toArray(java.nio.file.Path[]::new))java.nio.file.Files.delete(f);}}
    @Test public void accurateFreshGpsRequiredAndDatelineDistance()throws Exception{
        assertTrue(MovementReports.fresh(gps(0,NOW),NOW));assertFalse(MovementReports.fresh(gps(0,NOW-120001),NOW));
        // 卫星时间戳会比本机钟快几秒，实测 D22-JJ 有三到四成定位超前 1~4 秒。
        // 原先这里断言「超前 1 毫秒即不新鲜」，等于把线上那个静默失效钉成了预期行为。
        assertTrue(MovementReports.fresh(gps(0,NOW+4000),NOW));
        assertTrue(MovementReports.fresh(gps(0,NOW+MovementReports.CLOCK_LEAD_MS),NOW));
        assertFalse(MovementReports.fresh(gps(0,NOW+MovementReports.CLOCK_LEAD_MS+1),NOW));
        assertFalse(MovementReports.valid(gps(0,NOW).put("provider","network")));assertFalse(MovementReports.valid(gps(0,NOW).put("acc_m",201)));
        assertFalse(MovementReports.valid(gps(0,NOW).put("lat",91)));assertFalse(MovementReports.valid(gps(0,NOW).put("acc_m",JSONObject.NULL)));
        assertEquals(222.39,MovementReports.distance(gps(0,NOW).put("lng",179.999),gps(0,NOW).put("lng",-179.999)),.1);
    }
    @Test public void thresholdPendingRetryAndRestartBaseline()throws Exception{
        java.nio.file.Path dir=java.nio.file.Files.createTempDirectory("movement");try{
            java.io.File state=dir.resolve("state.json").toFile();MovementReports r=new MovementReports(state);StatusOutbox outbox=new StatusOutbox(dir.resolve("outbox").toFile(),16);
            r.acknowledged(report("baseline",0,NOW-10000));
            assertNull(r.prepare(outbox,report("below",1000,NOW),NOW));
            assertNull(r.prepare(outbox,report("margin",1039,NOW),NOW));
            JSONObject moved=report("moved",1050,NOW);assertEquals("moved",r.prepare(outbox,moved,NOW));assertEquals("movement",moved.getJSONObject("report_event").getString("type"));
            r=new MovementReports(state);assertEquals("moved",r.prepare(outbox,report("retry",3000,NOW+1000),NOW+1000));assertEquals(1,outbox.entries().length);
            r.acknowledged(moved);outbox.entries()[0].delete();r=new MovementReports(state);
            assertNull(r.prepare(outbox,report("still",1050,NOW+1000),NOW+1000));
            r.acknowledged(report("late",0,NOW-5000));assertNull(r.prepare(outbox,report("still-two",1050,NOW+2000),NOW+2000));
            // 这一步要验的是「再走远就产生新报告」。原来写的是 1 秒内位移 1950 米，
            // 那是每小时七千公里——速度合理性判据会正确地判它为坏点。给个现实的间隔。
            assertEquals("next",r.prepare(outbox,report("next",3000,NOW+300000),NOW+300000));
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

    // not_due 原先不带任何原因，现场排查时无法区分「没采到定位」和「距离不够」，
    // 只能靠推测。这几条钉住每种拒绝都给出可区分的理由。
    @Test public void declineReasonsAreDistinguishable()throws Exception{
        java.nio.file.Path dir=java.nio.file.Files.createTempDirectory("movement-reason");try{
            MovementReports r=new MovementReports(dir.resolve("state.json").toFile());
            StatusOutbox o=new StatusOutbox(dir.resolve("outbox").toFile(),16);
            r.acknowledged(report("baseline",0,NOW-10000));

            assertNull(r.prepare(o,report("wifi",2000,NOW).put("network","wifi"),NOW));
            assertEquals("not_cellular",r.decision());

            JSONObject noGps=report("nogps",0,NOW);noGps.remove("gps");
            assertNull(r.prepare(o,noGps,NOW));assertEquals("no_gps",r.decision());

            JSONObject stale=report("stale",2000,NOW-120001);
            assertNull(r.prepare(o,stale,NOW));assertEquals("gps_stale",r.decision());

            JSONObject ahead=report("ahead",2000,NOW+MovementReports.CLOCK_LEAD_MS+1000);
            assertNull(r.prepare(o,ahead,NOW));assertEquals("gps_ahead",r.decision());

            JSONObject netProvider=report("net",2000,NOW);
            netProvider.getJSONObject("gps").put("provider","network");
            assertNull(r.prepare(o,netProvider,NOW));assertEquals("gps_invalid",r.decision());

            assertNull(r.prepare(o,report("near",400,NOW),NOW));
            assertEquals("below_threshold",r.decision());
            assertEquals(400,r.decisionMeters(),5);

            assertEquals("far",r.prepare(o,report("far",2000,NOW),NOW));
            assertEquals(2000,r.decisionMeters(),5);
        }finally{cleanup(dir);}
    }

    // 这是线上真正失效的那条路径：移动检查每五分钟跑一次、GPS 也采到了，
    // 但定位时间戳比本机钟快几秒，旧的 fresh() 判它不新鲜，于是一次都不触发。
    @Test public void satelliteTimestampAheadOfDeviceClockStillTriggers()throws Exception{
        java.nio.file.Path dir=java.nio.file.Files.createTempDirectory("movement-lead");try{
            MovementReports r=new MovementReports(dir.resolve("state.json").toFile());
            StatusOutbox o=new StatusOutbox(dir.resolve("outbox").toFile(),16);
            r.acknowledged(report("baseline",0,NOW-600000));
            JSONObject moved=report("moved",2400,NOW+4000);
            assertEquals("moved",r.prepare(o,moved,NOW));
            assertEquals("movement",moved.getJSONObject("report_event").getString("type"));
        }finally{cleanup(dir);}
    }

    // 2026-09-22 所有者要求：阈值三公里降为一公里，并且「移动中加密检查、静止时放慢」，
    // 同时必须把真实移动与定位漂移分开——尤其是拿不到 GPS 时切到 WiFi/基站定位造成的跳变。
    @Test public void oneKilometreIsTheThresholdNow()throws Exception{
        java.nio.file.Path dir=java.nio.file.Files.createTempDirectory("movement-1km");try{
            MovementReports r=new MovementReports(dir.resolve("s.json").toFile());
            StatusOutbox o=new StatusOutbox(dir.resolve("outbox").toFile(),16);
            r.acknowledged(report("baseline",0,NOW-600000));
            // 扣掉两次精度半径（各 20 米）之后仍不足一公里
            assertNull(r.prepare(o,report("just-under",1039,NOW),NOW));
            assertEquals("below_threshold",r.decision());
            JSONObject moved=report("over",1050,NOW+1000);
            assertEquals("over",r.prepare(o,moved,NOW+1000));
            assertEquals("movement",moved.getJSONObject("report_event").getString("type"));
        }finally{cleanup(dir);}
    }

    // 网络定位（WiFi/基站）的 provider 不是 gps，本来就进不了位移计算。
    // 这条把它钉住：拿不到卫星时切到网络定位，哪怕坐标跳了几公里，也不得算成移动。
    @Test public void switchingToNetworkPositioningIsNotMovement()throws Exception{
        java.nio.file.Path dir=java.nio.file.Files.createTempDirectory("movement-drift");try{
            MovementReports r=new MovementReports(dir.resolve("s.json").toFile());
            StatusOutbox o=new StatusOutbox(dir.resolve("outbox").toFile(),16);
            r.acknowledged(report("baseline",0,NOW-600000));
            JSONObject drift=report("drift",5000,NOW);
            drift.getJSONObject("gps").put("provider","network");
            assertNull(r.prepare(o,drift,NOW));
            assertEquals("gps_invalid",r.decision());
            assertEquals("网络定位的跳变不得进入队列",0,o.entries().length);
            // 精度差到超过两百米的定位同样不算数——那种点本身就可能偏出一公里。
            JSONObject coarse=report("coarse",5000,NOW+1000);
            coarse.getJSONObject("gps").put("acc_m",201);
            assertNull(r.prepare(o,coarse,NOW+1000));
            assertEquals("gps_invalid",r.decision());
        }finally{cleanup(dir);}
    }

    // 阈值降到一公里后，单次多径坏点就足以跨过阈值。两次检查最短相隔一分钟，
    // 一分钟跑出五公里意味着 300 km/h，那不是车开过去了，是定位错了。
    @Test public void impossibleSpeedIsTreatedAsABadFixNotMovement()throws Exception{
        java.nio.file.Path dir=java.nio.file.Files.createTempDirectory("movement-jump");try{
            MovementReports r=new MovementReports(dir.resolve("s.json").toFile());
            StatusOutbox o=new StatusOutbox(dir.resolve("outbox").toFile(),16);
            r.acknowledged(report("baseline",0,NOW-600000));
            assertNull(r.prepare(o,report("start",100,NOW),NOW));
            JSONObject jump=report("jump",5100,NOW+60000);
            assertNull(r.prepare(o,jump,NOW+60000));
            assertEquals("implausible_jump",r.decision());
            assertEquals("坏点不得产生一条位移上报",0,o.entries().length);
            // 坏点不能成为下一次比较的基准，否则它会把真实位置也一起带偏。
            JSONObject real=report("real",1400,NOW+120000);
            assertEquals("real",r.prepare(o,real,NOW+120000));
        }finally{cleanup(dir);}
    }

    // 同样的距离、给足时间就是正常行驶，不该被速度判据误伤。
    @Test public void normalDrivingSpeedStillCounts()throws Exception{
        java.nio.file.Path dir=java.nio.file.Files.createTempDirectory("movement-drive");try{
            MovementReports r=new MovementReports(dir.resolve("s.json").toFile());
            StatusOutbox o=new StatusOutbox(dir.resolve("outbox").toFile(),16);
            r.acknowledged(report("baseline",0,NOW-600000));
            assertNull(r.prepare(o,report("start",100,NOW),NOW));
            // 五分钟走 5 公里 = 60 km/h
            JSONObject drive=report("drive",5100,NOW+300000);
            assertEquals("drive",r.prepare(o,drive,NOW+300000));
        }finally{cleanup(dir);}
    }

    @Test public void checkIntervalTightensWhileMovingAndRelaxesWhenStill()throws Exception{
        java.nio.file.Path dir=java.nio.file.Files.createTempDirectory("movement-cadence");try{
            MovementReports r=new MovementReports(dir.resolve("s.json").toFile());
            StatusOutbox o=new StatusOutbox(dir.resolve("outbox").toFile(),16);
            r.acknowledged(report("baseline",0,NOW-600000));
            assertEquals("重启后按静止起步",MovementReports.CHECK_MS,r.nextCheckMs());

            assertNull(r.prepare(o,report("a",100,NOW),NOW));
            assertNull(r.prepare(o,report("b",120,NOW+60000),NOW+60000));
            assertFalse("二十米的抖动不是移动",r.moving());
            assertEquals(MovementReports.CHECK_MS,r.nextCheckMs());

            assertNull(r.prepare(o,report("c",600,NOW+120000),NOW+120000));
            assertTrue("位移在长就是在动",r.moving());
            assertEquals(MovementReports.CHECK_MOVING_MS,r.nextCheckMs());

            assertNull(r.prepare(o,report("d",620,NOW+180000),NOW+180000));
            assertFalse("停下来就该退回慢节奏",r.moving());
            assertEquals(MovementReports.CHECK_MS,r.nextCheckMs());
        }finally{cleanup(dir);}
    }

    // 触发上报后基准点要等服务端确认才前移，这期间若退回五分钟，轨迹照样是断的。
    @Test public void staysTightRightAfterQueueingAReport()throws Exception{
        java.nio.file.Path dir=java.nio.file.Files.createTempDirectory("movement-after");try{
            MovementReports r=new MovementReports(dir.resolve("s.json").toFile());
            StatusOutbox o=new StatusOutbox(dir.resolve("outbox").toFile(),16);
            r.acknowledged(report("baseline",0,NOW-600000));
            assertEquals("moved",r.prepare(o,report("moved",1500,NOW),NOW));
            assertTrue(r.moving());
            assertEquals(MovementReports.CHECK_MOVING_MS,r.nextCheckMs());
        }finally{cleanup(dir);}
    }
}
