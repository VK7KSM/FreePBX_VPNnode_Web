package org.onetwoone.gateway.remote;

import android.content.Context;
import android.net.LocalSocket;
import android.net.LocalSocketAddress;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.PowerManager;
import android.os.SystemClock;
import java.io.*;
import java.net.URI;
import java.nio.ByteBuffer;
import java.security.SecureRandom;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.RejectedExecutionException;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLPeerUnverifiedException;
import javax.net.ssl.SSLSocket;
import org.java_websocket.client.WebSocketClient;
import org.java_websocket.drafts.Draft_6455;
import org.java_websocket.handshake.ServerHandshake;
import org.json.JSONArray;
import org.json.JSONObject;
import org.webrtc.*;

/**
 * 远程桌面会话（应用进程）。核心以 uid 2000 拉起 scrcpy 服务端，本类连上它的视频与控制两条本机套接字，
 * 经一条独立的 RTCPeerConnection 的两条有序 DataChannel 与浏览器直连，Worker 只转发信令。
 * 不建音频轨、不建摄像头轨、不抢音频焦点，网关的 GSM 与 SIP 通话链路完全不受影响。
 */
final class GatewayDesktopSession implements Closeable {
    private final Context context;
    private final GatewayRollingLog log;
    private final HandlerThread thread;
    private final Handler worker;
    private final ExecutorService executor=Executors.newSingleThreadExecutor(r->{Thread t=new Thread(r,"gateway-desktop");t.setDaemon(true);return t;});
    private static volatile boolean nativeReady;

    private WebSocketClient socket;
    private PeerConnectionFactory factory;
    private PeerConnection peer;
    private DataChannel video,control;
    private LocalSocket videoSocket,controlSocket;
    private Thread videoPump,controlPump;
    private PowerManager.WakeLock screen,awake;
    private JSONArray iceServers=new JSONArray();
    private String scid="";
    private volatile boolean closed=true,destroyed;
    private volatile String id="";
    private volatile int generation;
    private volatile long lastInputAt,receivedAt;
    private volatile boolean readySent,videoFlowing;
    private volatile boolean opened,connecting;
    /** 浏览器显示区域的长边（设备像素）。服务端还没开始下发时为 0，退回保守默认值。 */
    private volatile int requestedLongEdge;
    /** 面板报来的播放区尺寸（物理像素）。0 表示没报，退回 max_size 的旧行为。 */
    private volatile int boxWidth,boxHeight;

    private final Runnable idleCheck=new Runnable(){public void run(){
        if(closed)return;
        if(SystemClock.elapsedRealtime()-lastInputAt>=GatewayDesktopPolicy.IDLE_LIMIT_MS){finish("20分钟无操作，远程桌面已自动关闭");return;}
        worker.postDelayed(this,30_000L);
    }};
    private final Runnable prepareTimeout=()->finish("远程桌面准备超时");

    GatewayDesktopSession(Context context,File root){
        this.context=context.getApplicationContext();
        log=new GatewayRollingLog(new File(root,"log"),32768,2);
        thread=new HandlerThread("gateway-desktop-timer");thread.start();worker=new Handler(thread.getLooper());
    }

    /** 上报回复里的 desktop_session；同一会话重复下发直接忽略，已有会话在跑时也不打断。 */
    /**
     * 这个方法跑在上报线程上，**绝不能加锁、绝不能阻塞**。
     * 2026-09-19 事故：它原先是 synchronized 的，桌面会话一旦死锁，
     * 上报线程跟着卡死，整台设备在面板上变成「报告超时」、所有按钮变灰。
     * 一个远程桌面的缺陷因此升级成设备失联。现在只读 volatile 字段做便宜的过滤，
     * 真正的处理交给会话自己的线程，桌面这边再怎么出问题都波及不到上报。
     */
    void accept(JSONObject reply){
        JSONObject offer=reply==null?null:reply.optJSONObject("desktop_session");
        if(destroyed||offer==null||offer.optString("session_id").equals(id)||!closed)return;
        try{executor.execute(()->begin(offer));}
        catch(RejectedExecutionException stopping){/* 服务正在停止，忽略 */}
    }

