package net.elfradio.elfremote;

import org.json.*;
import java.io.File;

/** 以服务器已确认的GPS报告为基点；未确认报告复用原队列，不制造重复移动事件。 */
final class MovementReports {
    static final long CHECK_MS=300000L;
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
    static boolean fresh(JSONObject gps,long now){return valid(gps)&&now>=time(gps)&&now-time(gps)<=120000L;}
    static double distance(JSONObject a,JSONObject b)throws Exception{
        double p1=Math.toRadians(a.getDouble("lat")),p2=Math.toRadians(b.getDouble("lat"));
        double x=Math.sin((p2-p1)/2),y=Math.sin(Math.toRadians(b.getDouble("lng")-a.getDouble("lng"))/2);
        double h=x*x+Math.cos(p1)*Math.cos(p2)*y*y;return 6371000*2*Math.asin(Math.sqrt(Math.min(1,Math.max(0,h))));
    }
    String prepare(StatusOutbox outbox,JSONObject body,long now)throws Exception{
        if(!"cellular".equals(body.optString("network")))return null;
        JSONObject gps=body.optJSONObject("gps");if(!fresh(gps,now))return null;
        for(File queued:outbox.entries()){
            JSONObject old=outbox.read(queued);
            if(body.optString("device_id").equals(old.optString("device_id"))&&valid(old.optJSONObject("gps")))return old.getString("report_id");
        }
        JSONObject previous=body.optString("device_id").equals(baseline.optString("device_id"))?baseline.optJSONObject("gps"):null;
        if(valid(previous)){
            double meters=distance(previous,gps);
            // 扣除两次精度半径，避免边界附近的定位漂移反复触发。
            if(meters-previous.getDouble("acc_m")-gps.getDouble("acc_m")<=3000)return null;
            body.put("report_event",new JSONObject().put("type","movement").put("distance_m",Math.round(meters)).put("at",time(gps)));
        }
        outbox.add(body);return body.getString("report_id");
    }
    void acknowledged(JSONObject body)throws Exception{
        JSONObject gps=body.optJSONObject("gps");if(!valid(gps))return;
        if(body.optString("device_id").equals(baseline.optString("device_id"))&&time(gps)<=time(baseline.optJSONObject("gps")))return;
        JSONObject next=new JSONObject().put("device_id",body.getString("device_id")).put("gps",gps);
        RescueFiles.write(file,next.toString());baseline=next;
    }
}
