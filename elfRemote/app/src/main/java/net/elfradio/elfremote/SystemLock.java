package net.elfradio.elfremote;

import android.content.Context;
import android.os.PowerManager;
import java.lang.reflect.*;
import org.json.JSONObject;

/** 使用系统凭据接口；不删除锁屏数据库，不绕过未知的原密码。 */
final class SystemLock {
    private final Context context;
    private final Object lock;
    private final Class<?> cls;
    SystemLock(Context context)throws Exception {
        this.context=context;cls=Class.forName("com.android.internal.widget.LockPatternUtils");lock=cls.getConstructor(Context.class).newInstance(context);
    }
    boolean disabled()throws Exception{return (Boolean)cls.getMethod("isLockScreenDisabled",int.class).invoke(lock,0);}
    void disabled(boolean value)throws Exception{cls.getMethod("setLockScreenDisabled",boolean.class,int.class).invoke(lock,value,0);}
    boolean secure()throws Exception{return (Boolean)cls.getMethod("isSecure",int.class).invoke(lock,0);}
    JSONObject owner()throws Exception {
        Object text=cls.getMethod("getOwnerInfo",int.class).invoke(lock,0);
        return new JSONObject().put("message",text==null?"":text.toString()).put("enabled",cls.getMethod("isOwnerInfoEnabled",int.class).invoke(lock,0));
    }
    void owner(JSONObject value)throws Exception {
        cls.getMethod("setOwnerInfo",String.class,int.class).invoke(lock,value.optString("message"),0);
        cls.getMethod("setOwnerInfoEnabled",boolean.class,int.class).invoke(lock,value.optBoolean("enabled"),0);
    }
    boolean verify(String password)throws Exception {
        try{return (Boolean)cls.getMethod("checkPassword",String.class,int.class).invoke(lock,password,0);}
        catch(NoSuchMethodException unsupported){
            for(Method method:cls.getMethods())if(method.getName().equals("checkPassword")&&method.getParameterTypes().length==3&&method.getParameterTypes()[0]==String.class)
                return (Boolean)method.invoke(lock,password,0,null);
            throw new IllegalStateException("lost-system-credential-unsupported");
        }
    }
    void password(String value,String old)throws Exception {
        Object result;
        if(value.isEmpty())result=cls.getMethod("clearLock",String.class,int.class).invoke(lock,old,0);
        else result=cls.getMethod("saveLockPassword",String.class,String.class,int.class,int.class).invoke(lock,value,old,0x50000,0);
        if(result instanceof Boolean&&!((Boolean)result))throw new IllegalStateException("lost-system-password-failed");
    }
    void lock()throws Exception {
        cls.getMethod("setLockScreenDisabled",boolean.class,int.class).invoke(lock,false,0);
        Object binder=Class.forName("android.os.ServiceManager").getMethod("getService",String.class).invoke(null,"window");
        Class<?> stub=Class.forName("android.view.IWindowManager$Stub");Object wm=stub.getMethod("asInterface",android.os.IBinder.class).invoke(null,binder);
        Class.forName("android.view.IWindowManager").getMethod("lockNow",android.os.Bundle.class).invoke(wm,new Object[]{null});
        for(int n=0;n<20&&!locked();n++)Thread.sleep(100);
    }
    void dismiss()throws Exception {
        Process p=new ProcessBuilder("/system/bin/wm","dismiss-keyguard").redirectErrorStream(true).start();
        if(!p.waitFor(5,java.util.concurrent.TimeUnit.SECONDS)){p.destroy();throw new IllegalStateException("lost-dismiss-timeout");}
        if(p.exitValue()!=0)throw new IllegalStateException("lost-dismiss-failed");
    }
    boolean locked(){return ((android.app.KeyguardManager)context.getSystemService(Context.KEYGUARD_SERVICE)).isKeyguardLocked();}
}