    private synchronized void begin(JSONObject offer){
        if(destroyed||offer.optString("session_id").equals(id)||!closed)return;
        final URI uri;
        try{uri=GatewayDesktopPolicy.validate(offer,System.currentTimeMillis());}
        catch(Exception rejected){log.write(System.currentTimeMillis()+" DESKTOP_OFFER_REJECTED "+rejected.getClass().getSimpleName());return;}
        id=offer.optString("session_id");closed=false;readySent=false;videoFlowing=false;opened=false;connecting=false;
        generation=offer.optInt("generation",1);
        requestedLongEdge=offer.optInt("max_size",0);
        boxWidth=offer.optInt("display_w",0);boxHeight=offer.optInt("display_h",0);
        iceServers=offer.optJSONArray("ice_servers")==null?new JSONArray():offer.optJSONArray("ice_servers");
        receivedAt=SystemClock.elapsedRealtime();lastInputAt=receivedAt;
        final String owner=id,quality=offer.optString("quality","wifi"),token=offer.optString("token");
        // 已经在会话线程上了，直接接着做，不再往队列里塞一层。
        try{connect(uri,token,owner,quality);}catch(Exception error){fail(error);}
    }

    private void connect(URI uri,String token,String owner,String quality)throws Exception {
        JSONObject installed=GatewayCoreClient.desktopStatus(context);
        if(!installed.optBoolean("installed"))throw new IOException("scrcpy server not installed");
        holdAwake();
        socket=new WebSocketClient(uri,new Draft_6455(),Collections.singletonMap("Authorization","Bearer "+token),10000){
            @Override protected void onSetSSLParameters(SSLParameters parameters){try{SSLSocket ssl=(SSLSocket)getSocket();ssl.setSoTimeout(10000);ssl.startHandshake();
                if(!HttpsURLConnection.getDefaultHostnameVerifier().verify(uri.getHost(),ssl.getSession()))throw new SSLPeerUnverifiedException("relay hostname mismatch");ssl.setSoTimeout(0);
            }catch(IOException error){throw new IllegalStateException("relay TLS validation failed",error);}}
            public void onOpen(ServerHandshake handshake){opened=true;connecting=false;log.write(System.currentTimeMillis()+" DESKTOP_CONNECTED");}
            public void onMessage(String raw){
                final WebSocketClient self=this;
                executor.execute(()->{if(socket!=self||closed||!owner.equals(id))return;
                    try{if(raw.length()>96000)throw new IOException("signal too large");message(new JSONObject(raw),quality);}
                    catch(Exception|LinkageError error){fail(new Exception(error));}});
            }
            public void onClose(int code,String reason,boolean remote){
                if(socket!=this||!GatewayDesktopPolicy.failOnClose(opened,connecting))return;
                finish("远程桌面连接已断开");
            }
            public void onError(Exception error){
                if(socket!=this)return;
                if(!GatewayDesktopPolicy.failOnError(opened,connecting)){
                    // 代理那次尝试失败是预期内的，直连兜底还没跑，别把会话判死。
                    log.write(System.currentTimeMillis()+" DESKTOP_CONNECT_ATTEMPT_FAILED "+describe(error));
                    return;
                }
                fail(error);
            }
        };
        socket.setTcpNoDelay(true);socket.setConnectionLostTimeout(20);
        connecting=true;
        try{if(!GatewayProxyWebSocket.connect(socket))throw new IOException("relay unavailable");}
        finally{connecting=false;}
        worker.postDelayed(prepareTimeout,GatewayDesktopPolicy.PREPARE_TIMEOUT_MS);
    }

