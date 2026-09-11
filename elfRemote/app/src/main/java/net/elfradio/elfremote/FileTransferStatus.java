package net.elfradio.elfremote;

import org.json.*;

/** 主页与通知共用的文件收发提示；旧收件历史不作为当前任务展示。 */
final class FileTransferStatus {
    static final long RESULT_MS=30000;
    static int percent(long done,long total){
        return total<=0?-1:(int)Math.min(100,Math.max(0,done)*100.0/total);
    }
    static String text(JSONArray rows,long now){
        StringBuilder out=new StringBuilder();
        for(String direction:new String[]{"receive","send"}){
            JSONObject latest=null;
            for(int i=0;i<rows.length();i++){
                JSONObject row=rows.optJSONObject(i);
                if(row==null||!direction.equals(row.optString("direction")))continue;
                if(latest==null||row.optLong("at")>latest.optLong("at"))latest=row;
            }
            if(latest==null)continue;
            boolean terminal=TaskReceipts.terminal(latest.optString("state"));
            long at=latest.optLong("at"),expires=latest.optLong("expires_at",at+3600000);
            if(at<=0||now<at||now>=(terminal?at+RESULT_MS:expires))continue;
            if(out.length()>0)out.append('\n');
            out.append(label(latest));
            String name=latest.optString("path");name=name.substring(name.lastIndexOf('/')+1);
            if(!name.isEmpty())out.append(" · ").append(name.replace('\n',' ').replace('\r',' '));
        }
        return out.toString();
    }
    private static String label(JSONObject row){
        String verb="send".equals(row.optString("direction"))?"发送":"接收";
        String state=row.optString("state"),detail=row.optString("detail");
        if("success".equals(state))return verb+"完成";
        if(TaskReceipts.terminal(state))return verb+(detail.contains("停止")||"cancelled".equals(state)?"已停止":"失败");
        if(detail.contains("暂停"))return verb+"已暂停，等待联网";
        if(detail.contains("中断"))return verb+"中断，等待重试";
        if(detail.contains("校验")||detail.contains("保存"))return "正在校验并保存";
        if("claimed".equals(state)||detail.contains("快照"))return "正在准备"+verb;
        int percent=row.optInt("percent",-1);
        return "正在"+verb+(percent>=0?" "+Math.min(100,percent)+"%":"");
    }
    private FileTransferStatus(){}
}
