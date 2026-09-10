package net.elfradio.elfremote;

import android.content.Context;
import android.media.AudioManager;
import android.net.*;
import android.os.*;
import org.json.*;
import org.webrtc.*;
import org.webrtc.audio.JavaAudioDeviceModule;
import org.java_websocket.client.WebSocketClient;
import org.java_websocket.handshake.ServerHandshake;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

/** 仅在管理员开启的通信期间采集、传输和播放；关闭、断网及超时均释放资源。 */
final class MediaSession {
    private final Context context;
    private final ReportPhotos photos;
    private final PairingStore store;
    private final Handler main=new Handler(Looper.getMainLooper());
    private final ExecutorService executor=Executors.newSingleThreadExecutor();
    private final Map<Integer,CompletableFuture<JSONObject>> waiting=new ConcurrentHashMap<>();
    private final AtomicInteger sequence=new AtomicInteger();
    private final AudioManager audio;
    private final android.content.SharedPreferences route;
    private WebSocketClient socket;
    private PeerConnectionFactory factory;
    private PeerConnection pc;
    private EglBase egl;
    private JavaAudioDeviceModule adm;
    private AudioSource audioSource;
    private AudioTrack audioTrack;
    private VideoSource videoSource;
    private VideoTrack videoTrack;
    private CameraVideoCapturer camera;
    private SurfaceTextureHelper texture;
    private MediaAlarm alarm;
    private volatile boolean closed=true;
    private volatile String id="",mode="",facing="front";
    private boolean subscribed,ready;
    private final Runnable timeout=()->stop("本次通信已到时");
    MediaSession(Context c,PairingStore s,ReportPhotos p){context=c.getApplicationContext();store=s;photos=p;audio=(AudioManager)c.getSystemService(Context.AUDIO_SERVICE);route=c.getSharedPreferences("media-route",0);restoreRoute();alarm=new MediaAlarm(context,main);}
    synchronized void receive(JSONObject offer){
        if(offer==null||System.currentTimeMillis()>offer.optLong("expires_at")||offer.optString("session_id").equals(id))return;
        if(!closed)return;
        id=offer.optString("session_id");mode=offer.optString("mode");facing=offer.optString("camera","front");closed=false;subscribed=false;ready=false;
        executor.execute(()->{try{
            String url=offer.getString("url");java.net.URI uri=new java.net.URI(url);
            if(!"wss".equals(uri.getScheme())||!new java.net.URI(Protocol.BASE_URL).getHost().equals(uri.getHost())||!"/api/elfremote/media/device".equals(uri.getPath()))throw new Exception("通信地址无效");
            WakeScheduler.hold(context,"media-session",1830000L);
            socket=new WebSocketClient(uri,Collections.singletonMap("Authorization","Bearer "+offer.getString("token"))){
                public void onOpen(ServerHandshake h){RuntimeLog.event("media_connected mode="+mode);}
                public void onMessage(String raw){
                    if(socket!=this||closed)return;
                    try{if(raw.length()>96000)throw new Exception("通信消息过大");JSONObject x=new JSONObject(raw);
                        if("rpc".equals(x.optString("type"))){CompletableFuture<JSONObject> f=waiting.remove(x.optInt("id"));if(f!=null){if(x.has("error"))f.completeExceptionally(new Exception(x.optString("error")));else f.complete(x.getJSONObject("result"));}}
                        else if("closed".equals(x.optString("type")))stop(x.optString("message"));
                        else executor.execute(()->{try{message(x);}catch(Exception|LinkageError e){fail(new Exception(e));}});
                    }catch(Exception e){fail(e);}
                }
                public void onClose(int code,String reason,boolean remote){if(socket==this)stop("通信已断开");}
                public void onError(Exception e){if(socket==this)fail(e);}
            };
            socket.setConnectionLostTimeout(20);socket.connect();main.postDelayed(timeout,45000);
        }catch(Exception e){fail(e);}});
    }
    private void message(JSONObject x)throws Exception {
        if(closed)return;
        switch(x.optString("type")){
            case "hello":
                if("photo".equals(mode)){
                    photos.manual(id,store.deviceId(),facing,(result,error)->{if(error!=null){fail(error);return;}send(result);});
                    send(new JSONObject().put("type","status").put("message","正在拍照").put("cameras",android.hardware.Camera.getNumberOfCameras()));markReady();
                }else if("alarm".equals(mode)){
                    if(alarm==null)alarm=new MediaAlarm(context,main);alarm.start();markReady();
                }else initializeRtc();
                break;
            case "tracks":if(!subscribed&&pc!=null){subscribed=true;JSONObject result=rpc("subscribe",new JSONObject());negotiate(result);}
                break;
            case "switch":
                if(camera!=null)camera.switchCamera(new CameraVideoCapturer.CameraSwitchHandler(){
                    public void onCameraSwitchDone(boolean front){facing=front?"front":"back";sendStatus();}
                    public void onCameraSwitchError(String error){sendMessage(error);}
                });
                break;
        }
    }
    private void initializeRtc()throws Exception{
        boolean capture=Arrays.asList("call","microphone","video").contains(mode);
        if(capture&&context.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)!=android.content.pm.PackageManager.PERMISSION_GRANTED)throw new Exception("麦克风权限初始化尚未完成");
        if(Arrays.asList("ptt","call").contains(mode)){
            if(!route.edit().putBoolean("saved",true).putInt("mode",audio.getMode()).putBoolean("speaker",audio.isSpeakerphoneOn()).putInt("volume",audio.getStreamVolume(AudioManager.STREAM_VOICE_CALL)).commit())throw new Exception("原音频设置保存失败");
            audio.setMode(AudioManager.MODE_IN_COMMUNICATION);audio.setSpeakerphoneOn(true);audio.setStreamVolume(AudioManager.STREAM_VOICE_CALL,audio.getStreamMaxVolume(AudioManager.STREAM_VOICE_CALL),0);
        }
        PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context).setNativeLibraryLoader(new NativeMediaLibrary(context)).createInitializationOptions());
        final String owner=id;
        egl=EglBase.create();adm=JavaAudioDeviceModule.builder(context)
            .setAudioRecordErrorCallback(new JavaAudioDeviceModule.AudioRecordErrorCallback(){
                public void onWebRtcAudioRecordInitError(String e){audioFailure(owner,"麦克风初始化失败",e);}
                public void onWebRtcAudioRecordStartError(JavaAudioDeviceModule.AudioRecordStartErrorCode c,String e){audioFailure(owner,"麦克风启动失败",e);}
                public void onWebRtcAudioRecordError(String e){audioFailure(owner,"麦克风采集失败",e);}
            }).setAudioTrackErrorCallback(new JavaAudioDeviceModule.AudioTrackErrorCallback(){
                public void onWebRtcAudioTrackInitError(String e){audioFailure(owner,"扬声器初始化失败",e);}
                public void onWebRtcAudioTrackStartError(JavaAudioDeviceModule.AudioTrackStartErrorCode c,String e){audioFailure(owner,"扬声器启动失败",e);}
                public void onWebRtcAudioTrackError(String e){audioFailure(owner,"扬声器播放失败",e);}
            }).createAudioDeviceModule();
        factory=PeerConnectionFactory.builder().setAudioDeviceModule(adm).setVideoEncoderFactory(new DefaultVideoEncoderFactory(egl.getEglBaseContext(),true,true)).setVideoDecoderFactory(new DefaultVideoDecoderFactory(egl.getEglBaseContext())).createPeerConnectionFactory();
        PeerConnection.RTCConfiguration config=new PeerConnection.RTCConfiguration(Collections.singletonList(PeerConnection.IceServer.builder("stun:stun.cloudflare.com:3478").createIceServer()));
        config.sdpSemantics=PeerConnection.SdpSemantics.UNIFIED_PLAN;
        pc=factory.createPeerConnection(config,new PeerConnection.Observer(){
            public void onSignalingChange(PeerConnection.SignalingState s){}
            public void onIceConnectionChange(PeerConnection.IceConnectionState s){if(s==PeerConnection.IceConnectionState.FAILED)stop("媒体网络连接失败");if(s==PeerConnection.IceConnectionState.CONNECTED||s==PeerConnection.IceConnectionState.COMPLETED)markReady();}
            public void onIceConnectionReceivingChange(boolean v){}
            public void onIceGatheringChange(PeerConnection.IceGatheringState s){}
            public void onIceCandidate(IceCandidate c){}
            public void onIceCandidatesRemoved(IceCandidate[] c){}
            public void onAddStream(MediaStream s){}
            public void onRemoveStream(MediaStream s){}
            public void onDataChannel(DataChannel c){}
            public void onRenegotiationNeeded(){}
            public void onAddTrack(RtpReceiver r,MediaStream[] streams){if(r.track()!=null)r.track().setEnabled(true);}
        });
        if(pc==null)throw new Exception("实时媒体初始化失败");
        if(capture){audioSource=factory.createAudioSource(new MediaConstraints());audioTrack=factory.createAudioTrack("audio",audioSource);pc.addTransceiver(audioTrack,new RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY));}
        if("video".equals(mode))startCamera();
        rpc("new",new JSONObject());
        if(capture){SessionDescription offer=create(true);set(offer,true);awaitIce();JSONArray tracks=new JSONArray();
            for(RtpTransceiver t:pc.getTransceivers()){MediaStreamTrack track=t.getSender().track();if(track!=null)tracks.put(new JSONObject().put("mid",t.getMid()).put("trackName",track.kind()));}
            JSONObject result=rpc("publish",new JSONObject().put("sessionDescription",description(pc.getLocalDescription())).put("tracks",tracks));
            set(parse(result.getJSONObject("sessionDescription")),false);rpc("published",new JSONObject());
        }
        sendStatus();
    }
    private void startCamera()throws Exception{
        if(context.checkSelfPermission(android.Manifest.permission.CAMERA)!=android.content.pm.PackageManager.PERMISSION_GRANTED)throw new Exception("相机权限初始化尚未完成");
        Camera1Enumerator cameras=new Camera1Enumerator(false);String selected=null;
        for(String name:cameras.getDeviceNames())if("front".equals(facing)?cameras.isFrontFacing(name):cameras.isBackFacing(name)){selected=name;break;}
        if(selected==null&&cameras.getDeviceNames().length>0)selected=cameras.getDeviceNames()[0];
        if(selected==null)throw new Exception("没有可用摄像头");
        camera=cameras.createCapturer(selected,null);videoSource=factory.createVideoSource(false);texture=SurfaceTextureHelper.create("elfremote-camera",egl.getEglBaseContext());
        camera.initialize(texture,context,videoSource.getCapturerObserver());
        ConnectivityManager cm=(ConnectivityManager)context.getSystemService(Context.CONNECTIVITY_SERVICE);NetworkCapabilities caps=cm.getNetworkCapabilities(cm.getActiveNetwork());boolean wifi=caps!=null&&caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI);
        camera.startCapture(wifi?640:320,wifi?480:240,wifi?15:10);videoTrack=factory.createVideoTrack("video",videoSource);
        RtpTransceiver tx=pc.addTransceiver(videoTrack,new RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY));
        java.util.List<RtpCapabilities.CodecCapability> codecs=new java.util.ArrayList<>(factory.getRtpSenderCapabilities(MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO).codecs);
        codecs.sort((a,b)->Boolean.compare(!"H264".equalsIgnoreCase(a.name),!"H264".equalsIgnoreCase(b.name)));tx.setCodecPreferences(codecs);
        RtpParameters params=tx.getSender().getParameters();for(RtpParameters.Encoding e:params.encodings){e.maxBitrateBps=wifi?600000:180000;e.maxFramerate=wifi?15:10;}tx.getSender().setParameters(params);
    }
    private void negotiate(JSONObject result)throws Exception{
        if(!result.has("sessionDescription"))return;
        SessionDescription remote=parse(result.getJSONObject("sessionDescription"));set(remote,false);
        if(remote.type==SessionDescription.Type.OFFER){set(create(false),true);awaitIce();rpc("answer",new JSONObject().put("sessionDescription",description(pc.getLocalDescription())));}
    }
    private JSONObject rpc(String action,JSONObject body)throws Exception{
        if(closed)throw new Exception("通信已结束");int n=sequence.incrementAndGet();CompletableFuture<JSONObject> f=new CompletableFuture<>();waiting.put(n,f);
        send(new JSONObject().put("type","rpc").put("id",n).put("action",action).put("body",body));try{return f.get(20,TimeUnit.SECONDS);}finally{waiting.remove(n);}
    }
    private void awaitIce()throws Exception{long end=SystemClock.elapsedRealtime()+7000;while(!closed&&pc.iceGatheringState()!=PeerConnection.IceGatheringState.COMPLETE&&SystemClock.elapsedRealtime()<end)Thread.sleep(50);}
    private SessionDescription create(boolean offer)throws Exception{
        CompletableFuture<SessionDescription> f=new CompletableFuture<>();SdpObserver o=new SdpAdapter(){public void onCreateSuccess(SessionDescription d){f.complete(d);}public void onCreateFailure(String e){f.completeExceptionally(new Exception(e));}};
        if(offer)pc.createOffer(o,new MediaConstraints());else pc.createAnswer(o,new MediaConstraints());return f.get(10,TimeUnit.SECONDS);
    }
    private void set(SessionDescription d,boolean local)throws Exception{
        CompletableFuture<Void> f=new CompletableFuture<>();SdpObserver o=new SdpAdapter(){public void onSetSuccess(){f.complete(null);}public void onSetFailure(String e){f.completeExceptionally(new Exception(e));}};
        if(local)pc.setLocalDescription(o,d);else pc.setRemoteDescription(o,d);f.get(10,TimeUnit.SECONDS);
    }
    private static JSONObject description(SessionDescription d)throws Exception{return new JSONObject().put("type",d.type.canonicalForm()).put("sdp",d.description);}
    private static SessionDescription parse(JSONObject x)throws Exception{return new SessionDescription(SessionDescription.Type.fromCanonicalForm(x.getString("type")),x.getString("sdp"));}
    private void send(JSONObject x){WebSocketClient ws=socket;if(!closed&&ws!=null&&ws.isOpen())ws.send(x.toString());}
    private void sendStatus(){try{send(new JSONObject().put("type","status").put("camera",facing).put("cameras",android.hardware.Camera.getNumberOfCameras()));}catch(Exception e){fail(e);}}
    private void sendMessage(String text){try{send(new JSONObject().put("type","status").put("message",text));}catch(Exception ignored){}}
    private synchronized void markReady(){if(closed||ready)return;ready=true;main.removeCallbacks(timeout);if(!"alarm".equals(mode))main.postDelayed(timeout,"ptt".equals(mode)?60000:"photo".equals(mode)?60000:1800000);try{send(new JSONObject().put("type","ready"));}catch(Exception e){fail(e);}}
    private void audioFailure(String owner,String operation,String detail){if(!closed&&owner.equals(id))fail(new Exception(operation+"："+detail));}
    private void fail(Exception e){RuntimeLog.error("media_failed",e);sendMessage("通信失败："+e.getMessage());stop("通信失败");}
    private void restoreRoute(){if(route.getBoolean("saved",false)){audio.setStreamVolume(AudioManager.STREAM_VOICE_CALL,route.getInt("volume",0),0);audio.setSpeakerphoneOn(route.getBoolean("speaker",false));audio.setMode(route.getInt("mode",AudioManager.MODE_NORMAL));route.edit().clear().commit();}}
    synchronized void stop(String reason){
        if(closed)return;closed=true;main.removeCallbacks(timeout);for(CompletableFuture<JSONObject> f:waiting.values())f.completeExceptionally(new Exception(reason));waiting.clear();
        WebSocketClient ws=socket;socket=null;if(ws!=null)try{ws.close();}catch(Exception ignored){}
        executor.execute(()->{
            try{if(alarm!=null){alarm.close();alarm=null;}if(camera!=null){try{camera.stopCapture();}catch(Exception ignored){}camera.dispose();camera=null;}if(pc!=null){pc.close();pc.dispose();pc=null;}
                if(videoTrack!=null){videoTrack.dispose();videoTrack=null;}if(videoSource!=null){videoSource.dispose();videoSource=null;}if(texture!=null){texture.dispose();texture=null;}
                if(audioTrack!=null){audioTrack.dispose();audioTrack=null;}if(audioSource!=null){audioSource.dispose();audioSource=null;}if(factory!=null){factory.dispose();factory=null;}if(adm!=null){adm.release();adm=null;}if(egl!=null){egl.release();egl=null;}
            }catch(Exception e){RuntimeLog.error("media_cleanup_failed",e);}finally{restoreRoute();WakeScheduler.release("media-session");RuntimeLog.event("media_stopped");}
        });
    }
    private static class SdpAdapter implements SdpObserver {public void onCreateSuccess(SessionDescription d){}public void onSetSuccess(){}public void onCreateFailure(String e){}public void onSetFailure(String e){}}
}
