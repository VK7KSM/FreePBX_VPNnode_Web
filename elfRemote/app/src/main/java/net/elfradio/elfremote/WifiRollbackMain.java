package net.elfradio.elfremote;

import android.content.Context;
import android.net.wifi.WifiManager;
import android.os.Looper;

/** 应用进程中断时，由独立 root 守护恢复已保存网络；不处理网络密码。 */
public final class WifiRollbackMain {
    public static void main(String[] args) {
        try {
            if(android.os.Process.myUid()!=0) throw new SecurityException("root-required");
            Looper.prepareMainLooper();
            Class<?> thread=Class.forName("android.app.ActivityThread");
            Object system=thread.getMethod("systemMain").invoke(null);
            Context context=(Context)thread.getMethod("getSystemContext").invoke(system);
            WifiManager wifi=(WifiManager)context.getSystemService(Context.WIFI_SERVICE);
            if(wifi==null || !wifi.isWifiEnabled()) throw new IllegalStateException("wifi-disabled");
            if(args.length==1 && "check".equals(args[0])) {System.out.println("WIFI_API_READY");System.exit(0);}
            if(args.length<1 || !args[0].matches("[0-9]+")) throw new IllegalArgumentException("invalid-network");
            if(!wifi.enableNetwork(Integer.parseInt(args[0]),true)) throw new IllegalStateException("restore-rejected");
            for(int i=1;i<args.length;i++) {
                if(!args[i].matches("[0-9]+")) throw new IllegalArgumentException("invalid-network");
                wifi.enableNetwork(Integer.parseInt(args[i]),false);
            }
            if(!wifi.reconnect()) throw new IllegalStateException("reconnect-rejected");
            System.out.println("WIFI_RESTORE_REQUESTED");System.exit(0);
        }catch(Throwable error){System.err.println("WIFI_RESTORE_FAILED");System.exit(1);}
    }
}
