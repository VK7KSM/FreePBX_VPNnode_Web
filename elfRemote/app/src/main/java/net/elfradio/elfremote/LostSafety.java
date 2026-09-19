package net.elfradio.elfremote;

import org.json.JSONObject;
import java.io.File;

/** 核心直接处理取消操作，不排在应用文件、网络配置或日志任务后面。 */
final class LostSafety {
    interface Execute {JSONObject run(JSONObject params)throws Exception;}
    interface Progress {void send(String id,String state,String detail,JSONObject result)throws Exception;}
    static boolean accepts(JSONObject offer){
        JSONObject p=offer==null?null:offer.optJSONObject("params");
        return offer!=null&&"set_lost_mode".equals(offer.optString("type"))&&p!=null&&p.optInt("version")==2
                &&(Boolean.FALSE.equals(p.opt("enabled"))||Boolean.TRUE.equals(p.opt("cancel_auto")));
    }
    static synchronized void run(JSONObject offer,TaskReceipts receipts,Execute execute,Progress progress,long now)throws Exception {
        if(!accepts(offer))throw new IllegalArgumentException("lost-invalid-safety-task");
        String id=offer.optString("id");
        if(!id.matches("[A-Za-z0-9-]{1,64}"))throw new IllegalArgumentException("lost-invalid-task");
        JSONObject saved=receipts.read(id);
        if(saved!=null&&saved.optBoolean("acknowledged"))return;
        if(saved==null){
            String reason=RepairPolicy.rejectReason(offer,now);
            if(offer.optLong("expires_at")<=0)reason="expired";
            if(!reason.isEmpty())saved=new JSONObject().put("task_id",id).put("state","rejected").put("detail",reason);
            else {
                // 先在设备取消，再发送回执；网络失败不能阻止取消。
                JSONObject outcome=execute.run(new JSONObject(offer.getJSONObject("params").toString()).put("task_id",id).put("action","set"));
                saved=new JSONObject().put("task_id",id).put("state","success").put("detail",offer.getJSONObject("params").optBoolean("cancel_auto")?"自毁程序已关闭":"lost-disabled")
                        .put("result",new JSONObject().put("lost_mode",outcome));
            }
            receipts.save(saved);
        }
        if("success".equals(saved.getString("state"))){progress.send(id,"claimed","设备已接收安全退出",null);progress.send(id,"running","正在核验退出结果",null);}
        progress.send(id,saved.getString("state"),saved.optString("detail"),saved.optJSONObject("result"));
        receipts.acknowledge(id);
    }
    private LostSafety(){}
}