    private void message(JSONObject data,String quality)throws Exception {
        switch(data.optString("type")){
            case "hello":
                if(data.has("ice_servers"))iceServers=data.getJSONArray("ice_servers");
                generation=data.optInt("generation",generation);
                // 服务端将来在 hello 里带显示尺寸时自动生效，不必再发一版客户端。
                if(data.optInt("max_size",0)>0)requestedLongEdge=data.optInt("max_size");
                if(data.optInt("display_w",0)>0&&data.optInt("display_h",0)>0){boxWidth=data.optInt("display_w");boxHeight=data.optInt("display_h");}
                start(quality);break;
            case "signal":
                if(data.optInt("generation")!=generation||peer==null)return;
                if("answer".equals(data.optString("kind")))set(new SessionDescription(SessionDescription.Type.ANSWER,data.getString("payload")));
                else if("candidate".equals(data.optString("kind"))){JSONObject c=new JSONObject(data.getString("payload"));
                    peer.addIceCandidate(new IceCandidate(c.optString("sdpMid"),c.optInt("sdpMLineIndex"),c.optString("candidate")));}
                break;
            case "restart":
                // 新代次只重建对等连接与数据通道；scrcpy 服务端与两条本机套接字保持不动。
                generation=data.optInt("generation",generation+1);readySent=false;
                closePeer();openPeer();break;
            case "closed": finish(data.optString("message","远程桌面已结束"));break;
            default: break;
        }
    }

    private void start(String quality)throws Exception {
        android.graphics.Point screen=realSize();
        JSONObject encoding=GatewayDesktopPolicy.encoding(quality,requestedLongEdge,boxWidth,boxHeight,screen.x,screen.y);
        log.write(System.currentTimeMillis()+" DESKTOP_ENCODING size="+encoding.getInt("max_size")
                +" fps="+encoding.getInt("max_fps")+" bitrate="+encoding.getInt("bit_rate")
                +" box="+boxWidth+"x"+boxHeight+" screen="+screen.x+"x"+screen.y+" requested="+requestedLongEdge);
        SecureRandom random=new SecureRandom();
        scid=GatewayDesktopPolicy.scid(random);
        sendStatus("starting");
        JSONObject started=GatewayCoreClient.startDesktop(context,scid,encoding);
        if(!scid.equals(started.optString("scid")))throw new IOException("core refused desktop start");
        sendStatus("server_started");
        try{videoSocket=connectLocal("scrcpy_"+scid,8000);}
        catch(Exception first){
            // 服务端偶发起不来（类路径为空、或被上一轮残留抢先结束）：换个 scid 再拉一次，仍失败才报错。
            log.write(System.currentTimeMillis()+" DESKTOP_SERVER_RETRY "+first.getClass().getSimpleName());
            scid=GatewayDesktopPolicy.scid(random);
            JSONObject again=GatewayCoreClient.startDesktop(context,scid,encoding);
            if(!scid.equals(again.optString("scid")))throw new IOException("core refused desktop start");
            videoSocket=connectLocal("scrcpy_"+scid,8000);
        }
        controlSocket=connectLocal("scrcpy_"+scid,3000);
        sendStatus("socket_ready");
        acquireScreen();
        openPeer();
    }

    private static LocalSocket connectLocal(String name,long timeoutMs)throws Exception {
        long deadline=SystemClock.elapsedRealtime()+timeoutMs;Exception last=null;
        while(SystemClock.elapsedRealtime()<deadline){
            LocalSocket attempt=new LocalSocket();
            try{attempt.connect(new LocalSocketAddress(name,LocalSocketAddress.Namespace.ABSTRACT));return attempt;}
            catch(IOException error){last=error;try{attempt.close();}catch(IOException ignored){}Thread.sleep(150);}
        }
        throw new IOException("screen service socket unavailable",last);
    }

