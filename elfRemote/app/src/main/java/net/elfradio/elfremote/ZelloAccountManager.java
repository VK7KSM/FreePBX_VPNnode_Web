package net.elfradio.elfremote;

import org.json.JSONObject;
import java.io.File;
import java.io.IOException;

/** 使用官方登录页面，不改写Zello私有账号格式、不复制其他设备的会话。 */
final class ZelloAccountManager {
    private static final String START="am start --user 0 -n com.loudtalks/com.zello.ui.MainActivity >/dev/null";
    private static final File LOGIN_LOG=new File("/data/user/0/com.loudtalks/files/logs/diag_LOGIN_log1");
    private static String run(File root,String label,String command)throws Exception {
        File step=new File(root,label);if(!step.mkdir())throw new IOException("账号步骤记录已存在");
        JSONObject result=RescueDaemon.execute(step,command,10);
        if(result.optInt("exit_code",-1)!=0||!"completed".equals(result.optString("state")))throw new IOException("Zello操作未完成："+label);
        return result.optString("output");
    }
    private static String log()throws Exception {return LOGIN_LOG.isFile()?RescueFiles.read(LOGIN_LOG,1024*1024):"";}
    static JSONObject apply(File folder,JSONObject params)throws Exception {
        JSONObject p=ZelloAccountConfig.normalize(params);long began=System.currentTimeMillis();
        File marker=new File(folder,"zello-ui-restore.json");boolean ok=false;String output="";
        try {
            String info=run(folder,"package","dumpsys package com.loudtalks");
            if(!info.contains("versionName=7.11.1\n")&&!info.contains("versionName=7.11.1\r"))throw new IOException("当前仅适配官方Zello 7.11.1");
            String power=run(folder,"screen","dumpsys power");
            if(!power.contains("mWakefulness=Asleep")&&!power.contains("mWakefulness=Awake"))throw new IOException("无法确认原屏幕状态");
            boolean asleep=power.contains("mWakefulness=Asleep"),mic=!info.contains("android.permission.RECORD_AUDIO: granted=true");
            RescueFiles.write(marker,new JSONObject().put("asleep",asleep).put("granted_microphone",mic).toString());
            if(mic)run(folder,"microphone","pm grant --user 0 com.loudtalks android.permission.RECORD_AUDIO");
            if(asleep)run(folder,"wake","input keyevent 224");
            run(folder,"open","am start --user 0 -n com.loudtalks/com.zello.ui.SigninActivity --es context add_account >/dev/null");
            Thread.sleep(1200);
            try(AccountUi ui=new AccountUi()){
                if(!ui.fill("login_username",p.getString("username"),false)||!ui.fill("login_password",p.getString("password"),true))throw new IOException("官方Zello账号表单不可用");
                String before=log();
                if(!ui.click("login_signin"))throw new IOException("未找到Zello登录按钮");
                boolean authenticated=false;
                for(int i=0;i<45;i++){
                    if(new File(folder,"cancel").exists())throw new IOException("Zello账号配置已取消");
                    String after=log();
                    // 日志轮转时拒绝将旧日志当新认证；本轮可以明确失败后重试。
                    if(!after.startsWith(before))throw new IOException("Zello登录日志已轮转，尚不能确认本次登录结果");
                    String fresh=after.substring(before.length());
                    if(fresh.contains("(LOGIN) Error:"))throw new IOException("Zello登录失败，请检查账号、密码及网络");
                    authenticated=authenticated||ZelloAccountConfig.authenticated(fresh);
                    try{if(authenticated&&ui.accountVisible(p.getString("username"))){ok=true;break;}}catch(IOException pending){}
                    ui.advanceOnboarding();Thread.sleep(1000);
                }
                if(!ok)throw new IOException(authenticated?"Zello已通过认证，但未完成首次引导，请查看设备日志":"尚未确认本次Zello登录成功，请检查账号和网络");
            }
            output="Zello已登录";
        }catch(Exception error){output=error instanceof IOException?error.getMessage():"Zello账号配置失败，请查看维护日志";}
        finally {
            if(marker.isFile())try{restoreUi(folder,ok);}catch(Exception error){ok=false;output+="；原界面状态恢复未完成";}
        }
        return new JSONObject().put("state",ok?"completed":"failed").put("exit_code",ok?0:1).put("logged_in",ok)
                .put("output",output).put("elapsed_ms",System.currentTimeMillis()-began);
    }
    private static void restoreUi(File folder,boolean success)throws Exception {
        File marker=new File(folder,"zello-ui-restore.json");JSONObject state=new JSONObject(RescueFiles.read(marker,2048));String tag="restore-"+System.nanoTime();
        // 退出登录表单，不注销或删除已有账号；只有成功配置才保留新增麦克风授权。
        if(!success){
            try(AccountUi ui=new AccountUi()){try{ui.fill("login_password","",true);}catch(Exception ignored){}}
            run(folder,tag+"-main",START+"\ninput keyevent 4\n"+START);
            if(state.optBoolean("granted_microphone"))run(folder,tag+"-permission","pm revoke --user 0 com.loudtalks android.permission.RECORD_AUDIO");
        }
        if(state.optBoolean("asleep"))run(folder,tag+"-sleep","input keyevent 223");
        if(!marker.delete())throw new IOException("账号界面恢复记录未保存");
    }
    static JSONObject recover(File folder)throws Exception {
        if(!new File(folder,"zello-ui-restore.json").isFile())return null;
        restoreUi(folder,false);
        return new JSONObject().put("state","interrupted").put("exit_code",1).put("logged_in",false).put("output","维护核心重启，已退出账号配置，不自动重放登录");
    }
    private ZelloAccountManager(){}
}
