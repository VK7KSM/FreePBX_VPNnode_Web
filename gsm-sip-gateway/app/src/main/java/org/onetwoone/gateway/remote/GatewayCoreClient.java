package org.onetwoone.gateway.remote;

import android.content.Context;
import android.net.LocalSocket;
import android.net.LocalSocketAddress;
import android.util.AtomicFile;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;
import org.onetwoone.gateway.BuildConfig;

final class GatewayCoreClient {
    static final String DIR="/data/local/elfremote-gateway/core";
    private static String quote(String value) { return "'"+value.replace("'","'\\''")+"'"; }
    private static synchronized String auth(Context context) throws Exception {
        AtomicFile file=new AtomicFile(new File(context.getFilesDir(),"gateway-core-auth"));
        if(file.getBaseFile().exists()) return new String(file.readFully(),StandardCharsets.UTF_8).trim();
        byte[] random=new byte[32]; new SecureRandom().nextBytes(random);
        StringBuilder text=new StringBuilder();
        for(byte b:random) text.append(String.format(java.util.Locale.ROOT,"%02x",b&255));
        FileOutputStream out=file.startWrite();
        try {out.write((text+"\n").getBytes(StandardCharsets.UTF_8));file.finishWrite(out);}
        catch(Exception error){file.failWrite(out);throw error;}
        return text.toString();
    }
    static JSONObject health(Context context) throws Exception {
        return request(context,new JSONObject().put("operation","health"));
    }
    static JSONObject pixelModuleHealth(Context context) throws Exception {
        return request(context,new JSONObject().put("operation","pixel-module-health")).getJSONObject("pixel_modules");
    }
    static JSONObject mobileStatus(Context context) throws Exception {
        return request(context,new JSONObject().put("operation","mobile-status"));
    }
    static JSONObject prepareProxy(Context context) throws Exception {
        File asset=GatewayProxyAssets.stagedFile(context);return request(context,new JSONObject().put("operation","proxy-prepare")
                .put("asset_path",asset.getCanonicalPath()).put("size",GatewayProxyAssets.EXECUTABLE_SIZE)
                .put("sha256",GatewayProxyAssets.EXECUTABLE_SHA256)).getJSONObject("proxy");
    }
    static JSONObject proxyStatus(Context context) throws Exception {
        return request(context,new JSONObject().put("operation","proxy-status")).getJSONObject("proxy");
    }
    static JSONObject configureProxy(Context context,File staged,long size,String sha256)throws Exception {
        return request(context,new JSONObject().put("operation","proxy-configure").put("config_path",staged.getCanonicalPath())
                .put("size",size).put("sha256",sha256),90_000).getJSONObject("proxy");
    }
    static JSONObject startProxy(Context context)throws Exception {return request(context,new JSONObject().put("operation","proxy-start"),30_000).getJSONObject("proxy");}
    static JSONObject stopProxy(Context context)throws Exception {return request(context,new JSONObject().put("operation","proxy-stop")).getJSONObject("proxy");}
    static JSONObject testProxy(Context context)throws Exception {return request(context,new JSONObject().put("operation","proxy-test"),15_000).getJSONObject("proxy");}
    private static JSONObject request(Context context,JSONObject body) throws Exception {
        return request(context,body,3000);
    }
    private static JSONObject request(Context context,JSONObject body,int timeout) throws Exception {
        try(LocalSocket socket=new LocalSocket()) {
            socket.connect(new LocalSocketAddress(GatewayCoreProtocol.SOCKET)); socket.setSoTimeout(timeout);
            body.put("auth",auth(context));
            socket.getOutputStream().write((body+"\n").getBytes(StandardCharsets.UTF_8));
            JSONObject result=new JSONObject(GatewayCoreMain.readLine(socket.getInputStream()));
            if(!result.optBoolean("ok")) throw new IOException("core authentication rejected");
            return result;
        }
    }
    static JSONObject ensure(Context context) throws Exception {
        auth(context);
        JSONObject previous=null;
        try { previous=health(context);if(previous.optInt("version_code")>=BuildConfig.VERSION_CODE)return previous; }
        catch(IOException absent) { }
        String payload=DIR+"/payload-"+BuildConfig.VERSION_CODE+".apk";
        String source=context.getApplicationInfo().sourceDir;
        String key=new File(context.getFilesDir(),"gateway-core-auth").getPath();
        // Fixed paths only; credentials are copied from private files, never command arguments.
        String stop="";
        if(previous!=null){int pid=previous.optInt("pid",-1);if(pid<2)throw new SecurityException("invalid core pid");
            stop="if [ -r /proc/"+pid+"/cmdline ] && tr '\\000' ' ' < /proc/"+pid+"/cmdline | grep -q 'org.onetwoone.gateway.remote.GatewayCoreMain'; then kill "+pid+"; fi\n"
                    +"for n in 1 2 3 4 5 6 7 8 9 10; do [ ! -d /proc/"+pid+" ] && break; sleep 0.2; done\n[ ! -d /proc/"+pid+" ]\n";}
        String command="set -e\numask 077\nmkdir -p "+DIR+"\nchmod 700 "+DIR+"\n"+stop
                +"if [ -f "+DIR+"/auth ]; then cmp "+quote(key)+" "+DIR+"/auth; else cp "+quote(key)+" "+DIR+"/auth.new; mv "+DIR+"/auth.new "+DIR+"/auth; fi\n"
                +"if [ -f "+payload+" ]; then cmp "+quote(source)+" "+payload+"; else cp "+quote(source)+" "+payload+".new; cmp "+quote(source)+" "+payload+".new; mv "+payload+".new "+payload+"; fi\n"
                +"CLASSPATH="+payload+" nohup /system/bin/app_process /system/bin org.onetwoone.gateway.remote.GatewayCoreMain </dev/null >"+DIR+"/startup.log 2>&1 &\n";
        Process process=new ProcessBuilder("su","-c",command).redirectErrorStream(true).start();
        if(!process.waitFor(15,TimeUnit.SECONDS)) {process.destroy();throw new IOException("core preparation timeout");}
        if(process.exitValue()!=0) throw new IOException("core preparation failed");
        for(int attempt=0;attempt<10;attempt++) {
            try {JSONObject ready=health(context);if(ready.optInt("version_code")>=BuildConfig.VERSION_CODE)return ready;}
            catch(IOException notReady){}
            Thread.sleep(200);
        }
        throw new IOException("core health unavailable");
    }
    static JSONObject configurePush(Context context,String device,String token) throws Exception {
        return request(context,new JSONObject().put("operation","push-config").put("device_id",device).put("token",token)).getJSONObject("push");
    }
    static JSONObject pushStatus(Context context) throws Exception {
        return request(context,new JSONObject().put("operation","push-status")).getJSONObject("push");
    }
    static void tickPush(Context context) throws Exception {request(context,new JSONObject().put("operation","push-tick"));}
    static void acknowledgePush(Context context,String delivery) throws Exception {
        request(context,new JSONObject().put("operation","push-ack").put("delivery_id",delivery));
    }
}
