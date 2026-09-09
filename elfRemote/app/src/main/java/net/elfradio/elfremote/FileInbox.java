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
            String path=entry.getString("path"),detail=entry.getString("detail"),state=entry.getString("state");
            NotificationManager manager=(NotificationManager)c.getSystemService(Context.NOTIFICATION_SERVICE);
            if(android.os.Build.VERSION.SDK_INT>=26)manager.createNotificationChannel(new NotificationChannel("file-receive","文件接收",NotificationManager.IMPORTANCE_LOW));
            Intent intent=new Intent(c,MainActivity.class).putExtra("show_files",true).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent tap=PendingIntent.getActivity(c,4,intent,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
            boolean done=TaskReceipts.terminal(state);
            Notification.Builder b=android.os.Build.VERSION.SDK_INT>=26?new Notification.Builder(c,"file-receive"):new Notification.Builder(c);
            manager.notify(104,b.setSmallIcon(done?android.R.drawable.stat_sys_download_done:android.R.drawable.stat_sys_download)
                    .setContentTitle(new java.io.File(path).getName()).setContentText(detail).setContentIntent(tap)
                    .setOnlyAlertOnce(true).setVisibility(Notification.VISIBILITY_PRIVATE).setOngoing(!done).setAutoCancel(done).build());
            notifications.postDelayed(()->{
                try{
                    boolean visible=false;
                    for(android.service.notification.StatusBarNotification n:manager.getActiveNotifications())if(n.getId()==104)visible=true;
                    RuntimeLog.event("file_notification_result visible="+visible+" enabled="+manager.areNotificationsEnabled()+" state="+state);
                }catch(Exception error){RuntimeLog.error("file_notification_check_failed",error);}
            },1000);
        }catch(Exception error){RuntimeLog.error("file_notification_failed",error);}
    }
    static void restore(Context context){
        try{JSONObject response=CoreClient.request("/files/recent",null);if(response==null)return;
            JSONArray rows=response.getJSONArray("files");for(int i=0;i<rows.length();i++)save(context,rows.getJSONObject(i));
        }catch(Exception error){RuntimeLog.error("file_inbox_restore_pending",error);}
    }
    private FileInbox(){}
}
