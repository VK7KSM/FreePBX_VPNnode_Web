package net.elfradio.elfremote;

import android.net.TrafficStats;
import android.os.IBinder;
import java.net.Socket;
import javax.net.ssl.SSLSocketFactory;

/** root维护连接归入当前elfRemote应用UID，避免混入root其他业务。 */
final class CoreTraffic {
    static final int TAG=0x454c4601;
    static int applicationUid()throws Exception {
        IBinder binder=(IBinder)Class.forName("android.os.ServiceManager").getMethod("getService",String.class).invoke(null,"package");
        Class<?> manager=Class.forName("android.content.pm.IPackageManager");
        Object service=Class.forName("android.content.pm.IPackageManager$Stub").getMethod("asInterface",IBinder.class).invoke(null,binder);
        android.content.pm.ApplicationInfo info=(android.content.pm.ApplicationInfo)manager.getMethod("getApplicationInfo",String.class,int.class,int.class)
                .invoke(service,"net.elfradio.elfremote",0,0);
        if(info==null||info.uid<10000)throw new java.io.IOException("elfRemote应用UID不可用");
        return info.uid;
    }
    static SSLSocketFactory factory(){return new AttributedTlsFactory((SSLSocketFactory)SSLSocketFactory.getDefault(),CoreTraffic::tag);}
    static void tag(Socket socket)throws Exception {
        int old=TrafficStats.getThreadStatsTag();
        try {
            TrafficStats.class.getMethod("setThreadStatsUid",int.class).invoke(null,applicationUid());
            TrafficStats.setThreadStatsTag(TAG);TrafficStats.tagSocket(socket);
        }finally {
            TrafficStats.setThreadStatsTag(old);
            TrafficStats.class.getMethod("clearThreadStatsUid").invoke(null);
        }
    }
    private CoreTraffic(){}
}
