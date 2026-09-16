package org.onetwoone.gateway.remote;

import android.content.Context;
import android.os.PowerManager;
import android.util.Base64;
import java.io.Closeable;
import java.io.File;
import java.io.IOException;
import java.net.URI;
import java.util.Collections;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLPeerUnverifiedException;
import javax.net.ssl.SSLSocket;
import org.java_websocket.client.WebSocketClient;
import org.java_websocket.handshake.ServerHandshake;
import org.json.JSONObject;

/** On-demand browser maintenance session. Native host ADB tunnelling is a later protocol. */
final class GatewayAdbSessions implements Closeable {
    private final Context context;private final GatewayRollingLog log;private Session current;
    GatewayAdbSessions(Context context,File root){this.context=context;log=new GatewayRollingLog(new File(root,"log"),32768,2);}
    static URI validate(JSONObject request,long now)throws Exception {
        String id=request.getString("session_id"),token=request.getString("token");
        if(!id.matches("[a-f0-9-]{36}")||!token.matches("[a-f0-9]{64}"))throw new IOException("invalid session identity");
        long expires=request.getLong("expires_at");if(expires<=now||expires>now+120000)throw new IOException("session expired");
        URI uri=new URI(request.getString("url")),control=new URI(GatewayRemotePolicy.BASE_URL);
        if(!"wss".equals(uri.getScheme())||!control.getHost().equals(uri.getHost())||uri.getUserInfo()!=null||uri.getFragment()!=null
                ||(uri.getPort()!=-1&&uri.getPort()!=443)||!"/api/elfremote/adb/device".equals(uri.getPath())||!("session_id="+id).equals(uri.getRawQuery()))
            throw new IOException("untrusted relay address");
        return uri;
    }
    synchronized JSONObject open(JSONObject request)throws Exception {
        URI uri=validate(request,System.currentTimeMillis());String id=request.getString("session_id");
        if(current!=null&&current.id.equals(id))return new JSONObject().put("accepted",true);
        if(current!=null)current.finish("replaced");current=new Session(id,uri,request.getString("token"));current.start();
        return new JSONObject().put("accepted",true);
    }
    public synchronized void close(){if(current!=null)current.finish("core stopping");current=null;}
    private final class Session {
        final String id;final WebSocketClient websocket;final java.util.Timer deadline=new java.util.Timer("gateway-adb-deadline",true);
        GatewayMaintenanceShell shell;PowerManager.WakeLock wake;boolean ended;
        Session(String id,URI uri,String token){this.id=id;websocket=new WebSocketClient(uri,Collections.singletonMap("Authorization","Bearer "+token)){
            @Override protected void onSetSSLParameters(SSLParameters parameters){try{SSLSocket socket=(SSLSocket)getSocket();socket.setSoTimeout(10000);socket.startHandshake();
                if(!HttpsURLConnection.getDefaultHostnameVerifier().verify(uri.getHost(),socket.getSession()))throw new SSLPeerUnverifiedException("relay hostname mismatch");socket.setSoTimeout(0);
            }catch(IOException error){throw new IllegalStateException("relay TLS validation failed",error);}}
            public void onOpen(ServerHandshake handshake){openShell();}
            public void onMessage(String raw){receive(raw);}
            public void onClose(int code,String reason,boolean remote){finish("relay closed");}
            public void onError(Exception error){log.write(System.currentTimeMillis()+" ADB_WS_ERROR "+error.getClass().getSimpleName());finish("network error");}
        };websocket.setConnectionLostTimeout(30);}
        void start(){Thread thread=new Thread(()->{try{holdAwake();deadline.schedule(new java.util.TimerTask(){public void run(){finish("deadline");}},1800000);
                    log.write(System.currentTimeMillis()+" ADB_CONNECT_BEGIN");if(!websocket.connectBlocking(10,TimeUnit.SECONDS))throw new IOException("relay unavailable");}
                catch(Exception error){log.write(System.currentTimeMillis()+" ADB_CONNECT_FAILED "+error.getClass().getSimpleName());finish("connect failed");}},"gateway-adb-connect");thread.setDaemon(true);thread.start();}
        synchronized void openShell(){if(ended)return;try{shell=new GatewayMaintenanceShell(new GatewayMaintenanceShell.Listener(){public void output(int channel,byte[] data){sendOutput(channel,data);}
                public void closed(String reason){finish("shell closed");}});shell.start();send(new JSONObject().put("type","ready").put("protocol","shell").put("resize_supported",false));log.write(System.currentTimeMillis()+" ADB_CONNECTED");}
            catch(Exception error){log.write(System.currentTimeMillis()+" ADB_SHELL_FAILED "+error.getClass().getSimpleName());finish("shell unavailable");}}
        void receive(String raw){try{if(raw.length()>90000)throw new IOException("input too large");JSONObject data=new JSONObject(raw);String type=data.optString("type");
                if("closed".equals(type)){finish("console closed");return;}GatewayMaintenanceShell active=shell;if(active==null||ended)throw new IOException("shell not ready");
                if("input".equals(type))active.input(Base64.decode(data.getString("data"),Base64.DEFAULT));
                else if(!"resize".equals(type))throw new IOException("unsupported operation");
            }catch(Exception error){finish("input rejected");}}
        void sendOutput(int channel,byte[] bytes){for(int at=0;at<bytes.length;at+=32768)try{send(new JSONObject().put("type","output").put("channel",channel)
                    .put("data",Base64.encodeToString(java.util.Arrays.copyOfRange(bytes,at,Math.min(bytes.length,at+32768)),Base64.NO_WRAP)));}catch(Exception error){finish("output failed");return;}}
        synchronized void send(JSONObject data)throws IOException {if(ended||!websocket.isOpen())throw new IOException("relay closed");
            if(websocket.getConnection() instanceof org.java_websocket.WebSocketImpl){long pending=0;for(java.nio.ByteBuffer b:((org.java_websocket.WebSocketImpl)websocket.getConnection()).outQueue)pending+=b.remaining();if(pending>262144)throw new IOException("output backlog");}
            websocket.send(data.toString());}
        void holdAwake(){PowerManager manager=context.getSystemService(PowerManager.class);if(manager==null)throw new IllegalStateException("power service unavailable");wake=manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"elfRemote:gateway-adb");wake.acquire(1800000);}
        synchronized void finish(String reason){if(ended)return;ended=true;deadline.cancel();if(shell!=null)shell.close();if(wake!=null&&wake.isHeld())wake.release();
            boolean open=websocket.isOpen();try{if(open)websocket.send(new JSONObject().put("type","closed").put("exit",JSONObject.NULL).put("message",reason).toString());}catch(Exception ignored){}websocket.close();
            log.write(System.currentTimeMillis()+" ADB_CLOSED reason="+reason);synchronized(GatewayAdbSessions.this){if(current==this)current=null;}}
    }
}
