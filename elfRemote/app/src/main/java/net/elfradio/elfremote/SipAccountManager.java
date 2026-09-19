package net.elfradio.elfremote;

import android.system.Os;
import android.system.StructStat;
import org.json.JSONObject;
import java.io.File;
import java.io.IOException;

/** D22原有Linphone账号配置；密码只在受保护文件和内存中处理。 */
final class SipAccountManager {
    private static final String PACKAGE="org.linphone.debug";
    private static final String START="am start --user 0 -n org.linphone.debug/org.linphone.activities.main.MainActivity >/dev/null";
    private static final String STOP="am force-stop --user 0 org.linphone.debug";
    private static final File CONFIG=new File("/data/user/0/org.linphone.debug/files/.linphonerc");
    private static String run(File root,String name,String command)throws Exception {
        File dir=new File(root,name);if(!dir.mkdir())throw new IOException("账号任务步骤目录已存在");
        JSONObject r=RescueDaemon.execute(dir,command,10);
        if(!"completed".equals(r.optString("state"))||r.optInt("exit_code",-1)!=0)throw new IOException("账号操作未完成："+name);
        return r.optString("output").trim();
    }
    private static String diagnostics(File folder,String name)throws Exception {
        return run(folder,name,"logcat -d -v threadtime -t 2000 | grep -F 'callState=[' | tail -n 1");
    }
    static JSONObject apply(File folder,JSONObject params)throws Exception {
        JSONObject p=SipAccountConfig.normalize(params);long started=System.nanoTime();
        File marker=new File(folder,"sip-restore.json"),backup=new File(folder,"linphone-before.ini");
        String message="",rollback="";boolean registered=false;
        try {
            if(!CONFIG.isFile()) {
                run(folder,"initialize",START);Thread.sleep(1000);
                if(!CONFIG.isFile())throw new IOException("Linphone尚未生成配置文件");
            }
            String pid=run(folder,"old-pid","pidof "+PACKAGE+" || true");
            if(!pid.matches("[0-9]+")){run(folder,"start-existing",START);Thread.sleep(1000);pid=run(folder,"started-pid","pidof "+PACKAGE);}
            String before=diagnostics(folder,"diagnostics-before");
            run(folder,"diagnostics-request","am broadcast --user 0 -a org.linphone.D22_AUDIO_DIAGNOSTICS_ACTION -n org.linphone.debug/org.linphone.notifications.D22CallControlReceiver >/dev/null");
            Thread.sleep(600);String after=diagnostics(folder,"diagnostics-after");
            if(before.equals(after)||!lineFromPid(after,pid)||!after.contains("callState=[null]"))throw new IOException("无法确认Linphone空闲，账号未修改");
            if(new File(folder,"cancel").exists())throw new IOException("账号配置已取消");
            StructStat stat=Os.stat(CONFIG.getPath());
            if(CONFIG.length()>1024*1024)throw new IOException("Linphone配置文件异常过大");
            // 恢复依据先落盘再停应用；应用退出后的最后配置用于字段合并。
            RescueFiles.write(backup,RescueFiles.read(CONFIG,1024*1024));Os.chmod(backup.getPath(),0600);
            JSONObject journal=new JSONObject().put("uid",stat.st_uid).put("gid",stat.st_gid).put("mode",stat.st_mode&0777)
                    .put("sha256",RescueFiles.sha256(backup));
            RescueFiles.write(marker,journal.toString());
            run(folder,"stop",STOP);
            replace(SipAccountConfig.apply(RescueFiles.read(CONFIG,1024*1024),p),journal);
            run(folder,"label","restorecon "+RescueFiles.quote(CONFIG.getPath()));
            run(folder,"launch",START);Thread.sleep(500);
            String newPid=run(folder,"new-pid","pidof "+PACKAGE);
            if(!newPid.matches("[0-9]+")||newPid.equals(pid))throw new IOException("Linphone新进程未启动");
            String identity="[sip:"+p.getString("username")+"@"+p.getString("server")+"]";
            for(int i=0;i<24;i++) {
                if(new File(folder,"cancel").exists())throw new IOException("账号配置已取消");
                String logs=run(folder,"registration-"+i,"logcat -d -v threadtime -t 2000 | grep -F '[Context] Account [' || true");
                String latest="";for(String line:logs.split("\n"))if(lineFromPid(line,newPid)&&line.contains(identity))latest=line;
                if(latest.contains("registration state changed [Ok]")){registered=true;break;}
                if(latest.contains("registration state changed [Failed]"))throw new IOException("SIP注册失败，请检查账号、服务器及TLS设置");
                Thread.sleep(1500);
            }
            if(!registered)throw new IOException("未在等待时间内确认SIP注册成功");
            if(!marker.delete())throw new IOException("账号完成记录保存失败");
            message="Linphone已注册，传输方式 "+p.getString("transport").toUpperCase(java.util.Locale.US);
        }catch(Exception failure) {
            registered=false;message=failure instanceof IOException?failure.getMessage():"账号配置失败";
            if(marker.isFile())try{restore(folder);rollback="，已恢复原配置";}catch(Exception failed){rollback="，原配置恢复未完成，请检查维护日志";}
            else if(new File(folder,"stop").isDirectory())try{run(folder,"restart-unchanged",START);}catch(Exception ignored){}
        }
        return new JSONObject().put("state",registered?"completed":"failed").put("exit_code",registered?0:1)
                .put("registered",registered).put("output",message+rollback).put("elapsed_ms",(System.nanoTime()-started)/1000000);
    }
    static boolean lineFromPid(String line,String pid){String[] fields=line.trim().split("\\s+",5);return fields.length>=5&&fields[2].equals(pid);}
    private static void replace(String contents,JSONObject journal)throws Exception {
        File stage=new File(CONFIG.getPath()+".elfremote-new");
        RescueFiles.write(stage,contents);Os.chown(stage.getPath(),journal.getInt("uid"),journal.getInt("gid"));Os.chmod(stage.getPath(),journal.getInt("mode"));
        Os.rename(stage.getPath(),CONFIG.getPath());
    }
    private static void restore(File folder)throws Exception {
        File marker=new File(folder,"sip-restore.json"),backup=new File(folder,"linphone-before.ini");
        JSONObject journal=new JSONObject(RescueFiles.read(marker,2048));
        if(!RescueFiles.sha256(backup).equals(journal.getString("sha256")))throw new IOException("原配置备份校验失败");
        String tag="rollback-"+System.currentTimeMillis();
        run(folder,tag+"-stop",STOP);replace(RescueFiles.read(backup,1024*1024),journal);
        run(folder,tag+"-label","restorecon "+RescueFiles.quote(CONFIG.getPath()));run(folder,tag+"-start",START);
        if(!marker.delete())throw new IOException("恢复记录未保存");
    }
    static JSONObject recover(File folder)throws Exception {
        if(!new File(folder,"sip-restore.json").isFile())return null;
        restore(folder);
        return new JSONObject().put("state","interrupted").put("exit_code",1).put("registered",false)
                .put("output","维护核心重启，已恢复Linphone原配置；账号任务未重放");
    }
    private SipAccountManager(){}
}
