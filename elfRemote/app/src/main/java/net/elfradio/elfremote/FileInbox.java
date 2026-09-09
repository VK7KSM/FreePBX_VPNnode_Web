package net.elfradio.elfremote;

import android.app.*;
import android.content.*;
import org.json.*;
import java.util.*;

/** 最近收件在本机持久保存；更新后仍可查看，不依赖再次连接管理网页。 */
final class FileInbox {
    private static android.os.Handler notifications;
    private static Runnable pendingNotification;
    static JSONArray merge(JSONArray entries,JSONObject entry)throws Exception{
        ArrayList<JSONObject> rows=new ArrayList<>();boolean newer=false;
        for(int i=0;i<entries.length();i++){
            JSONObject old=entries.getJSONObject(i);
            if(old.getString("id").equals(entry.getString("id"))){if(old.optLong("at")>entry.optLong("at")){rows.add(old);newer=true;}}
            else rows.add(old);
        }
        if(!newer)rows.add(entry);
        rows.sort((a,b)->Long.compare(b.optLong("at"),a.optLong("at")));
        JSONArray result=new JSONArray();for(int i=0;i<Math.min(20,rows.size());i++)result.put(rows.get(i));return result;
    }
    static synchronized JSONArray read(Context c){
        try{return new JSONArray(c.getSharedPreferences("file-inbox",0).getString("entries","[]"));}
        catch(Exception error){RuntimeLog.error("file_inbox_read_failed",error);return new JSONArray();}
    }
    static synchronized void save(Context c,JSONObject entry)throws Exception{
        if(!c.getSharedPreferences("file-inbox",0).edit().putString("entries",merge(read(c),entry).toString()).commit())throw new java.io.IOException("收件记录保存失败");
    }
    static void progress(Context c,String id,String path,String state,String detail,long bytes)throws Exception{
        JSONObject entry=new JSONObject().put("id",id).put("path",path).put("state",state).put("detail",detail)
                .put("bytes",bytes).put("at",System.currentTimeMillis());
        save(c,entry);
        queueNotification(c.getApplicationContext(),entry);
    }
    private static synchronized void queueNotification(Context c,JSONObject entry){
        if(notifications==null)notifications=new android.os.Handler(android.os.Looper.getMainLooper());
        if(pendingNotification!=null)notifications.removeCallbacks(pendingNotification);
        pendingNotification=()->showNotification(c,entry);
        notifications.postDelayed(pendingNotification,500);
    }
    private static void showNotification(Context c,JSONObject entry){
        try{
            // 部分D22固件丢弃普通通知；复用已经运行的前台服务通知，不额外建第二条。
            ServiceStarter.start(c,ReportService.ACTION_FILE_NOTIFICATION);
        }catch(Exception error){RuntimeLog.error("file_notification_failed",error);}
    }
    static JSONObject unread(JSONArray rows,long seen){
        JSONObject entry=rows.optJSONObject(0);
        return entry!=null&&(!TaskReceipts.terminal(entry.optString("state"))||entry.optLong("at")>seen)?entry:null;
    }
    static JSONObject unread(Context c){return unread(read(c),c.getSharedPreferences("file-inbox",0).getLong("seen",0));}
    static void seen(Context c){
        c.getSharedPreferences("file-inbox",0).edit().putLong("seen",System.currentTimeMillis()).apply();
        ServiceStarter.start(c,ReportService.ACTION_FILE_NOTIFICATION);
    }
    static void restore(Context context){
        try{JSONObject response=CoreClient.request("/files/recent",null);if(response==null)return;
            JSONArray rows=response.getJSONArray("files");for(int i=0;i<rows.length();i++)save(context,rows.getJSONObject(i));
        }catch(Exception error){RuntimeLog.error("file_inbox_restore_pending",error);}
    }
    private FileInbox(){}
}
