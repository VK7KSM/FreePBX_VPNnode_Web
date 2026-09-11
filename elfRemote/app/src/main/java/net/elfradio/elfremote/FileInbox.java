package net.elfradio.elfremote;

import android.app.*;
import android.content.*;
import org.json.*;
import java.util.*;

/** 文件收发状态在本机持久保存，通知与主页使用相同提示。 */
final class FileInbox {
    private static android.os.Handler notifications;
    private static Runnable pendingNotification;
    private static Runnable expiryNotification;
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
    static void progress(Context c,String id,String path,String direction,String state,String detail,long bytes,int percent,long expires){
        try{
            JSONObject entry=new JSONObject().put("id",id).put("path",path).put("direction",direction)
                    .put("state",state).put("detail",detail).put("percent",percent).put("expires_at",expires)
                    .put("bytes",bytes).put("at",System.currentTimeMillis());
            save(c,entry);
            queueNotification(c.getApplicationContext(),entry);
        }catch(Exception error){RuntimeLog.error("file_status_pending",error);}
    }
    private static synchronized void queueNotification(Context c,JSONObject entry){
        if(notifications==null)notifications=new android.os.Handler(android.os.Looper.getMainLooper());
        if(pendingNotification!=null)notifications.removeCallbacks(pendingNotification);
        pendingNotification=()->showNotification(c,entry);
        notifications.postDelayed(pendingNotification,500);
        if(expiryNotification!=null)notifications.removeCallbacks(expiryNotification);
        // 每次到期后重算，保证双向并发时较早完成的提示也准时消失。
        expiryNotification=()->{showNotification(c,entry);scheduleExpiry(c,entry);};
        scheduleExpiry(c,entry);
    }
    private static synchronized void scheduleExpiry(Context c,JSONObject entry){
        long now=System.currentTimeMillis(),next=Long.MAX_VALUE;
        JSONArray rows=read(c);
        for(int i=0;i<rows.length();i++){
            JSONObject row=rows.optJSONObject(i);if(row==null||!row.has("direction"))continue;
            long end=TaskReceipts.terminal(row.optString("state"))?row.optLong("at")+FileTransferStatus.RESULT_MS:row.optLong("expires_at");
            if(end>now)next=Math.min(next,end);
        }
        if(next!=Long.MAX_VALUE)notifications.postDelayed(expiryNotification,next-now+50);
    }
    static synchronized String notificationText(Context c){
        // 服务重建时内存计时器已丢失，仍须清除持久记录中尚未到期的完成提示。
        if(notifications==null)notifications=new android.os.Handler(android.os.Looper.getMainLooper());
        if(expiryNotification!=null)notifications.removeCallbacks(expiryNotification);
        expiryNotification=()->showNotification(c,null);
        scheduleExpiry(c,null);
        return FileTransferStatus.text(read(c),System.currentTimeMillis());
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
