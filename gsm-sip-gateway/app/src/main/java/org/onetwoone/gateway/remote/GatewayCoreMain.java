package org.onetwoone.gateway.remote;

import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.SystemClock;
import java.io.*;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;
import org.onetwoone.gateway.BuildConfig;

/** Independent authenticated health and push process. It does not execute shell commands. */
public final class GatewayCoreMain {
    public static void main(String[] args) throws Exception {
        if (android.os.Process.myUid()!=0) throw new SecurityException("root required");
        String auth;
        try (FileInputStream input = new FileInputStream(GatewayCoreClient.DIR+"/auth")) {
            auth = readLine(input).trim();
        }
        if (!auth.matches("[0-9a-f]{64}")) throw new IOException("invalid core identity");
        long started = SystemClock.elapsedRealtime();
        LocalServerSocket server = new LocalServerSocket(GatewayCoreProtocol.SOCKET);
        android.content.Context resolvedContext=null;
        try{resolvedContext=systemContext();}catch(Exception ignored){}
        final android.content.Context context=resolvedContext;
        GatewayCorePush push=null;try{if(context!=null)push=new GatewayCorePush(context,new File(GatewayCoreClient.DIR));}catch(Exception ignored){}
        boolean running=true;
        try {
            while (running) {
                try (LocalSocket client = server.accept()) {
                    client.setSoTimeout(3000);
                    JSONObject request = new JSONObject(readLine(client.getInputStream()));
                    JSONObject response = new JSONObject().put("ok",false);
                    if (GatewayCoreProtocol.allowed(request,auth)) {
                        String operation=request.getString("operation");response.put("ok",true);
                        if("health".equals(operation))response.put("version_code",BuildConfig.VERSION_CODE)
                                    .put("pid",android.os.Process.myPid()).put("uid",android.os.Process.myUid())
                                    .put("uptime_ms",SystemClock.elapsedRealtime()-started).put("update_ready",true)
                                    .put("independent_push",push!=null).put("push_connected",push!=null&&push.status().optBoolean("connected"));
                        else if("pixel-module-health".equals(operation))response.put("pixel_modules",GatewayPixelLegacyHealth.snapshot());
                        else if("mobile-status".equals(operation)){
                            try {response.put("mobile_status",context==null
                                    ?GatewayMobileStatus.unavailable():GatewayMobileStatusCollector.collect(context));}
                            catch(Exception failure){response.put("mobile_status",GatewayMobileStatus.unavailable())
                                    .put("mobile_error",GatewayMobileStatusCollector.errorCategory(failure));}
                        }
                        else if("push-config".equals(operation)&&push!=null)response.put("push",push.configure(request));
                        else if("push-status".equals(operation)&&push!=null)response.put("push",push.status());
                        else if("push-tick".equals(operation)&&push!=null){push.tick();response.put("ticked",true);}
                        else if("push-ack".equals(operation)&&push!=null){push.acknowledge(request.optString("delivery_id"));response.put("acknowledged",true);}
                        else if("push-hint".equals(operation)&&push!=null){push.hint();response.put("hinted",true);}
                        else if("shutdown".equals(operation)){response.put("stopping",true);running=false;}
                        else response=new JSONObject().put("ok",false);
                    }
                    client.getOutputStream().write((response.toString()+"\n").getBytes(StandardCharsets.UTF_8));
                } catch (Exception invalid) {
                    // Malformed or unauthenticated peers never stop the listener.
                }
            }
        } finally {if(push!=null)push.close();server.close();}
    }
    static String readLine(InputStream input) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        for (int count=0;count<GatewayCoreProtocol.MAX_BYTES;count++) {
            int value=input.read();
            if(value==-1||value=='\n') return bytes.toString("UTF-8");
            bytes.write(value);
        }
        throw new IOException("frame too large");
    }
    static android.content.Context systemContext() throws Exception {
        if(android.os.Looper.getMainLooper()==null)android.os.Looper.prepareMainLooper();
        Object thread=Class.forName("android.app.ActivityThread").getMethod("systemMain").invoke(null);
        return (android.content.Context)thread.getClass().getMethod("getSystemContext").invoke(thread);
    }
}
