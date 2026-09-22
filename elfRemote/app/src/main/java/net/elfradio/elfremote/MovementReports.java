package net.elfradio.elfremote;

import org.json.*;
import java.io.File;

/** 以服务器已确认的GPS报告为基点；未确认报告复用原队列，不制造重复移动事件。 */
final class MovementReports {
    // 静止时五分钟查一次；判定为正在移动时降到一分钟，停下来再退回去。
    // 只在真正移动的那段时间加密，耗电与流量的代价才花在有用的地方。
    static final long CHECK_MS=300000L;
    static final long CHECK_MOVING_MS=60000L;
    // 2026-09-22 由三公里下调为一公里：三公里配五分钟的检查间隔，地图上两点之间
    // 常常隔着七八公里的路，轨迹跟不上道路。
    static final double THRESHOLD_M=1000;
    // 两次检查之间位移变化超过这个数才算「在动」。取 150 米是因为定位精度上限是 200 米，
    // 静止时的抖动通常远小于此；取太小会把漂移当成移动，白白把检查间隔压到一分钟。
    static final double MOVING_STEP_M=150;
    // 两次检查间隔是 60~300 秒。若这段时间的位移意味着超过 200 km/h，
    // 那几乎一定是一次多径坏点，不是车真的开过去了。
    static final double MAX_SPEED_MPS=55.6;
    private final File file;
    private JSONObject baseline;
    MovementReports(File file)throws Exception{this.file=file;baseline=file.isFile()?new JSONObject(RescueFiles.read(file,4096)):new JSONObject();}
    static long time(JSONObject gps){
        try{java.text.SimpleDateFormat f=new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",java.util.Locale.US);f.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));f.setLenient(false);return f.parse(gps.getString("at")).getTime();}catch(Exception e){return 0;}
    }
    static boolean valid(JSONObject gps){
        if(gps==null||!"gps".equals(gps.optString("provider")))return false;
        double lat=gps.optDouble("lat"),lng=gps.optDouble("lng"),acc=gps.optDouble("acc_m");
        return Double.isFinite(lat)&&Math.abs(lat)<=90&&Double.isFinite(lng)&&Math.abs(lng)<=180&&Double.isFinite(acc)&&acc>=0&&acc<=200&&time(gps)>0;
    }
    // GPS 定位自带的时间戳来自卫星，不是设备墙钟，实测这台机有三到四成的定位「超前」本机时钟 1~4 秒
    // （2026-09-21 从 D22-JJ 的上报里统计：187 次 GPS 定位中 72 次超前，多为 +3/+4 秒）。
    // 原先写的是 now>=time(gps)，对超前零容忍，于是这部分定位一律判为不新鲜，
    // 移动检查每五分钟做一次、GPS 也采到了，却静默地什么都不做——表现就是「位移上报规则从没生效」。
    // 允许有界超前：仍拒绝明显离谱的未来时间，但不再因为几秒钟的钟差丢掉一次合法定位。
    static final long CLOCK_LEAD_MS=60000L;
    static boolean fresh(JSONObject gps,long now){
        if(!valid(gps))return false;
        long at=time(gps);
        return at-now<=CLOCK_LEAD_MS&&now-at<=120000L;
    }
    static double distance(JSONObject a,JSONObject b)throws Exception{
        double p1=Math.toRadians(a.getDouble("lat")),p2=Math.toRadians(b.getDouble("lat"));
        double x=Math.sin((p2-p1)/2),y=Math.sin(Math.toRadians(b.getDouble("lng")-a.getDouble("lng"))/2);
        double h=x*x+Math.cos(p1)*Math.cos(p2)*y*y;return 6371000*2*Math.asin(Math.sqrt(Math.min(1,Math.max(0,h))));
    }
    // 这几项只活在内存里：重启后按静止起步（五分钟），是安全的一侧。
    private double lastMeters=-1;
    private JSONObject lastGps;
    private boolean moving;
    /** 下一次检查该隔多久。 */
    long nextCheckMs(){return moving?CHECK_MOVING_MS:CHECK_MS;}
    boolean moving(){return moving;}

    /** 上一次 prepare 未触发的原因与实测位移，仅供日志；不记录坐标本身。 */
    private String decision="";
    private long decisionMeters=-1;
    String decision(){return decision;}
    long decisionMeters(){return decisionMeters;}

    String prepare(StatusOutbox outbox,JSONObject body,long now)throws Exception{
        decision="";decisionMeters=-1;
        if(!"cellular".equals(body.optString("network"))){decision="not_cellular";return null;}
        JSONObject gps=body.optJSONObject("gps");
        if(!fresh(gps,now)){
            // 把「没有定位」「定位太旧」「定位超前太多」「精度或来源不合格」分开，
            // 否则下一次现场复现仍然只能看到一句 not_due。
            decision=gps==null?"no_gps":!valid(gps)?"gps_invalid":time(gps)-now>CLOCK_LEAD_MS?"gps_ahead":"gps_stale";
            return null;
        }
        JSONObject previous=body.optString("device_id").equals(baseline.optString("device_id"))?baseline.optJSONObject("gps"):null;
        for(File queued:outbox.entries()){
            JSONObject old=outbox.read(queued);
            JSONObject event=old.optJSONObject("report_event");
            if(body.optString("device_id").equals(old.optString("device_id"))&&valid(old.optJSONObject("gps"))
                    &&(!valid(previous)||(event!=null&&"movement".equals(event.optString("type")))))return old.getString("report_id");
        }
        // 第三道：与上一次检查的定位比，算出的速度若不可能，就当这次定位是坏的。
        // 前两道分别是「来源必须是 gps」（网络定位天然排除，切到 WiFi/基站不会被当成移动）
        // 与「扣除两次精度半径」。阈值降到一公里后，单次多径坏点就足以跳过阈值，故补这一道。
        if(valid(lastGps)){
            double seconds=(time(gps)-time(lastGps))/1000.0;
            if(seconds>0){
                double jump=distance(lastGps,gps);
                if(jump/seconds>MAX_SPEED_MPS){
                    decision="implausible_jump";decisionMeters=Math.round(jump);
                    // 不更新 lastGps：坏点不该成为下一次比较的基准，否则它会把真实位置也带偏。
                    return null;
                }
            }
        }
        lastGps=gps;
        if(valid(previous)){
            double meters=distance(previous,gps);
            decisionMeters=Math.round(meters);
            // 位移在长就是在动。拿本次与上次检查算出的位移相比，而不是拿速度或加速度——
            // 这个量本来就要算，不必为了判断「是否在移动」再采一次 GPS。
            if(lastMeters>=0)moving=Math.abs(meters-lastMeters)>MOVING_STEP_M;
            lastMeters=meters;
            // 扣除两次精度半径，避免边界附近的定位漂移反复触发。
            if(meters-previous.getDouble("acc_m")-gps.getDouble("acc_m")<=THRESHOLD_M){decision="below_threshold";return null;}
            body.put("report_event",new JSONObject().put("type","movement").put("distance_m",Math.round(meters)).put("at",time(gps)));
        }
        // 刚触发一次位移上报，说明确实在移动；基准点要等服务端确认后才前移，
        // 这期间也应保持加密检查，否则每报一次就退回五分钟、轨迹照样是断的。
        moving=true;lastMeters=0;
        outbox.add(body);return body.getString("report_id");
    }
    void acknowledged(JSONObject body)throws Exception{
        JSONObject gps=body.optJSONObject("gps");if(!valid(gps))return;
        if(body.optString("device_id").equals(baseline.optString("device_id"))&&time(gps)<=time(baseline.optJSONObject("gps")))return;
        JSONObject next=new JSONObject().put("device_id",body.getString("device_id")).put("gps",gps);
        RescueFiles.write(file,next.toString());baseline=next;
    }
}
