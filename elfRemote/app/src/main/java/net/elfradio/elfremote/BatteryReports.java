package net.elfradio.elfremote;

import org.json.*;
import java.io.File;

/** 先保存阈值事件，再写入既有报告队列，最后发送；重启不重复触发。 */
final class BatteryReports {
    private static final int[] THRESHOLDS={10,5,2};
    private final File file;
    private JSONObject state;
    BatteryReports(File file)throws Exception{
        this.file=file;
        state=file.isFile()?new JSONObject(RescueFiles.read(file,4096)):new JSONObject();
    }
    static JSONObject observe(JSONObject previous,int level,boolean charging,long now,String id)throws Exception{
        JSONObject next=new JSONObject(previous.toString());
        if(level<0||level>100)return next;
        int fired=next.optInt("fired"),crossed=0;
        for(int i=0;i<THRESHOLDS.length;i++){
            int bit=1<<i;
            if(charging&&level>THRESHOLDS[i])fired&=~bit;
            if(level<THRESHOLDS[i]&&(fired&bit)==0){fired|=bit;crossed|=bit;}
        }
        next.put("fired",fired);
        if(crossed!=0){
            JSONObject pending=next.optJSONObject("pending");
            if(pending==null)pending=new JSONObject().put("id",id).put("at",now).put("mask",0);
            pending.put("mask",pending.optInt("mask")|crossed).put("level",level);
            next.put("pending",pending);
        }
        return next;
    }
    synchronized boolean observe(int level,boolean charging)throws Exception{
        JSONObject next=observe(state,level,charging,System.currentTimeMillis(),java.util.UUID.randomUUID().toString());
        if(!next.toString().equals(state.toString())){RescueFiles.write(file,next.toString());state=next;}
        return state.has("pending");
    }
    synchronized JSONObject pending()throws Exception{
        JSONObject p=state.optJSONObject("pending");return p==null?null:new JSONObject(p.toString());
    }
    synchronized void queued(String id)throws Exception{
        JSONObject p=state.optJSONObject("pending");if(p==null||!id.equals(p.optString("id")))return;
        JSONObject next=new JSONObject(state.toString());next.remove("pending");
        RescueFiles.write(file,next.toString());state=next;
    }
    static JSONObject event(JSONObject pending)throws Exception{
        JSONArray thresholds=new JSONArray();for(int i=0;i<THRESHOLDS.length;i++)if((pending.getInt("mask")&(1<<i))!=0)thresholds.put(THRESHOLDS[i]);
        return new JSONObject().put("type","low_battery").put("thresholds",thresholds).put("level",pending.getInt("level"))
                .put("at",pending.getLong("at"));
    }
}
