package net.elfradio.elfremote;

import org.json.JSONObject;
import java.io.*;
import java.util.concurrent.TimeUnit;

/** 丢失期间关闭未经认证的设备调试入口；云端通用维护仍走认证核心。 */
final class LostDebugGuard {
    static String run(String... args)throws Exception {
        Process p=new ProcessBuilder(args).redirectErrorStream(true).start();
        if(!p.waitFor(12,TimeUnit.SECONDS)){p.destroy();throw new IOException("lost-debug-timeout");}
        byte[] bytes=new byte[4096];int n=p.getInputStream().read(bytes);
        if(p.exitValue()!=0)throw new IOException("lost-debug-command-failed");
        return n<0?"":new String(bytes,0,n,"UTF-8").trim();
    }
    static void restrict(JSONObject s,LostRecovery.Save save)throws Exception {
        if(!s.has("original_debug")){
            s.put("original_debug",new JSONObject().put("usb",run("/system/bin/getprop","sys.usb.config"))
                    .put("tcp",run("/system/bin/getprop","service.adb.tcp.port"))
                    .put("enabled",run("/system/bin/settings","get","global","adb_enabled"))
                    .put("running","running".equals(run("/system/bin/getprop","init.svc.adbd"))));
            save.save();
        }
        String usb=run("/system/bin/getprop","sys.usb.config");
        String safe=java.util.Arrays.stream(usb.split(",")).filter(x->!x.equals("adb")&&!x.isEmpty()).collect(java.util.stream.Collectors.joining(","));
        if(safe.isEmpty())safe="none";
        if(!"0".equals(run("/system/bin/settings","get","global","adb_enabled")))run("/system/bin/settings","put","global","adb_enabled","0");
        if(!safe.equals(usb))run("/system/bin/setprop","sys.usb.config",safe);
        if(!"-1".equals(run("/system/bin/getprop","service.adb.tcp.port")))run("/system/bin/setprop","service.adb.tcp.port","-1");
        if("running".equals(run("/system/bin/getprop","init.svc.adbd")))run("/system/bin/stop","adbd");
        if(java.util.Arrays.asList(run("/system/bin/getprop","sys.usb.config").split(",")).contains("adb")
                ||"running".equals(run("/system/bin/getprop","init.svc.adbd")))throw new IOException("lost-debug-restrict-pending");
    }
    static void restore(JSONObject s)throws Exception {
        JSONObject old=s.optJSONObject("original_debug");if(old==null)return;
        String enabled=old.getString("enabled"),usb=old.getString("usb"),tcp=old.getString("tcp");
        if(enabled.equals("null"))run("/system/bin/settings","delete","global","adb_enabled");
        else run("/system/bin/settings","put","global","adb_enabled",enabled);
        run("/system/bin/setprop","service.adb.tcp.port",tcp);
        run("/system/bin/setprop","sys.usb.config",usb);
        boolean running=old.optBoolean("running",usb.contains("adb")||(!tcp.isEmpty()&&!tcp.equals("-1")&&!tcp.equals("0")));
        run("/system/bin/"+(running?"start":"stop"),"adbd");
        for(int n=0;n<10&&running!="running".equals(run("/system/bin/getprop","init.svc.adbd"));n++)Thread.sleep(100);
        if(!enabled.equals(run("/system/bin/settings","get","global","adb_enabled"))||!usb.equals(run("/system/bin/getprop","sys.usb.config"))||!tcp.equals(run("/system/bin/getprop","service.adb.tcp.port"))
                ||running!="running".equals(run("/system/bin/getprop","init.svc.adbd")))throw new IOException("lost-debug-restore-pending");
    }
    private LostDebugGuard(){}
}
