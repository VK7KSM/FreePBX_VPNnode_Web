package net.elfradio.elfremote;

import android.content.Context;
import android.net.LocalSocket;
import android.net.LocalSocketAddress;
import android.os.*;
import org.json.*;
import org.webrtc.*;
import org.webrtc.audio.JavaAudioDeviceModule;
import org.java_websocket.client.WebSocketClient;
import org.java_websocket.handshake.ServerHandshake;
import java.io.*;
import java.nio.ByteBuffer;
import java.security.SecureRandom;
import java.util.*;
import java.util.concurrent.*;

/**
 * 远程桌面会话：核心以 uid 2000 拉起 scrcpy 服务端，本类连接其视频/控制两条本机套接字，
 * 经独立 RTCPeerConnection 的两条有序 DataChannel 与浏览器直连（STUN/TURN），Worker 只转发信令。
 * 不创建音频/摄像头轨道，不请求音频焦点。
 */
final class DesktopSession {
    private static final long IDLE_LIMIT_MS = 20 * 60 * 1000L;
    private static final int CHUNK = 16384;
    private static final long BACKPRESSURE_BYTES = 2L * 1024 * 1024;
    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private WebSocketClient socket;
    private PeerConnectionFactory factory;
    private PeerConnection pc;
    private DataChannel video, control;
    private LocalSocket videoSocket, controlSocket;
    private Thread videoPump, controlPump;
    private PowerManager.WakeLock screen;
    private JSONArray iceServers = new JSONArray();
    private String scid = "";
    private volatile boolean closed = true, destroyed;
    private volatile String id = "";
    private volatile int generation;
    private volatile long lastInputAt, receivedAt;
    private volatile boolean readySent, videoFlowing;
    private final Runnable idleCheck = new Runnable() { public void run() {
        if (closed) return;
        if (SystemClock.elapsedRealtime() - lastInputAt >= IDLE_LIMIT_MS) { stop("20分钟无操作，远程桌面已自动关闭"); return; }
        main.postDelayed(this, 30000L);
    } };
    private final Runnable prepareTimeout = () -> stop("远程桌面准备超时");

    DesktopSession(Context c) { context = c.getApplicationContext(); }

    /**
     * 上报线程调这里，所以它绝不能去拿会话锁。
     * 网关 2026-09-19 的事故就是这么从一个远程桌面缺陷升级成整台设备失联的：
     * 桌面会话内部抱死之后，上报线程卡在同一把锁上，进程活着、SIP 还注册着，但上报全停。
     * 这里只读 volatile 字段做过滤，真正的工作交给会话自己的线程。
     */
    void receive(JSONObject offer) {
        if (destroyed || offer == null || System.currentTimeMillis() > offer.optLong("expires_at")
                || offer.optString("session_id").equals(id) || !closed) return;
        try { executor.execute(() -> begin(offer)); } catch (RejectedExecutionException stopping) { /* 正在停止，忽略 */ }
    }