    private synchronized void openPeer()throws Exception {
        if(closed)return;
        if(!nativeReady){PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context).createInitializationOptions());nativeReady=true;}
        if(factory==null)factory=PeerConnectionFactory.builder().createPeerConnectionFactory();
        List<PeerConnection.IceServer> servers=new ArrayList<>();
        for(int i=0;i<iceServers.length();i++){
            JSONObject entry=iceServers.getJSONObject(i);List<String> urls=new ArrayList<>();
            Object raw=entry.opt("urls");
            if(raw instanceof JSONArray)for(int k=0;k<((JSONArray)raw).length();k++)urls.add(((JSONArray)raw).getString(k));
            else if(raw!=null)urls.add(String.valueOf(raw));
            if(urls.isEmpty())continue;
            PeerConnection.IceServer.Builder builder=PeerConnection.IceServer.builder(urls);
            if(entry.has("username"))builder.setUsername(entry.getString("username"));
            if(entry.has("credential"))builder.setPassword(entry.getString("credential"));
            servers.add(builder.createIceServer());
        }
        if(servers.isEmpty())servers.add(PeerConnection.IceServer.builder("stun:stun.cloudflare.com:3478").createIceServer());
        PeerConnection.RTCConfiguration config=new PeerConnection.RTCConfiguration(servers);
        config.sdpSemantics=PeerConnection.SdpSemantics.UNIFIED_PLAN;config.iceCandidatePoolSize=1;
        final String owner=id;final int gen=generation;
        peer=factory.createPeerConnection(config,new PeerConnection.Observer(){
            public void onSignalingChange(PeerConnection.SignalingState state){}
            public void onIceConnectionChange(PeerConnection.IceConnectionState state){
                if(closed||!owner.equals(id)||gen!=generation)return;
                log.write(System.currentTimeMillis()+" DESKTOP_ICE state="+state+" after_ms="+(SystemClock.elapsedRealtime()-receivedAt));
                if(state==PeerConnection.IceConnectionState.FAILED)sendStatus("ice_failed");
            }
            public void onIceConnectionReceivingChange(boolean receiving){}
            public void onIceGatheringChange(PeerConnection.IceGatheringState state){}
            public void onIceCandidate(IceCandidate candidate){
                if(closed||!owner.equals(id)||gen!=generation)return;
                try{signal("candidate",new JSONObject().put("candidate",candidate.sdp).put("sdpMid",candidate.sdpMid).put("sdpMLineIndex",candidate.sdpMLineIndex).toString());}
                catch(Exception error){fail(error);}
            }
            public void onIceCandidatesRemoved(IceCandidate[] candidates){}
            public void onAddStream(MediaStream stream){}
            public void onRemoveStream(MediaStream stream){}
            public void onDataChannel(DataChannel channel){}
            public void onRenegotiationNeeded(){}
            public void onAddTrack(RtpReceiver receiver,MediaStream[] streams){}
        });
        if(peer==null)throw new IOException("desktop peer connection unavailable");
        DataChannel.Init init=new DataChannel.Init();init.ordered=true;
        video=peer.createDataChannel("video",init);control=peer.createDataChannel("control",init);
        video.registerObserver(new DataChannel.Observer(){
            public void onBufferedAmountChange(long previous){}
            public void onStateChange(){if(video!=null&&video.state()==DataChannel.State.OPEN)startVideoPump(gen);}
            public void onMessage(DataChannel.Buffer buffer){}
        });
        control.registerObserver(new DataChannel.Observer(){
            public void onBufferedAmountChange(long previous){}
            public void onStateChange(){if(control!=null&&control.state()==DataChannel.State.OPEN){startControlPump(gen);checkReady();}}
            public void onMessage(DataChannel.Buffer buffer){
                if(closed||gen!=generation||controlSocket==null)return;
                byte[] bytes=new byte[buffer.data.remaining()];buffer.data.get(bytes);lastInputAt=SystemClock.elapsedRealtime();
                LocalSocket target=controlSocket;
                try{synchronized(target){OutputStream out=target.getOutputStream();out.write(bytes);out.flush();}}
                catch(IOException error){fail(error);}
            }
        });
        SessionDescription offer=create();set(offer);
        signal("offer",offer.description);
    }

    private void startVideoPump(int gen){
        if(videoPump!=null&&videoPump.isAlive())return;
        videoPump=new Thread(()->pump(videoSocket,()->video,gen,true),"gateway-desktop-video");videoPump.setDaemon(true);videoPump.start();
    }
    private void startControlPump(int gen){
        if(controlPump!=null&&controlPump.isAlive())return;
        controlPump=new Thread(()->pump(controlSocket,()->control,gen,false),"gateway-desktop-control");controlPump.setDaemon(true);controlPump.start();
    }
    private interface ChannelRef {DataChannel get();}
    private void pump(LocalSocket from,ChannelRef to,int gen,boolean isVideo){
        byte[] buffer=new byte[GatewayDesktopPolicy.CHUNK];
        try(InputStream in=from.getInputStream()){
            int count;
            while(!closed&&(count=in.read(buffer))!=-1){
                DataChannel channel=to.get();
                if(channel==null||gen!=generation){if(gen!=generation)return;continue;}
                while(!closed&&gen==generation&&channel.bufferedAmount()>GatewayDesktopPolicy.BACKPRESSURE_BYTES)Thread.sleep(5);
                if(closed||gen!=generation)return;
                if(channel.state()!=DataChannel.State.OPEN)return;
                channel.send(new DataChannel.Buffer(ByteBuffer.wrap(Arrays.copyOf(buffer,count)),true));
                if(isVideo&&!videoFlowing){videoFlowing=true;checkReady();}
            }
            if(!closed&&gen==generation)finish(isVideo?"屏幕服务已结束":"控制通道已结束");
        }catch(Exception error){if(!closed&&gen==generation)fail(error);}
    }

    private synchronized void checkReady(){
        if(closed||readySent||!videoFlowing||control==null||control.state()!=DataChannel.State.OPEN)return;
        readySent=true;worker.removeCallbacks(prepareTimeout);worker.removeCallbacks(idleCheck);worker.postDelayed(idleCheck,30_000L);
        log.write(System.currentTimeMillis()+" DESKTOP_READY after_ms="+(SystemClock.elapsedRealtime()-receivedAt));
        try{
            android.graphics.Point size=realSize();
            send(new JSONObject().put("type","ready").put("width",size.x).put("height",size.y).put("encoder","hardware"));
        }catch(Exception error){fail(error);}
    }

    /** 屏幕真实分辨率。触控坐标按它换算，编码短边也按它的纵横比推。 */
    private android.graphics.Point realSize(){
        android.graphics.Point size=new android.graphics.Point();
        try{((android.view.WindowManager)context.getSystemService(Context.WINDOW_SERVICE)).getDefaultDisplay().getRealSize(size);}
        catch(Exception unavailable){log.write(System.currentTimeMillis()+" DESKTOP_DISPLAY_SIZE_UNAVAILABLE "+unavailable.getClass().getSimpleName());}
        return size;
    }

    private void holdAwake(){
        PowerManager manager=context.getSystemService(PowerManager.class);
        if(manager==null)throw new IllegalStateException("power service unavailable");
        awake=manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"elfRemote:gateway-desktop");
        awake.acquire(GatewayDesktopPolicy.IDLE_LIMIT_MS+60_000L);
    }
    private void acquireScreen(){
        try{
            PowerManager manager=context.getSystemService(PowerManager.class);
            @SuppressWarnings("deprecation") PowerManager.WakeLock lock=manager.newWakeLock(
                    PowerManager.SCREEN_BRIGHT_WAKE_LOCK|PowerManager.ACQUIRE_CAUSES_WAKEUP|PowerManager.ON_AFTER_RELEASE,"elfRemote:gateway-desktop-screen");
            lock.acquire(GatewayDesktopPolicy.IDLE_LIMIT_MS+60_000L);screen=lock;
        }catch(Exception error){log.write(System.currentTimeMillis()+" DESKTOP_SCREEN_LOCK_FAILED "+error.getClass().getSimpleName());}
    }

    private SessionDescription create()throws Exception {
        CompletableFuture<SessionDescription> pending=new CompletableFuture<>();
        peer.createOffer(new Sdp(){public void onCreateSuccess(SessionDescription value){pending.complete(value);}
            public void onCreateFailure(String error){pending.completeExceptionally(new IOException(error));}},new MediaConstraints());
        return pending.get(10,TimeUnit.SECONDS);
    }
    private void set(SessionDescription description)throws Exception {
        CompletableFuture<Void> pending=new CompletableFuture<>();
        Sdp observer=new Sdp(){public void onSetSuccess(){pending.complete(null);}
            public void onSetFailure(String error){pending.completeExceptionally(new IOException(error));}};
        if(description.type==SessionDescription.Type.OFFER)peer.setLocalDescription(observer,description);
        else peer.setRemoteDescription(observer,description);
        pending.get(10,TimeUnit.SECONDS);
    }
    private void signal(String kind,String payload)throws Exception {
        send(new JSONObject().put("type","signal").put("kind",kind).put("payload",payload).put("generation",generation));
    }
    private void sendStatus(String stage){try{send(new JSONObject().put("type","status").put("stage",stage));}catch(Exception ignored){}}
    private void send(JSONObject data){WebSocketClient active=socket;if(!closed&&active!=null&&active.isOpen())active.send(data.toString());}
    /** 只记类名会让排查停在「是哪个 IllegalArgumentException」上；消息一并留下，中继地址由 redact 洗掉。 */
    private static String describe(Throwable error){
        String message=GatewayDesktopPolicy.redact(error.getMessage());
        return error.getClass().getSimpleName()+(message.isEmpty()?"":" "+message);
    }

    private void fail(Exception error){
        log.write(System.currentTimeMillis()+" DESKTOP_FAILED "+describe(error));
        // 这条会经中继显示在网页上，同样走 redact，且长度已在 MESSAGE_LIMIT 之内。
        try{send(new JSONObject().put("type","status").put("stage","failed").put("message",describe(error)));}catch(Exception ignored){}
        finish("远程桌面失败");
    }

    private void closePeer(){
        if(video!=null){try{video.unregisterObserver();video.close();video.dispose();}catch(Exception ignored){}video=null;}
        if(control!=null){try{control.unregisterObserver();control.close();control.dispose();}catch(Exception ignored){}control=null;}
        if(peer!=null){try{peer.close();peer.dispose();}catch(Exception ignored){}peer=null;}
    }

    /**
     * 关闭 WebSocket 这一步必须在锁外做。
     * 2026-09-19 事故的直接原因：它原先在 synchronized 块里调 close()，
     * 而 WebSocket 的读线程在 onClose 回调里也会进来调 finish()，
     * 那时它持有 WebSocketImpl 的锁、等本对象的锁，我们持有本对象的锁、等它的锁，
     * 两边锁顺序相反，抱死。真机线程栈里两条线程各自 Blocked、互指对方，一目了然。
     */
    void finish(String reason){
        WebSocketClient active;
        synchronized(this){
            if(closed)return;closed=true;
            worker.removeCallbacks(prepareTimeout);worker.removeCallbacks(idleCheck);
            log.write(System.currentTimeMillis()+" DESKTOP_STOPPED reason="+reason);
            active=socket;socket=null;
        }
        if(active!=null)try{active.close();}catch(Exception ignored){}
        try{executor.execute(()->{
            closePeer();
            for(LocalSocket open:new LocalSocket[]{videoSocket,controlSocket})if(open!=null)try{open.close();}catch(IOException ignored){}
            videoSocket=controlSocket=null;
            try{GatewayCoreClient.stopDesktop(context);}catch(Exception error){log.write(System.currentTimeMillis()+" DESKTOP_CORE_STOP_FAILED "+error.getClass().getSimpleName());}
            for(PowerManager.WakeLock lock:new PowerManager.WakeLock[]{screen,awake})if(lock!=null)try{if(lock.isHeld())lock.release();}catch(Exception ignored){}
            screen=awake=null;
            if(factory!=null){try{factory.dispose();}catch(Exception ignored){}factory=null;}
        });}catch(RejectedExecutionException stopping){/* 服务正在停止，清理随进程一起结束 */}
    }

    /** 同样不能在锁里调 finish：它内部要关 WebSocket，握着锁关就会和读线程抱死。 */
    public void close(){
        synchronized(this){if(destroyed)return;destroyed=true;}
        finish("网关服务停止");
        executor.shutdown();thread.quitSafely();
    }

    private static class Sdp implements SdpObserver {
        public void onCreateSuccess(SessionDescription description){}
        public void onSetSuccess(){}
        public void onCreateFailure(String error){}
        public void onSetFailure(String error){}
    }
}
