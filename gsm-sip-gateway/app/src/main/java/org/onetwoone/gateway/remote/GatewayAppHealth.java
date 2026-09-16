package org.onetwoone.gateway.remote;

import android.content.Context;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.net.LocalSocketAddress;
import android.os.SystemClock;
import java.io.*;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;
import org.onetwoone.gateway.BuildConfig;
import org.onetwoone.gateway.PjsipSipService;

/** Root-only live read endpoint; it never starts or stops calls. */
final class GatewayAppHealth implements Closeable {
    private static final String SOCKET="elfremote_gateway_app_health_v1";
    private final Context context;
    private final LocalServerSocket server;
    private volatile boolean stopped;
    GatewayAppHealth(Context context) throws IOException {
        this.context=context.getApplicationContext();server=new LocalServerSocket(SOCKET);
        new Thread(this::serve,"gateway-live-health").start();
    }
    private void serve() {
        while(!stopped) {
            try(LocalSocket peer=server.accept()) {
                peer.setSoTimeout(2000);
                if(peer.getPeerCredentials().getUid()!=0)continue;
                if(!"health".equals(GatewayCoreMain.readLine(peer.getInputStream())))continue;
                peer.getOutputStream().write((snapshot()+"\n").getBytes(StandardCharsets.UTF_8));
            } catch(Exception unavailable) {
                if(stopped)return;
            }
        }
    }
    private JSONObject snapshot() throws Exception {
        GatewayRemoteStore store=new GatewayRemoteStore(context);
        PjsipSipService gateway=PjsipSipService.getInstance();
        Boolean busy=gateway==null?null:gateway.remoteBusy();
        return new JSONObject().put("ok",true).put("version_code",BuildConfig.VERSION_CODE)
                .put("version_name",BuildConfig.VERSION_NAME).put("sample_elapsed_ms",SystemClock.elapsedRealtime())
                .put("identity_sha256",GatewayRemoteStore.hash(store.deviceId()))
                .put("paired",store.prefs.getBoolean("paired",false)).put("last_report",store.prefs.getLong("last_report",0))
                .put("running",gateway!=null&&gateway.isRunning()).put("sip_registered",gateway!=null&&gateway.isSipRegistered())
                .put("busy",busy==null?JSONObject.NULL:busy);
    }
    static JSONObject read(Context system) throws Exception {
        int expectedUid=system.getPackageManager().getApplicationInfo(GatewayRemotePolicy.PACKAGE,0).uid;
        try(LocalSocket socket=new LocalSocket()) {
            socket.connect(new LocalSocketAddress(SOCKET));socket.setSoTimeout(3000);
            if(socket.getPeerCredentials().getUid()!=expectedUid)throw new SecurityException("wrong health endpoint owner");
            socket.getOutputStream().write("health\n".getBytes(StandardCharsets.UTF_8));
            JSONObject response=new JSONObject(GatewayCoreMain.readLine(socket.getInputStream()));
            if(!response.optBoolean("ok"))throw new IOException("health unavailable");
            return response;
        }
    }
    @Override public void close() throws IOException {stopped=true;server.close();}
}
