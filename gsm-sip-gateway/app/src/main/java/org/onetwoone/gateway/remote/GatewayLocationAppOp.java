package org.onetwoone.gateway.remote;

import android.app.AppOpsManager;
import android.content.Context;
import android.os.Process;
import java.io.IOException;
import java.util.concurrent.TimeUnit;

/** Temporarily permits this root-managed gateway to scan Wi-Fi while its UI is backgrounded. */
final class GatewayLocationAppOp {
    static String current(Context context) throws IOException {
        AppOpsManager manager=(AppOpsManager)context.getSystemService(Context.APP_OPS_SERVICE);
        if(manager==null)throw new IOException("appops unavailable");
        return modeName(manager.checkOpNoThrow(AppOpsManager.OPSTR_FINE_LOCATION,Process.myUid(),context.getPackageName()));
    }
    static void set(String mode) throws Exception {
        if(!mode.matches("allow|foreground|ignore|deny|default"))throw new IOException("invalid appop mode");
        java.lang.Process process=new ProcessBuilder("su","-c","appops set org.onetwoone.gateway FINE_LOCATION "+mode).redirectErrorStream(true).start();
        if(!process.waitFor(10,TimeUnit.SECONDS)||process.exitValue()!=0)throw new IOException("location appop unavailable");
    }
    static String modeName(int mode) throws IOException {
        if(mode==AppOpsManager.MODE_ALLOWED)return "allow";
        if(mode==AppOpsManager.MODE_IGNORED)return "ignore";
        if(mode==AppOpsManager.MODE_ERRORED)return "deny";
        if(mode==AppOpsManager.MODE_DEFAULT)return "default";
        if(mode==AppOpsManager.MODE_FOREGROUND)return "foreground";
        throw new IOException("unknown appop mode");
    }
    private GatewayLocationAppOp() {}
}