    private synchronized void begin(JSONObject offer) {
        if (destroyed || !closed || offer.optString("session_id").equals(id)) return;
        id = offer.optString("session_id"); closed = false; readySent = false; videoFlowing = false;
        generation = offer.optInt("generation", 1); iceServers = offer.optJSONArray("ice_servers") == null ? new JSONArray() : offer.optJSONArray("ice_servers");
        receivedAt = SystemClock.elapsedRealtime(); lastInputAt = receivedAt;
        final String owner = id; final String quality = offer.optString("quality", "wifi");
        executor.execute(() -> { try {
            java.net.URI uri = new java.net.URI(offer.getString("url"));
            // 只接受面板同源的 wss 中继地址，且查询串恰好是本次会话号，避免 offer 被改写把设备引到别处。
            // 端口、用户信息、片段都要卡死：只比对主机名不够，wss://u@host、host:8443、带片段都能绕过去。
            java.net.URI control = new java.net.URI(Protocol.BASE_URL);
            if (!"wss".equals(uri.getScheme()) || !control.getHost().equals(uri.getHost())
                    || uri.getUserInfo() != null || uri.getFragment() != null
                    || (uri.getPort() != -1 && uri.getPort() != 443)
                    || !"/api/elfremote/desktop/device".equals(uri.getPath())
                    || !("session_id=" + owner).equals(uri.getRawQuery())) throw new Exception("远程桌面地址无效");
            // 令牌要放进 Authorization 头，所以只做健壮性检查，不校验形状。它是服务端签发、服务端核验的
            // 持有者凭据，形状属于服务端实现细节（当前是两个 UUID 拼接），设备端钉死格式只会在服务端换
            // 格式时把自己弄哑，而且哑得很难查。这里只限制长度与字符集，挡住换行等头注入字符。
            String bearer = offer.getString("token");
            if (bearer.isEmpty() || bearer.length() > 256 || !bearer.matches("[A-Za-z0-9._~+/=-]+")) throw new Exception("远程桌面凭据无效");
            if (!CoreInstaller.ready() || !ScrcpyAsset.ready()) throw new Exception("远程桌面组件尚未就绪");
            WakeScheduler.hold(context, "desktop-session", 1830000L);
            socket = new WebSocketClient(uri, Collections.singletonMap("Authorization", "Bearer " + bearer)) {
                public void onOpen(ServerHandshake h) { RuntimeLog.event("desktop_connected"); }
                public void onMessage(String raw) {
                    if (socket != this || closed) return;
                    executor.execute(() -> { if (closed || !owner.equals(id)) return; try { if (raw.length() > 96000) throw new Exception("信令过大"); message(new JSONObject(raw), quality); } catch (Exception | LinkageError e) { fail(new Exception(e)); } });
                }
                public void onClose(int code, String reason, boolean remote) { if (socket == this) stop("远程桌面连接已断开"); }
                public void onError(Exception e) { if (socket == this) fail(e); }
            };
            socket.setTcpNoDelay(true); socket.setConnectionLostTimeout(20); socket.connect();
            main.postDelayed(prepareTimeout, 30000L);
        } catch (Exception e) { fail(e); } });
    }

    private void message(JSONObject x, String quality) throws Exception {
        switch (x.optString("type")) {
            case "hello":
                if (x.has("ice_servers")) iceServers = x.getJSONArray("ice_servers");
                generation = x.optInt("generation", generation);
                start(quality); break;
            case "signal":
                if (x.optInt("generation") != generation || pc == null) return;
                if ("answer".equals(x.optString("kind"))) set(new SessionDescription(SessionDescription.Type.ANSWER, x.getString("payload")));
                else if ("candidate".equals(x.optString("kind"))) { JSONObject c = new JSONObject(x.getString("payload")); pc.addIceCandidate(new IceCandidate(c.optString("sdpMid"), c.optInt("sdpMLineIndex"), c.optString("candidate"))); }
                break;
            case "restart":
                // 新代次：重建对等连接与数据通道，scrcpy 服务端与本机套接字保持不动。
                generation = x.optInt("generation", generation + 1); readySent = false;
                closePeer(); openPeer(); break;
            case "closed": stop(x.optString("message", "远程桌面已结束")); break;
        }
    }

    private void start(String quality) throws Exception {
        byte[] random = new byte[4]; new SecureRandom().nextBytes(random);
        scid = String.format("%02x%02x%02x%02x", random[0] & 0x7f, random[1], random[2], random[3]);
        boolean cellular = "cellular".equals(quality);
        JSONObject started = CoreClient.request("/desktop/start", new JSONObject().put("scid", scid).put("max_fps", cellular ? 15 : 30).put("bit_rate", cellular ? 500000 : 1500000).put("max_size", cellular ? 960 : 1280), 8000);
        if (started == null || !started.optBoolean("ok")) throw new Exception("核心未能启动屏幕服务");
        sendStatus("starting");
        String name = "scrcpy_" + scid;
        try { videoSocket = connectLocal(name, 8000); }
        catch (Exception first) {
            // 服务端偶发起不来（类路径为空/被抢先结束）：换 scid 再拉一次，仍失败才报错。
            RuntimeLog.error("desktop_server_retry", first);
            random = new byte[4]; new SecureRandom().nextBytes(random);
            scid = String.format("%02x%02x%02x%02x", random[0] & 0x7f, random[1], random[2], random[3]);
            JSONObject again = CoreClient.request("/desktop/start", new JSONObject().put("scid", scid).put("max_fps", cellular ? 15 : 30).put("bit_rate", cellular ? 500000 : 1500000).put("max_size", cellular ? 960 : 1280), 8000);
            if (again == null || !again.optBoolean("ok")) throw new Exception("核心未能启动屏幕服务");
            name = "scrcpy_" + scid; videoSocket = connectLocal(name, 8000);
        }
        controlSocket = connectLocal(name, 3000);
        acquireScreen();
        openPeer();
    }

