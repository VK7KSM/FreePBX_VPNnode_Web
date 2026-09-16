package org.onetwoone.gateway.remote;

import android.content.Context;
import android.os.PowerManager;
import java.io.Closeable;
import java.io.File;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.nio.ByteBuffer;
import java.util.Collections;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLPeerUnverifiedException;
import javax.net.ssl.SSLSocket;
import org.java_websocket.client.WebSocketClient;
import org.java_websocket.handshake.ServerHandshake;
import org.json.JSONObject;

/** Transparent ADB byte tunnel. The host performs normal end-to-end ADB authentication. */
final class GatewayAdbTunnel implements Closeable {
    private final Context context;private final GatewayRollingLog log;private Session current;
    GatewayAdbTunnel(Context context,File root){this.context=context;log=new GatewayRollingLog(new File(root,"log"),32768,2);}
    static URI validate(JSONObject request,long now)throws Exception {
        String id=request.getString("session_id"),token=request.getString("token");
        if(!id.matches("[a-f0-9-]{36}")||!token.matches("[a-f0-9]{64}"))throw new IOException("invalid tunnel identity");
        long expires=request.getLong("expires_at");if(expires<=now||expires>now+1800000||!"unix_ms".equals(request.optString("expires_at_unit")))throw new IOException("tunnel expired");
        URI uri=new URI(request.getString("device_url")),control=new URI(GatewayRemotePolicy.BASE_URL);
        if(!"wss".equals(uri.getScheme())||!control.getHost().equals(uri.getHost())||uri.getUserInfo()!=null||uri.getFragment()!=null
                ||(uri.getPort()!=-1&&uri.getPort()!=443)||!"/api/elfremote/adb-tunnel/device".equals(uri.getPath())||!("session_id="+id).equals(uri.getRawQuery()))
            throw new IOException("untrusted tunnel address");
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
        final String id;final WebSocketClient websocket;final java.util.Timer deadline=new java.util.Timer("gateway-adb-tunnel-deadline",true);
        Socket local;PowerManager.WakeLock wake;boolean ended;long upstream,downstream;
        Session(String id,URI uri,String token){this.id=id;websocket=new WebSocketClient(uri,Collections.singletonMap("Authorization","Bearer "+token)){
            @Override protected void onSetSSLParameters(SSLParameters parameters){try{SSLSocket socket=(SSLSocket)getSocket();socket.setSoTimeout(10000);socket.startHandshake();
                if(!HttpsURLConnection.getDefaultHostnameVerifier().verify(uri.getHost(),socket.getSession()))throw new SSLPeerUnverifiedException("tunnel hostname mismatch");socket.setSoTimeout(0);
            }catch(IOException error){throw new IllegalStateException("tunnel TLS validation failed",error);}}
            public void onOpen(ServerHandshake handshake){connectLocal();}
            public void onMessage(String raw){try{if(!"closed".equals(new JSONObject(raw).optString("type")))throw new IOException("unexpected control frame");}catch(Exception ignored){}finally{finish("relay closed");}}
            public void onMessage(ByteBuffer bytes){writeLocal(bytes);}
            public void onClose(int code,String reason,boolean remote){finish("relay closed");}
            public void onError(Exception error){log.write(System.currentTimeMillis()+" TUNNEL_WS_ERROR "+error.getClass().getSimpleName());finish("network error");}
        };websocket.setConnectionLostTimeout(30);}
        void start(){Thread thread=new Thread(()->{try{holdAwake();deadline.schedule(new java.util.TimerTask(){public void run(){finish("deadline");}},1800000);
                    log.write(System.currentTimeMillis()+" TUNNEL_CONNECT_BEGIN");if(!websocket.connectBlocking(10,TimeUnit.SECONDS))throw new IOException("relay unavailable");}
                catch(Exception error){log.write(System.currentTimeMillis()+" TUNNEL_CONNECT_FAILED "+error.getClass().getSimpleName());finish("connect failed");}},"gateway-adb-tunnel-connect");thread.setDaemon(true);thread.start();}
        synchronized void connectLocal(){if(ended)return;try{Socket socket=new Socket();socket.setTcpNoDelay(true);socket.connect(new InetSocketAddress("127.0.0.1",5555),3000);local=socket;
                Thread reader=new Thread(this::readLocal,"gateway-adb-tunnel-reader");reader.setDaemon(true);reader.start();log.write(System.currentTimeMillis()+" TUNNEL_CONNECTED");}
            catch(Exception error){log.write(System.currentTimeMillis()+" TUNNEL_LOCAL_FAILED "+error.getClass().getSimpleName());finish("local adbd unavailable");}}
        void writeLocal(ByteBuffer frame){try{int size=frame.remaining();if(size<1||size>65536)throw new IOException("invalid tunnel frame");byte[] data=new byte[size];frame.get(data);
                Socket socket; synchronized(this){if(ended||local==null)throw new IOException("local adbd unavailable");socket=local;downstream+=size;}
                socket.getOutputStream().write(data);socket.getOutputStream().flush();
            }catch(Exception error){finish("downstream failed");}}
        void readLocal(){byte[] buffer=new byte[32768];try{for(int n;!ended&&(n=local.getInputStream().read(buffer))>=0;){if(n==0)continue;
                    if(websocket.getConnection() instanceof org.java_websocket.WebSocketImpl){long pending=0;for(ByteBuffer b:((org.java_websocket.WebSocketImpl)websocket.getConnection()).outQueue)pending+=b.remaining();if(pending>1048576)throw new IOException("tunnel backlog");}
                    websocket.send(java.util.Arrays.copyOf(buffer,n));synchronized(this){upstream+=n;}}}
            catch(Exception error){finish("upstream failed");}}
        void holdAwake(){PowerManager manager=context.getSystemService(PowerManager.class);if(manager==null)throw new IllegalStateException("power service unavailable");wake=manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"elfRemote:gateway-adb-tunnel");wake.acquire(1800000);}
        synchronized void finish(String reason){if(ended)return;ended=true;deadline.cancel();try{if(local!=null)local.close();}catch(IOException ignored){}if(wake!=null&&wake.isHeld())wake.release();
            websocket.close();log.write(System.currentTimeMillis()+" TUNNEL_CLOSED reason="+reason+" up="+upstream+" down="+downstream);
            synchronized(GatewayAdbTunnel.this){if(current==this)current=null;}}
    }
}
