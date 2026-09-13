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
    private volatile boolean closed=true,closing;
    private long receivedAt;
    private volatile String id="",mode="",facing="front";
    private volatile boolean subscribed,published,iceConnected,ready,prepared,transportReady;
    private volatile long operation;
    private volatile String phase="closed";
    private volatile boolean captureStarted,playbackStarted,videoStarted;
    private long syntheticAudioDue;
    private final Runnable placeholderVideo=new Runnable(){public void run(){
        if(closed||!prepared||videoSource==null)return;
        if(!"video".equals(mode)){
            JavaI420Buffer buffer=JavaI420Buffer.allocate(160,120);
            fill(buffer.getDataY(),(byte)16);fill(buffer.getDataU(),(byte)128);fill(buffer.getDataV(),(byte)128);
            VideoFrame frame=new VideoFrame(buffer,0,SystemClock.elapsedRealtimeNanos());
            try{videoSource.getCapturerObserver().onFrameCaptured(frame);}finally{frame.release();}
        }
        main.postDelayed(this,1000L);
    }};
    private static void fill(java.nio.ByteBuffer b,byte value){for(int i=0;i<b.capacity();i++)b.put(i,value);}
    private final Runnable connectionLease=new Runnable(){public void run(){if(closed||!prepared)return;WakeScheduler.hold(context,"media-session",60000L);main.postDelayed(this,30000L);}};
    private final AudioManager.OnAudioFocusChangeListener focusChange=change->{if(change==AudioManager.AUDIOFOCUS_LOSS)stop("音频已由其他应用接管");};
    private boolean focused;
    private final Runnable timeout=()->stop("本次通信已到时");
    MediaSession(Context c,PairingStore s,ReportPhotos p){context=c.getApplicationContext();store=s;photos=p;audio=(AudioManager)c.getSystemService(Context.AUDIO_SERVICE);route=c.getSharedPreferences("media-route",0);restoreRoute();alarm=new MediaAlarm(context,main);}
    synchronized void receive(JSONObject offer){
        if(offer==null||System.currentTimeMillis()>offer.optLong("expires_at")||offer.optString("session_id").equals(id))return;
        if(closing){main.postDelayed(()->receive(offer),100);return;}
        if(!closed)return;
        sampleMeters.clear();receivedAt=SystemClock.elapsedRealtime();id=offer.optString("session_id");mode=offer.optString("mode");facing=offer.optString("camera","front");closed=false;subscribed=false;ready=false;
        prepared="prepare".equals(mode);phase=prepared?"preparing":"active";operation=0;published=false;iceConnected=false;transportReady=false;captureStarted=false;playbackStarted=false;videoStarted=false;
        final String owner=id;
        executor.execute(()->{try{
            String url=offer.getString("url");java.net.URI uri=new java.net.URI(url);
            if(!"wss".equals(uri.getScheme())||!new java.net.URI(Protocol.BASE_URL).getHost().equals(uri.getHost())||!"/api/elfremote/media/device".equals(uri.getPath()))throw new Exception("通信地址无效");
            WakeScheduler.hold(context,"media-session",1830000L);
            if(prepared)main.post(connectionLease);
            socket=new WebSocketClient(uri,Collections.singletonMap("Authorization","Bearer "+offer.getString("token"))){
                public void onOpen(ServerHandshake h){RuntimeLog.event("media_connected mode="+mode);}
                public void onMessage(String raw){
                    if(socket!=this||closed)return;
                    try{if(raw.length()>96000)throw new Exception("通信消息过大");JSONObject x=new JSONObject(raw);
                        if("rpc".equals(x.optString("type"))){CompletableFuture<JSONObject> f=waiting.remove(x.optInt("id"));if(f!=null){if(x.has("error"))f.completeExceptionally(new Exception(x.optString("error")));else f.complete(x.getJSONObject("result"));}}
                        else if("closed".equals(x.optString("type")))stop(x.optString("message"));
                        else executor.execute(()->{if(closed||!owner.equals(id))return;try{message(x);}catch(Exception|LinkageError e){fail(new Exception(e));}});
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
                    final String photoOwner=id;photos.manual(id,store.deviceId(),facing,(result,error)->{if(closed||!photoOwner.equals(id))return;if(error!=null){fail(error);return;}send(result);});
                    send(new JSONObject().put("type","status").put("message","正在拍照").put("cameras",android.hardware.Camera.getNumberOfCameras()));markReady();
                }else if("alarm".equals(mode)){
                    if(alarm==null)alarm=new MediaAlarm(context,main);alarm.start();markReady();
                }else initializeRtc();
                break;
            case "tracks":if(!subscribed&&pc!=null){JSONObject result=rpc("subscribe",new JSONObject());negotiate(result);subscribed=true;checkReady();}
                break;
            case "activate":if(prepared)activate(x);break;
            case "deactivate":if(prepared)deactivate(x.optLong("operation",-1));break;
            case "switch":
                if(prepared&&(x.optLong("operation",-1)!=operation||!"active".equals(phase)))break;
                if(camera!=null)camera.switchCamera(new CameraVideoCapturer.CameraSwitchHandler(){
                    public void onCameraSwitchDone(boolean front){facing=front?"front":"back";sendStatus();}
                    public void onCameraSwitchError(String error){sendMessage(error);}
                });
                break;
        }
    }
    private void initializeRtc()throws Exception{
        boolean capture=prepared||Arrays.asList("call","microphone","video").contains(mode);
        if(capture&&!prepared&&context.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)!=android.content.pm.PackageManager.PERMISSION_GRANTED)throw new Exception("麦克风权限初始化尚未完成");
        if(Arrays.asList("ptt","call").contains(mode))activateAudioRoute();
        PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context).setNativeLibraryLoader(new NativeMediaLibrary(context)).createInitializationOptions());
        final String owner=id;
        egl=EglBase.create();adm=JavaAudioDeviceModule.builder(context)
            .setAudioSource(android.media.MediaRecorder.AudioSource.MIC)
            .setAudioAttributes(new android.media.AudioAttributes.Builder().setUsage(prepared?android.media.AudioAttributes.USAGE_MEDIA:"call".equals(mode)?android.media.AudioAttributes.USAGE_VOICE_COMMUNICATION:android.media.AudioAttributes.USAGE_MEDIA).setContentType(android.media.AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setUseLowLatency(true)
            .setEnableVolumeLogger(false)
            .setUseHardwareAcousticEchoCanceler(false)
            .setUseHardwareNoiseSuppressor(false)
            .setSamplesReadyCallback(samples->audioSamples(owner,"capture",samples.getData()))
            .setPlaybackSamplesReadyCallback(samples->audioSamples(owner,"playback",samples.getData()))
            .setAudioBufferCallback((buffer,format,channels,rate,bytesRead,at)->{
                if(prepared){
                    if(bytesRead==0){
                        long now=SystemClock.elapsedRealtimeNanos();syntheticAudioDue=Math.max(syntheticAudioDue+10000000L,now);
                        java.util.concurrent.locks.LockSupport.parkNanos(Math.max(0,syntheticAudioDue-now));
                        captureStarted=false;return SystemClock.elapsedRealtimeNanos();
                    }
                    syntheticAudioDue=0;
                    if(owns(owner,operation)&&Arrays.asList("call","microphone","video").contains(mode)){captureStarted=true;checkReady();}
                }
                return at;
            })
            .setAudioRecordStateCallback(new JavaAudioDeviceModule.AudioRecordStateCallback(){
                public void onWebRtcAudioRecordStart(){if(!prepared&&!closed&&owner.equals(id)){captureStarted=true;checkReady();}}
                public void onWebRtcAudioRecordStop(){captureStarted=false;}
            }).setAudioTrackStateCallback(new JavaAudioDeviceModule.AudioTrackStateCallback(){
                public void onWebRtcAudioTrackStart(){if(!closed&&owner.equals(id)){playbackStarted=true;checkReady();}}
                public void onWebRtcAudioTrackStop(){playbackStarted=false;}
            })
            .setAudioRecordErrorCallback(new JavaAudioDeviceModule.AudioRecordErrorCallback(){
                public void onWebRtcAudioRecordInitError(String e){audioFailure(owner,"麦克风初始化失败",e);}
                public void onWebRtcAudioRecordStartError(JavaAudioDeviceModule.AudioRecordStartErrorCode c,String e){audioFailure(owner,"麦克风启动失败",e);}
                public void onWebRtcAudioRecordError(String e){audioFailure(owner,"麦克风采集失败",e);}
            }).setAudioTrackErrorCallback(new JavaAudioDeviceModule.AudioTrackErrorCallback(){
                public void onWebRtcAudioTrackInitError(String e){audioFailure(owner,"扬声器初始化失败",e);}
                public void onWebRtcAudioTrackStartError(JavaAudioDeviceModule.AudioTrackStartErrorCode c,String e){audioFailure(owner,"扬声器启动失败",e);}
                public void onWebRtcAudioTrackError(String e){audioFailure(owner,"扬声器播放失败",e);}
            }).createAudioDeviceModule();
        if(prepared)adm.setAudioRecordEnabled(false);
        for(android.media.AudioDeviceInfo input:audio.getDevices(AudioManager.GET_DEVICES_INPUTS))if(input.getType()==android.media.AudioDeviceInfo.TYPE_BUILTIN_MIC){adm.setPreferredInputDevice(input);break;}
        factory=PeerConnectionFactory.builder().setAudioDeviceModule(adm).setVideoEncoderFactory(new DefaultVideoEncoderFactory(egl.getEglBaseContext(),true,true)).setVideoDecoderFactory(new DefaultVideoDecoderFactory(egl.getEglBaseContext())).createPeerConnectionFactory();
        PeerConnection.RTCConfiguration config=new PeerConnection.RTCConfiguration(Collections.singletonList(PeerConnection.IceServer.builder("stun:stun.cloudflare.com:3478").createIceServer()));
        config.sdpSemantics=PeerConnection.SdpSemantics.UNIFIED_PLAN;
        pc=factory.createPeerConnection(config,new PeerConnection.Observer(){
            public void onSignalingChange(PeerConnection.SignalingState s){}
            public void onIceConnectionChange(PeerConnection.IceConnectionState s){if(closed||!owner.equals(id))return;RuntimeLog.event("media_ice state="+s+" after_ms="+(SystemClock.elapsedRealtime()-receivedAt));if(s==PeerConnection.IceConnectionState.FAILED)stop("媒体网络连接失败");iceConnected=s==PeerConnection.IceConnectionState.CONNECTED||s==PeerConnection.IceConnectionState.COMPLETED;if(iceConnected)checkReady();}
            public void onIceConnectionReceivingChange(boolean v){}
            public void onIceGatheringChange(PeerConnection.IceGatheringState s){}
            public void onIceCandidate(IceCandidate c){}
            public void onIceCandidatesRemoved(IceCandidate[] c){}
            public void onAddStream(MediaStream s){}
            public void onRemoveStream(MediaStream s){}
            public void onDataChannel(DataChannel c){}
            public void onRenegotiationNeeded(){}
            public void onAddTrack(RtpReceiver r,MediaStream[] streams){if(!closed&&owner.equals(id)&&r.track()!=null)r.track().setEnabled(!prepared);}
        });
        if(pc==null)throw new Exception("实时媒体初始化失败");
        pc.setAudioRecording(capture);pc.setAudioPlayout(!prepared&&Arrays.asList("ptt","call").contains(mode));
        if(capture){MediaConstraints constraints=new MediaConstraints();
            for(String key:new String[]{"googEchoCancellation","googNoiseSuppression","googHighpassFilter"})constraints.mandatory.add(new MediaConstraints.KeyValuePair(key,prepared||"call".equals(mode)?"true":"false"));
            audioSource=factory.createAudioSource(constraints);audioTrack=factory.createAudioTrack("audio",audioSource);audioTrack.setEnabled(true);pc.addTransceiver(audioTrack,new RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY));}
        if(prepared)createVideoTrack();else if("video".equals(mode))startCamera();
        rpc("new",new JSONObject());
        if(capture){SessionDescription offer=create(true);set(offer,true);JSONArray tracks=new JSONArray();
            for(RtpTransceiver t:pc.getTransceivers()){MediaStreamTrack track=t.getSender().track();if(track!=null)tracks.put(new JSONObject().put("mid",t.getMid()).put("trackName",track.kind()));}
            JSONObject result=rpc("publish",new JSONObject().put("sessionDescription",description(pc.getLocalDescription())).put("tracks",tracks));
            set(parse(result.getJSONObject("sessionDescription")),false);rpc("published",new JSONObject());published=true;
        }
        if(!prepared)sendStatus();checkReady();
    }
    private void activateAudioRoute()throws Exception{
            if(route.getBoolean("saved",false)){restoreRoute();if(route.getBoolean("saved",false))throw new Exception("前次音频设置尚未恢复");}
            if(!route.edit().clear().putBoolean("saved",true).putInt("mode",audio.getMode()).putBoolean("speaker",audio.isSpeakerphoneOn()).putInt("music",audio.getStreamVolume(AudioManager.STREAM_MUSIC)).putBoolean("music_muted",audio.isStreamMute(AudioManager.STREAM_MUSIC)).commit())throw new Exception("原音频设置保存失败");
            focused=audio.requestAudioFocus(focusChange,AudioManager.STREAM_MUSIC,AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)==AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
            if(!focused)throw new Exception("扬声器正被其他应用占用");
            audio.setMode("ptt".equals(mode)?AudioManager.MODE_NORMAL:AudioManager.MODE_IN_COMMUNICATION);audio.setSpeakerphoneOn(true);
            // 先切到扬声器，再保存该路由的通话音量；不能把听筒音量恢复到扬声器。
            if(!route.edit().putInt("volume",audio.getStreamVolume(AudioManager.STREAM_VOICE_CALL)).putBoolean("voice_muted",audio.isStreamMute(AudioManager.STREAM_VOICE_CALL)).commit())throw new Exception("扬声器音量保存失败");
            audio.setStreamVolume(AudioManager.STREAM_VOICE_CALL,audio.getStreamMaxVolume(AudioManager.STREAM_VOICE_CALL),0);
            audio.setStreamVolume(AudioManager.STREAM_MUSIC,audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC),0);
            audio.adjustStreamVolume(AudioManager.STREAM_VOICE_CALL,AudioManager.ADJUST_UNMUTE,0);
            audio.adjustStreamVolume(AudioManager.STREAM_MUSIC,AudioManager.ADJUST_UNMUTE,0);
    }
    private void startCamera()throws Exception{
        if(context.checkSelfPermission(android.Manifest.permission.CAMERA)!=android.content.pm.PackageManager.PERMISSION_GRANTED)throw new Exception("相机权限初始化尚未完成");
        Camera1Enumerator cameras=new Camera1Enumerator(false);String selected=null;
        for(String name:cameras.getDeviceNames())if("front".equals(facing)?cameras.isFrontFacing(name):cameras.isBackFacing(name)){selected=name;break;}
        if(selected==null&&cameras.getDeviceNames().length>0)selected=cameras.getDeviceNames()[0];
        if(selected==null)throw new Exception("没有可用摄像头");
        if(videoSource==null)createVideoTrack();
        camera=cameras.createCapturer(selected,null);texture=SurfaceTextureHelper.create("elfremote-camera",egl.getEglBaseContext());
        final String owner=id;final long op=operation;final CapturerObserver observer=videoSource.getCapturerObserver();
        camera.initialize(texture,context,new CapturerObserver(){
            public void onCapturerStarted(boolean success){observer.onCapturerStarted(success);}
            public void onCapturerStopped(){observer.onCapturerStopped();}
            public void onFrameCaptured(VideoFrame frame){if(closed||!owner.equals(id)||op!=operation||prepared&&!"active".equals(phase))return;observer.onFrameCaptured(frame);videoStarted=true;checkReady();}
        });
        ConnectivityManager cm=(ConnectivityManager)context.getSystemService(Context.CONNECTIVITY_SERVICE);NetworkCapabilities caps=cm.getNetworkCapabilities(cm.getActiveNetwork());boolean wifi=caps!=null&&caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI);
        videoTrack.setEnabled(true);camera.startCapture(wifi?640:320,wifi?480:240,wifi?15:10);
        RtpTransceiver tx=null;for(RtpTransceiver t:pc.getTransceivers())if(t.getSender().track()!=null&&"video".equals(t.getSender().track().kind())){tx=t;break;}
        if(tx==null)throw new Exception("视频轨道未协商");
        RtpParameters params=tx.getSender().getParameters();for(RtpParameters.Encoding e:params.encodings){e.maxBitrateBps=wifi?600000:180000;e.maxFramerate=wifi?15:10;}tx.getSender().setParameters(params);
    }
    private void createVideoTrack(){
        videoSource=factory.createVideoSource(false);videoTrack=factory.createVideoTrack("video",videoSource);videoTrack.setEnabled(prepared);
        RtpTransceiver tx=pc.addTransceiver(videoTrack,new RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY));
        java.util.List<RtpCapabilities.CodecCapability> codecs=new java.util.ArrayList<>(factory.getRtpSenderCapabilities(MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO).codecs);
        codecs.sort((a,b)->Boolean.compare(!"H264".equalsIgnoreCase(a.name),!"H264".equalsIgnoreCase(b.name)));tx.setCodecPreferences(codecs);
        if(prepared){videoSource.getCapturerObserver().onCapturerStarted(true);main.post(placeholderVideo);}
    }
    private void activate(JSONObject x)throws Exception{
        long next=x.optLong("operation",-1);String requested=x.optString("mode");
        if(!transportReady||!"idle".equals(phase)||next!=operation+1||!Arrays.asList("ptt","call","microphone","video","photo","alarm").contains(requested))throw new Exception("操作状态无效");
        if(!Arrays.asList("front","back").contains(x.optString("camera")))throw new Exception("摄像头方向无效");
        operation=next;mode=requested;facing=x.getString("camera");phase="active";ready=false;receivedAt=SystemClock.elapsedRealtime();
        captureStarted=false;playbackStarted=false;videoStarted=false;sampleMeters.clear();
        main.removeCallbacks(timeout);main.postDelayed(timeout,17000L);
        RuntimeLog.event("media_activate mode="+mode+" operation="+operation);
        boolean capture=Arrays.asList("call","microphone","video").contains(mode),playback=Arrays.asList("ptt","call").contains(mode);
        if(capture&&context.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)!=android.content.pm.PackageManager.PERMISSION_GRANTED)throw new Exception("麦克风权限尚未就绪");
        if(playback)activateAudioRoute();
        adm.setMicrophoneMute(false);adm.setSpeakerMute(false);
        adm.setAudioRecordEnabled(capture);for(RtpReceiver receiver:pc.getReceivers())if(receiver.track()!=null)receiver.track().setEnabled(playback);
        pc.setAudioPlayout(playback);
        if("video".equals(mode))startCamera();
        if("photo".equals(mode)){
            String expected=id+"-"+operation;if(!expected.equals(x.optString("report_id")))throw new Exception("照片操作编号不匹配");
            final String owner=id;final long op=operation;
            photos.manual(expected,store.deviceId(),facing,new ReportPhotos.ManualResult(){
                public void captured(byte[] bytes,long capturedAt){if(!owns(owner,op))return;try{if(bytes.length<=66000)send(new JSONObject().put("type","photo_preview").put("operation",op).put("jpeg",android.util.Base64.encodeToString(bytes,android.util.Base64.NO_WRAP)).put("captured_at",capturedAt));}catch(Exception e){fail(e);}}
                public void complete(JSONObject result,Exception error){if(!owns(owner,op))return;if(error!=null){fail(error);return;}try{send(result.put("operation",op));}catch(Exception e){fail(e);}}
            });markReady();
        }else if("alarm".equals(mode)){if(alarm==null)alarm=new MediaAlarm(context,main);alarm.start();markReady();}
        sendStatus();checkReady();
    }
    private boolean owns(String owner,long op){return !closed&&owner.equals(id)&&operation==op&&"active".equals(phase);}
    private void deactivate(long op)throws Exception{
        if(op!=operation)return;
        if("idle".equals(phase)){send(new JSONObject().put("type","idle").put("operation",operation));return;}
        if(!"active".equals(phase))return;
        phase="stopping";ready=false;main.removeCallbacks(timeout);
        adm.setAudioRecordEnabled(false);pc.setAudioPlayout(false);
        long audioDeadline=SystemClock.elapsedRealtime()+2000L;
        while((captureStarted||playbackStarted)&&SystemClock.elapsedRealtime()<audioDeadline)Thread.sleep(10L);
        if(captureStarted||playbackStarted)throw new Exception("音频硬件停止未确认");
        for(RtpReceiver receiver:pc.getReceivers())if(receiver.track()!=null)receiver.track().setEnabled(false);
        if(camera!=null){camera.stopCapture();camera.dispose();camera=null;videoSource.getCapturerObserver().onCapturerStarted(true);}
        if(texture!=null){texture.dispose();texture=null;}
        if(alarm!=null){alarm.close();alarm=null;}
        if("photo".equals(mode))photos.cancelManual(id+"-"+operation).get(8,TimeUnit.SECONDS);
        restoreRoute();if(route.getBoolean("saved",false))throw new Exception("音频设置恢复未完成");
        if(focused){audio.abandonAudioFocus(focusChange);focused=false;}
        captureStarted=false;playbackStarted=false;videoStarted=false;mode="prepare";phase="idle";
        RuntimeLog.event("media_idle operation="+operation);send(new JSONObject().put("type","idle").put("operation",operation));
    }
    private synchronized void checkReady(){
        if(closed)return;
        if(prepared&&!transportReady){
            if(!published||!subscribed||!iceConnected)return;
            if(captureStarted||playbackStarted){fail(new Exception("待命阶段意外开启音频硬件"));return;}
            transportReady=true;phase="idle";main.removeCallbacks(timeout);
            RuntimeLog.event("media_transport_ready after_ms="+(SystemClock.elapsedRealtime()-receivedAt));
            try{send(new JSONObject().put("type","transport_ready"));}catch(Exception e){fail(e);}return;
        }
        if(prepared&&!"active".equals(phase)||!iceConnected)return;
        if("ptt".equals(mode)&&(!subscribed||!playbackStarted))return;
        if("call".equals(mode)&&(!published||!subscribed||!playbackStarted||!captureStarted))return;
        if(Arrays.asList("microphone","video").contains(mode)&&(!published||!captureStarted))return;
        if("video".equals(mode)&&!videoStarted)return;
        if(!Arrays.asList("prepare","photo","alarm").contains(mode))markReady();
    }
    private void negotiate(JSONObject result)throws Exception{
        if(!result.has("sessionDescription"))return;
        SessionDescription remote=parse(result.getJSONObject("sessionDescription"));set(remote,false);
        if(remote.type==SessionDescription.Type.OFFER){set(create(false),true);rpc("answer",new JSONObject().put("sessionDescription",description(pc.getLocalDescription())));}
    }
    private JSONObject rpc(String action,JSONObject body)throws Exception{
        if(closed)throw new Exception("通信已结束");int n=sequence.incrementAndGet();CompletableFuture<JSONObject> f=new CompletableFuture<>();waiting.put(n,f);
        send(new JSONObject().put("type","rpc").put("id",n).put("action",action).put("body",body));try{return f.get(20,TimeUnit.SECONDS);}finally{waiting.remove(n);}
    }
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
    private JSONObject operationMessage(String type)throws Exception{JSONObject x=new JSONObject().put("type",type);if(prepared)x.put("operation",operation);return x;}
    private void sendStatus(){try{send(operationMessage("status").put("camera",facing).put("cameras",android.hardware.Camera.getNumberOfCameras()));}catch(Exception e){fail(e);}}
    private void sendMessage(String text){try{send(operationMessage("status").put("message",text));}catch(Exception ignored){}}
    private synchronized void markReady(){if(closed||ready||prepared&&!"active".equals(phase))return;ready=true;RuntimeLog.event("media_ready mode="+mode+" operation="+operation+" after_ms="+(SystemClock.elapsedRealtime()-receivedAt));main.removeCallbacks(timeout);if(!"alarm".equals(mode))main.postDelayed(timeout,("ptt".equals(mode)?60000:"photo".equals(mode)?60000:1800000)+(prepared?2000:0));try{send(operationMessage("ready"));}catch(Exception e){fail(e);}}
    private final Map<String,MediaAudioMeter> sampleMeters=new ConcurrentHashMap<>();
    private void audioSamples(String owner,String kind,byte[] bytes){
        if(closed||!owner.equals(id)||bytes==null||bytes.length<2)return;
        if(prepared&&!"active".equals(phase))return;
        String sample=sampleMeters.computeIfAbsent(kind,k->new MediaAudioMeter()).add(bytes,SystemClock.elapsedRealtime());
        if(sample!=null)RuntimeLog.event("media_audio "+kind+" "+sample);
    }
    private void audioFailure(String owner,String operation,String detail){if(!closed&&owner.equals(id))fail(new Exception(operation+"："+detail));}
    private void fail(Exception e){RuntimeLog.error("media_failed",e);sendMessage("通信失败："+e.getMessage());stop("通信失败");}
    private void restoreRoute(){
        if(!route.getBoolean("saved",false))return;
        // 分别恢复，单项失败不能阻止其余恢复；保留快照供下次服务启动重试。
        boolean ok=true;
        try{if(route.contains("volume")){audio.setSpeakerphoneOn(true);audio.setStreamVolume(AudioManager.STREAM_VOICE_CALL,route.getInt("volume",0),0);if(route.getBoolean("voice_muted",false))audio.adjustStreamVolume(AudioManager.STREAM_VOICE_CALL,AudioManager.ADJUST_MUTE,0);}}catch(Exception e){ok=false;RuntimeLog.error("media_restore_voice",e);}
        try{if(route.contains("music")){audio.setStreamVolume(AudioManager.STREAM_MUSIC,route.getInt("music",0),0);if(route.getBoolean("music_muted",false))audio.adjustStreamVolume(AudioManager.STREAM_MUSIC,AudioManager.ADJUST_MUTE,0);}}catch(Exception e){ok=false;RuntimeLog.error("media_restore_music",e);}
        try{audio.setMode(route.getInt("mode",AudioManager.MODE_NORMAL));audio.setSpeakerphoneOn(route.getBoolean("speaker",false));}catch(Exception e){ok=false;RuntimeLog.error("media_restore_route",e);}
        if(ok)route.edit().clear().commit();
    }
    private void cleanup(String name,Runnable action){try{action.run();}catch(Exception|LinkageError e){RuntimeLog.error("media_cleanup_"+name,new Exception(e));}}
    synchronized void stop(String reason){
        if(closed)return;closed=true;closing=true;phase="closed";main.removeCallbacks(timeout);main.removeCallbacks(connectionLease);main.removeCallbacks(placeholderVideo);for(CompletableFuture<JSONObject> f:waiting.values())f.completeExceptionally(new Exception(reason));waiting.clear();
        if("photo".equals(mode))photos.cancelManual(prepared?id+"-"+operation:id);
        WebSocketClient ws=socket;socket=null;if(ws!=null)try{ws.close();}catch(Exception ignored){}
        executor.execute(()->{
            try{
                if(alarm!=null){cleanup("alarm",alarm::close);alarm=null;}
                if(camera!=null){try{camera.stopCapture();}catch(Exception e){RuntimeLog.error("media_cleanup_camera_stop",e);}cleanup("camera",camera::dispose);camera=null;}
                if(pc!=null){cleanup("pc_close",pc::close);cleanup("pc",pc::dispose);pc=null;}
                if(videoTrack!=null){cleanup("video_track",videoTrack::dispose);videoTrack=null;}if(videoSource!=null){cleanup("video_source",videoSource::dispose);videoSource=null;}if(texture!=null){cleanup("texture",texture::dispose);texture=null;}
                if(audioTrack!=null){cleanup("audio_track",audioTrack::dispose);audioTrack=null;}if(audioSource!=null){cleanup("audio_source",audioSource::dispose);audioSource=null;}if(factory!=null){cleanup("factory",factory::dispose);factory=null;}if(adm!=null){cleanup("adm",adm::release);adm=null;}if(egl!=null){cleanup("egl",egl::release);egl=null;}
            }finally{try{cleanup("route",this::restoreRoute);if(focused){cleanup("focus",()->audio.abandonAudioFocus(focusChange));focused=false;}WakeScheduler.release("media-session");RuntimeLog.event("media_stopped");}finally{closing=false;}}
        });
    }
    private static class SdpAdapter implements SdpObserver {public void onCreateSuccess(SessionDescription d){}public void onSetSuccess(){}public void onCreateFailure(String e){}public void onSetFailure(String e){}}
}
