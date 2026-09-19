package net.elfradio.elfremote;

import android.content.Context;
import android.os.PowerManager;
import java.lang.reflect.*;
import org.json.JSONObject;

/** 使用系统凭据接口；不删除锁屏数据库，不绕过未知的原密码。 */
final class SystemLock implements LostRecovery.Control {
    private final Context context;
    private final Object lock;
    private final Class<?> cls;
    private String knownPassword="";
    SystemLock(Context context)throws Exception {
        if(android.os.Looper.myLooper()==null)android.os.Looper.prepare();
        this.context=context;cls=Class.forName("com.android.internal.widget.LockPatternUtils");lock=cls.getConstructor(Context.class).newInstance(context);
    }
    boolean disabled()throws Exception{String value=credentialCommand("get-disabled",knownPassword,null);if(!value.equals("true")&&!value.equals("false"))throw new IllegalStateException("lost-lock-state-unavailable");return value.equals("true");}
    public void disabled(boolean value)throws Exception{credentialCommand("set-disabled",knownPassword,Boolean.toString(value));if(disabled()!=value)throw new IllegalStateException("lost-lock-state-failed");}
    public boolean secure()throws Exception{return (Boolean)cls.getMethod("isSecure",int.class).invoke(lock,0);}
    JSONObject owner()throws Exception {
        Object text=cls.getMethod("getOwnerInfo",int.class).invoke(lock,0);
        return new JSONObject().put("message",text==null?"":text.toString()).put("enabled",cls.getMethod("isOwnerInfoEnabled",int.class).invoke(lock,0));
    }
    public void owner(JSONObject value)throws Exception {
        cls.getMethod("setOwnerInfo",String.class,int.class).invoke(lock,value.optString("message"),0);
        cls.getMethod("setOwnerInfoEnabled",boolean.class,int.class).invoke(lock,value.optBoolean("enabled"),0);
        JSONObject actual=owner();if(!actual.optString("message").equals(value.optString("message"))||actual.optBoolean("enabled")!=value.optBoolean("enabled"))throw new IllegalStateException("lost-owner-restore-pending");
    }
    public boolean verify(String password)throws Exception {
        boolean valid=credentialCommand("verify",password,null).contains("Lock credential verified successfully");
        if(valid)knownPassword=password;return valid;
    }
    public void password(String value,String old)throws Exception {
        credentialCommand(value.isEmpty()?"clear":"set-password",old,value.isEmpty()?null:value);
        if(secure()==value.isEmpty())throw new IllegalStateException("lost-system-password-failed");
        knownPassword=value;
    }
    void lock()throws Exception {
        disabled(false);
        cls.getMethod("requireStrongAuth",int.class,int.class).invoke(lock,1,0);
        Object binder=Class.forName("android.os.ServiceManager").getMethod("getService",String.class).invoke(null,"window");
        Class<?> stub=Class.forName("android.view.IWindowManager$Stub");Object wm=stub.getMethod("asInterface",android.os.IBinder.class).invoke(null,binder);
        Class.forName("android.view.IWindowManager").getMethod("lockNow",android.os.Bundle.class).invoke(wm,new Object[]{null});
        for(int n=0;n<20&&!locked();n++)Thread.sleep(100);
    }
    public void dismiss()throws Exception {
        // D22熄屏时仅调用wm不能退出锁屏；先唤醒并发送系统菜单键。
        for(String key:new String[]{"223","224","82"}){
            Process input=new ProcessBuilder("/system/bin/input","keyevent",key).redirectErrorStream(true).start();
            if(!input.waitFor(5,java.util.concurrent.TimeUnit.SECONDS)){input.destroy();throw new IllegalStateException("lost-dismiss-timeout");}
            if(key.equals("223"))Thread.sleep(1000);
        }
        Process p=new ProcessBuilder("/system/bin/wm","dismiss-keyguard").redirectErrorStream(true).start();
        if(!p.waitFor(5,java.util.concurrent.TimeUnit.SECONDS)){p.destroy();throw new IllegalStateException("lost-dismiss-timeout");}
        if(p.exitValue()!=0)throw new IllegalStateException("lost-dismiss-failed");
        for(int n=0;n<50&&locked();n++)Thread.sleep(100);
        if(locked())throw new IllegalStateException("lost-dismiss-failed");
    }
    public boolean locked(){return ((android.app.KeyguardManager)context.getSystemService(Context.KEYGUARD_SERVICE)).isKeyguardLocked();}
    private String credentialCommand(String action,String old,String value)throws Exception {
        java.util.List<String> args=new java.util.ArrayList<>(java.util.Arrays.asList("/system/bin/locksettings",action,"--old",old,"--user","0"));if(value!=null)args.add(value);
        Process p=new ProcessBuilder(args).redirectErrorStream(true).start();
        if(!p.waitFor(10,java.util.concurrent.TimeUnit.SECONDS)){p.destroy();throw new IllegalStateException("lost-system-credential-timeout");}
        byte[] bytes=new byte[2048];int count=p.getInputStream().read(bytes);String result=count<0?"":new String(bytes,0,count,java.nio.charset.StandardCharsets.UTF_8).trim();
        // 厂商命令可能把密码放在输出中；只在内存判定，绝不写入日志或回执。
        if(p.exitValue()!=0)throw new IllegalStateException("lost-system-credential-failed");return result;
    }
    String decryptSetting()throws Exception {
        Process p=new ProcessBuilder("/system/bin/settings","get","global","require_password_to_decrypt").redirectErrorStream(true).start();
        if(!p.waitFor(5,java.util.concurrent.TimeUnit.SECONDS)){p.destroy();throw new IllegalStateException("lost-boot-setting-timeout");}
        byte[] bytes=new byte[128];int count=p.getInputStream().read(bytes);String value=count<0?"":new String(bytes,0,count,java.nio.charset.StandardCharsets.UTF_8).trim();
        if(p.exitValue()!=0||!java.util.Arrays.asList("null","0","1").contains(value))throw new IllegalStateException("lost-boot-setting-unavailable");
        return "null".equals(value)?null:value;
    }
    public void decryptSetting(String value)throws Exception {
        String[] command=value==null?new String[]{"/system/bin/settings","delete","global","require_password_to_decrypt"}
                :new String[]{"/system/bin/settings","put","global","require_password_to_decrypt",value};
        Process p=new ProcessBuilder(command).redirectErrorStream(true).start();
        if(!p.waitFor(5,java.util.concurrent.TimeUnit.SECONDS)){p.destroy();throw new IllegalStateException("lost-boot-setting-timeout");}
        String actual=decryptSetting();
        if(p.exitValue()!=0||!java.util.Objects.equals(actual,value))throw new IllegalStateException("lost-boot-setting-failed");
    }
}