    private static LocalSocket connectLocal(String name, long timeoutMs) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + timeoutMs; Exception last = null;
        while (SystemClock.elapsedRealtime() < deadline) {
            LocalSocket s = new LocalSocket();
            try { s.connect(new LocalSocketAddress(name, LocalSocketAddress.Namespace.ABSTRACT)); return s; }
            catch (IOException e) { last = e; try { s.close(); } catch (IOException ignored) { } Thread.sleep(150); }
        }
        throw new Exception("屏幕服务套接字未就绪", last);
    }

    private synchronized void openPeer() throws Exception {
        if (closed) return;
        MediaSession.initializeNative(context);
        if (factory == null) factory = PeerConnectionFactory.builder().setAudioDeviceModule(JavaAudioDeviceModule.builder(context).setUseHardwareAcousticEchoCanceler(false).setUseHardwareNoiseSuppressor(false).createAudioDeviceModule()).createPeerConnectionFactory();
        List<PeerConnection.IceServer> servers = new ArrayList<>();
        for (int i = 0; i < iceServers.length(); i++) {
            JSONObject s = iceServers.getJSONObject(i); List<String> urls = new ArrayList<>();
            Object u = s.opt("urls"); if (u instanceof JSONArray) for (int k = 0; k < ((JSONArray) u).length(); k++) urls.add(((JSONArray) u).getString(k)); else if (u != null) urls.add(String.valueOf(u));
            PeerConnection.IceServer.Builder b = PeerConnection.IceServer.builder(urls);
            if (s.has("username")) b.setUsername(s.getString("username")); if (s.has("credential")) b.setPassword(s.getString("credential"));
            servers.add(b.createIceServer());
        }
        if (servers.isEmpty()) servers.add(PeerConnection.IceServer.builder("stun:stun.cloudflare.com:3478").createIceServer());
        PeerConnection.RTCConfiguration config = new PeerConnection.RTCConfiguration(servers);
        config.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN; config.iceCandidatePoolSize = 1;
        final String owner = id; final int gen = generation;
        pc = factory.createPeerConnection(config, new PeerConnection.Observer() {
            public void onSignalingChange(PeerConnection.SignalingState s) {}
            public void onIceConnectionChange(PeerConnection.IceConnectionState s) { if (closed || !owner.equals(id) || gen != generation) return; RuntimeLog.event("desktop_ice state=" + s + " after_ms=" + (SystemClock.elapsedRealtime() - receivedAt)); if (s == PeerConnection.IceConnectionState.FAILED) sendStatus("ice_failed"); }
            public void onIceConnectionReceivingChange(boolean v) {}
            public void onIceGatheringChange(PeerConnection.IceGatheringState s) {}
            public void onIceCandidate(IceCandidate c) { if (closed || !owner.equals(id) || gen != generation) return; try { signal("candidate", new JSONObject().put("candidate", c.sdp).put("sdpMid", c.sdpMid).put("sdpMLineIndex", c.sdpMLineIndex).toString()); } catch (Exception e) { fail(e); } }
            public void onIceCandidatesRemoved(IceCandidate[] c) {}
            public void onAddStream(MediaStream s) {}
            public void onRemoveStream(MediaStream s) {}
            public void onDataChannel(DataChannel c) {}
            public void onRenegotiationNeeded() {}
            public void onAddTrack(RtpReceiver r, MediaStream[] streams) {}
        });
        if (pc == null) throw new Exception("远程桌面连接初始化失败");
        DataChannel.Init init = new DataChannel.Init(); init.ordered = true;
        video = pc.createDataChannel("video", init); control = pc.createDataChannel("control", init);
        video.registerObserver(new DataChannel.Observer() {
            public void onBufferedAmountChange(long p) {}
            public void onStateChange() { if (video != null && video.state() == DataChannel.State.OPEN) startVideoPump(gen); }
            public void onMessage(DataChannel.Buffer b) {}
        });
        control.registerObserver(new DataChannel.Observer() {
            public void onBufferedAmountChange(long p) {}
            public void onStateChange() { if (control != null && control.state() == DataChannel.State.OPEN) { startControlPump(gen); checkReady(); } }
            public void onMessage(DataChannel.Buffer b) {
                if (closed || gen != generation || controlSocket == null) return;
                byte[] bytes = new byte[b.data.remaining()]; b.data.get(bytes); lastInputAt = SystemClock.elapsedRealtime();
                try { synchronized (controlSocket) { OutputStream out = controlSocket.getOutputStream(); out.write(bytes); out.flush(); } } catch (IOException e) { fail(e); }
            }
        });
        SessionDescription offer = create(); set(offer);
        signal("offer", offer.description);
    }

    private void startVideoPump(int gen) {
        if (videoPump != null && videoPump.isAlive()) return;
        videoPump = new Thread(() -> pump(videoSocket, () -> video, gen, true), "elfremote-desktop-video"); videoPump.setDaemon(true); videoPump.start();
    }
    private void startControlPump(int gen) {
        if (controlPump != null && controlPump.isAlive()) return;
        controlPump = new Thread(() -> pump(controlSocket, () -> control, gen, false), "elfremote-desktop-control"); controlPump.setDaemon(true); controlPump.start();
    }
    private interface ChannelRef { DataChannel get(); }
    private void pump(LocalSocket from, ChannelRef to, int gen, boolean isVideo) {
        byte[] buffer = new byte[CHUNK];
        try (InputStream in = from.getInputStream()) {
            int n;
            while (!closed && (n = in.read(buffer)) != -1) {
                DataChannel dc = to.get();
                if (dc == null || gen != generation) { if (gen != generation) return; continue; }
                while (!closed && gen == generation && dc.bufferedAmount() > BACKPRESSURE_BYTES) Thread.sleep(5);
                if (closed || gen != generation) return;
                if (dc.state() != DataChannel.State.OPEN) return;
                dc.send(new DataChannel.Buffer(ByteBuffer.wrap(Arrays.copyOf(buffer, n)), true));
                if (isVideo && !videoFlowing) { videoFlowing = true; checkReady(); }
            }
            if (!closed && gen == generation) stop(isVideo ? "屏幕服务已结束" : "控制通道已结束");
        } catch (Exception e) { if (!closed && gen == generation) fail(e); }
    }

    private void checkReady() {
        Exception failure = null;
        synchronized (this) {
            if (closed || readySent || !videoFlowing || control == null || control.state() != DataChannel.State.OPEN) return;
            readySent = true; main.removeCallbacks(prepareTimeout); main.removeCallbacks(idleCheck); main.postDelayed(idleCheck, 30000L);
            RuntimeLog.event("desktop_ready after_ms=" + (SystemClock.elapsedRealtime() - receivedAt));
            try { android.view.Display d = ((android.view.WindowManager) context.getSystemService(Context.WINDOW_SERVICE)).getDefaultDisplay(); android.graphics.Point p = new android.graphics.Point(); d.getRealSize(p);
                send(new JSONObject().put("type", "ready").put("width", p.x).put("height", p.y).put("encoder", "hardware")); } catch (Exception e) { failure = e; }
        }
        // fail 会走到 stop、stop 要关 WebSocket。必须在锁外调：否则本方法的锁仍被本线程持有，
        // 等于把 stop 里「关闭放到锁外」的修复整个抵消。D31-dev 在他那边发现同型的 start() 后提醒的。
        if (failure != null) fail(failure);
    }

    private void acquireScreen() {
        try {
            PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
            @SuppressWarnings("deprecation") PowerManager.WakeLock lock = pm.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP | PowerManager.ON_AFTER_RELEASE, "elfRemote:desktop-screen");
            lock.acquire(IDLE_LIMIT_MS + 60000L); screen = lock;
        } catch (Exception e) { RuntimeLog.error("desktop_screen_lock_failed", e); }
    }

    private SessionDescription create() throws Exception {
        CompletableFuture<SessionDescription> f = new CompletableFuture<>();
        pc.createOffer(new Sdp() { public void onCreateSuccess(SessionDescription d) { f.complete(d); } public void onCreateFailure(String e) { f.completeExceptionally(new Exception(e)); } }, new MediaConstraints());
        return f.get(10, TimeUnit.SECONDS);
    }
    private void set(SessionDescription d) throws Exception {
        CompletableFuture<Void> f = new CompletableFuture<>();
        Sdp o = new Sdp() { public void onSetSuccess() { f.complete(null); } public void onSetFailure(String e) { f.completeExceptionally(new Exception(e)); } };
        if (d.type == SessionDescription.Type.OFFER) pc.setLocalDescription(o, d); else pc.setRemoteDescription(o, d);
        f.get(10, TimeUnit.SECONDS);
    }
    private void signal(String kind, String payload) throws Exception { send(new JSONObject().put("type", "signal").put("kind", kind).put("payload", payload).put("generation", generation)); }
    private void sendStatus(String stage) { try { send(new JSONObject().put("type", "status").put("stage", stage)); } catch (Exception ignored) { } }
    private void send(JSONObject x) { WebSocketClient ws = socket; if (!closed && ws != null && ws.isOpen()) ws.send(x.toString()); }
    private void fail(Exception e) { RuntimeLog.error("desktop_failed", e); try { send(new JSONObject().put("type", "status").put("stage", "failed").put("message", DesktopText.redact(e.getMessage()))); } catch (Exception ignored) { } stop("远程桌面失败"); }

    private void closePeer() {
        if (video != null) { try { video.unregisterObserver(); video.close(); video.dispose(); } catch (Exception ignored) { } video = null; }
        if (control != null) { try { control.unregisterObserver(); control.close(); control.dispose(); } catch (Exception ignored) { } control = null; }
        if (pc != null) { try { pc.close(); pc.dispose(); } catch (Exception ignored) { } pc = null; }
    }

    void stop(String reason) {
        WebSocketClient ws;
        synchronized (this) {
            if (closed) return; closed = true;
            main.removeCallbacks(prepareTimeout); main.removeCallbacks(idleCheck);
            RuntimeLog.event("desktop_stopped reason=" + reason);
            ws = socket; socket = null;
        }
        // 关 WebSocket 必须在锁外：读线程会在 onClose 回调里反过来调 stop，
        // 握着会话锁去关，两条线程就会按相反的顺序各持一把锁互等（网关实测线程栈证实）。
        if (ws != null) try { ws.close(); } catch (Exception ignored) { }
        executor.execute(() -> {
            closePeer();
            for (LocalSocket s : new LocalSocket[]{videoSocket, controlSocket}) if (s != null) try { s.close(); } catch (IOException ignored) { }
            videoSocket = controlSocket = null;
            try { CoreClient.request("/desktop/stop", new JSONObject().put("scid", scid), 5000); } catch (Exception e) { RuntimeLog.error("desktop_core_stop_failed", e); }
            if (screen != null) { try { if (screen.isHeld()) screen.release(); } catch (Exception ignored) { } screen = null; }
            if (factory != null) { try { factory.dispose(); } catch (Exception ignored) { } factory = null; }
            WakeScheduler.release("desktop-session");
        });
    }
    // 不能是 synchronized：它握着锁调 stop，stop 内部要关 WebSocket，等于把上面的修复抵消掉。
    void shutdown() {
        synchronized (this) { if (destroyed) return; destroyed = true; }
        stop("客户端服务停止");
        executor.shutdown();
    }

    private static class Sdp implements SdpObserver { public void onCreateSuccess(SessionDescription d) {} public void onSetSuccess() {} public void onCreateFailure(String e) {} public void onSetFailure(String e) {} }
}
