package org.onetwoone.gateway.remote;

import android.content.Context;
import java.io.*;
import java.net.*;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

/** Internal admission gate. No Web capability invokes this controller yet. */
final class GatewayPixelCompanionController {
    interface Root { JSONObject run(String operation) throws Exception; }
    private final Root root;

    GatewayPixelCompanionController(Context context){root=operation->invoke(context,operation);}
    GatewayPixelCompanionController(Root root){this.root=root;}

    JSONObject inspect() throws Exception {return root.run("inspect");}
    JSONObject installDisabled(Boolean gatewayBusy) throws Exception {
        requireIdle(gatewayBusy);JSONObject result=root.run("install-disabled");
        if(result.optBoolean("units_enabled",true))throw new SecurityException("companion unexpectedly active");
        return result;
    }
    JSONObject rollback(Boolean gatewayBusy) throws Exception {requireIdle(gatewayBusy);return root.run("rollback");}

    private static void requireIdle(Boolean busy) throws IOException {
        if(busy==null||busy)throw new IOException("gateway-not-confirmed-idle");
    }

    private static JSONObject invoke(Context context,String operation)throws Exception {
        if(!java.util.Arrays.asList("inspect","install-disabled","rollback").contains(operation))throw new SecurityException("operation rejected");
        String token=GatewayWifiConnector.randomToken();long deadline=android.os.SystemClock.elapsedRealtime()+60_000L;Process process=null;
        try(ServerSocket server=new ServerSocket(0,1,InetAddress.getByName("127.0.0.1"))){
            server.setSoTimeout(60_000);String command="export CLASSPATH="+GatewayWifiConnector.quote(context.getApplicationInfo().sourceDir)
                    +"; exec /system/bin/app_process /system/bin org.onetwoone.gateway.remote.GatewayPixelCompanionRootMain "+operation+" "+server.getLocalPort()+" "+token+" </dev/null >/dev/null 2>&1";
            process=new ProcessBuilder("su","-c",command).start();JSONObject reply;
            try(Socket socket=server.accept()){socket.setSoTimeout((int)Math.max(1,deadline-android.os.SystemClock.elapsedRealtime()));reply=GatewayWifiConnector.readRootResult(new DataInputStream(socket.getInputStream()),token);}
            long remaining=deadline-android.os.SystemClock.elapsedRealtime();
            if(remaining<=0||!process.waitFor(remaining,TimeUnit.MILLISECONDS)){process.destroy();throw new IOException("companion helper timeout");}
            if(process.exitValue()!=0||!reply.optBoolean("ok"))throw new IOException(reply.optString("error","companion helper rejected"));
            return reply.getJSONObject("result");
        } finally {if(process!=null&&process.isAlive())process.destroy();}
    }
}
