package net.elfradio.elfremote;

import android.content.Context;
import android.os.Looper;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** 仅管理锁屏失主文字，不设置密码、不锁机、不改变电话或定位设置。 */
public final class OwnerInfoMain {
    public static void main(String[] args) {
        try {
            if(android.os.Process.myUid()!=0 || args.length<1) throw new SecurityException();
            Looper.prepareMainLooper();
            Class<?> thread=Class.forName("android.app.ActivityThread");
            Object system=thread.getMethod("systemMain").invoke(null);
            Context context=(Context)thread.getMethod("getSystemContext").invoke(system);
            Class<?> cls=Class.forName("com.android.internal.widget.LockPatternUtils");
            Object lock=cls.getConstructor(Context.class).newInstance(context);
            Method get=cls.getMethod("getOwnerInfo",int.class), enabled=cls.getMethod("isOwnerInfoEnabled",int.class);
            if("write".equals(args[0])) {
                if(args.length!=2) throw new IllegalArgumentException();
                java.io.File file=new java.io.File(args[1]);
                if(file.length()>65536) throw new IllegalArgumentException();
                byte[] bytes=java.nio.file.Files.readAllBytes(file.toPath());
                JSONObject input=new JSONObject(new String(bytes,StandardCharsets.UTF_8));
                cls.getMethod("setOwnerInfo",String.class,int.class).invoke(lock,input.getString("message"),0);
                cls.getMethod("setOwnerInfoEnabled",boolean.class,int.class).invoke(lock,input.getBoolean("enabled"),0);
            } else if(!"read".equals(args[0])) throw new IllegalArgumentException();
            Object text=get.invoke(lock,0);
            System.out.println(new JSONObject().put("message",text==null?"":text.toString()).put("enabled",enabled.invoke(lock,0)));
            System.exit(0);
        } catch(Throwable error) {System.err.println("owner-info-unavailable");System.exit(1);}
    }
}
