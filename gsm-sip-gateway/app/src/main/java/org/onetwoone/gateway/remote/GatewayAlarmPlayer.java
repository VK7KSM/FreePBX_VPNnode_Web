package org.onetwoone.gateway.remote;

import android.content.Context;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.os.Handler;
import java.io.IOException;
import org.json.JSONObject;

/** Bounded find-device alarm which always restores the previous alarm volume. */
final class GatewayAlarmPlayer {
    static final int DURATION_MS=10_000;
    interface Volume {
        int current(); int maximum(); void set(int value);
    }
    interface Tone {
        boolean start(int durationMs); void stop();
    }
    interface ToneFactory { Tone create() throws Exception; }

    private final SharedPreferences state;private final Handler handler;private final Runnable changed;
    private final Volume volume;private final ToneFactory tones;private Tone tone;
    private final Runnable ended=()->finish("completed");

    GatewayAlarmPlayer(Context context,Handler handler,Runnable changed){
        this(context.getSharedPreferences("gateway-alarm-state",Context.MODE_PRIVATE),handler,changed,
                new AndroidVolume((AudioManager)context.getSystemService(Context.AUDIO_SERVICE)),
                toneFactory((AudioManager)context.getSystemService(Context.AUDIO_SERVICE)));
    }
    GatewayAlarmPlayer(SharedPreferences state,Handler handler,Runnable changed,Volume volume,ToneFactory tones){
        this.state=state;this.handler=handler;this.changed=changed;this.volume=volume;this.tones=tones;
        String previous=state.getString("state","");
        if("playing".equals(previous)||"starting".equals(previous)){restoreVolume();state.edit().putString("state","interrupted").commit();}
    }
    synchronized JSONObject play(String taskId,Boolean busy)throws Exception {
        if(Boolean.TRUE.equals(busy)||busy==null)throw new IOException("gateway-busy");
        if(taskId.equals(state.getString("task_id",""))){String previous=state.getString("state","");if("playing".equals(previous)||"completed".equals(previous)||"stopped".equals(previous))return snapshot();}
        if("playing".equals(state.getString("state",""))||"starting".equals(state.getString("state",""))){release();restoreVolume();state.edit().putString("state","interrupted").commit();}
        else release();
        int original=volume.current(),maximum=volume.maximum();if(maximum<=0)throw new IOException("alarm-volume-unavailable");
        if(!state.edit().putString("task_id",taskId).putString("state","starting").putLong("started_at_ms",System.currentTimeMillis())
                .putInt("duration_ms",DURATION_MS).putInt("saved_volume",original).putBoolean("volume_saved",true).commit())throw new IOException("alarm-state-unavailable");
        try{volume.set(maximum);tone=tones.create();if(!tone.start(DURATION_MS))throw new IOException("alarm-start-failed");
            if(!state.edit().putString("state","playing").commit())throw new IOException("alarm-state-unavailable");
            if(!handler.postDelayed(ended,DURATION_MS))throw new IOException("alarm-timer-unavailable");return snapshot();
        }catch(Exception failure){finish("failed");throw failure;}
    }
    synchronized JSONObject stop()throws Exception {finish("stopped");return snapshot();}
    synchronized JSONObject snapshot()throws Exception {return new JSONObject().put("state",state.getString("state","idle"))
            .put("started_at_ms",state.getLong("started_at_ms",0)).put("duration_ms",state.getInt("duration_ms",0));}
    private synchronized void finish(String outcome){release();restoreVolume();state.edit().putString("state",outcome).commit();changed.run();}
    private void restoreVolume(){if(!state.getBoolean("volume_saved",false))return;try{volume.set(state.getInt("saved_volume",0));}catch(Exception ignored){}state.edit().putBoolean("volume_saved",false).apply();}
    private void release(){handler.removeCallbacks(ended);if(tone!=null){try{tone.stop();}catch(Exception ignored){}tone=null;}}
    synchronized void close(){release();restoreVolume();if("playing".equals(state.getString("state","")))state.edit().putString("state","interrupted").commit();}

    private static final class AndroidVolume implements Volume {
        private final AudioManager audio;AndroidVolume(AudioManager audio){this.audio=audio;}
        public int current(){return audio==null?0:audio.getStreamVolume(AudioManager.STREAM_ALARM);}
        public int maximum(){return audio==null?0:audio.getStreamMaxVolume(AudioManager.STREAM_ALARM);}
        public void set(int value){if(audio!=null)audio.setStreamVolume(AudioManager.STREAM_ALARM,value,0);}
    }
    static ToneFactory toneFactory(AudioManager audio){return ()->new AndroidTone(audio);}

    static final int TONE_RATE=16000;
    static final int TONE_HALF=TONE_RATE*35/100;   // 每个音持续 350 毫秒
    static final int TONE_COUNT=TONE_HALF*4;       // 一个 1.4 秒的可无缝循环片段
    static final int TONE_MAX_LOOPS=1000;          // 上限约 23 分钟，防御异常时长

    /**
     * 音轨自身的停止兜底：把无限循环改成刚好覆盖请求时长的有限次循环。
     * 正常情况由上层 handler 在 DURATION_MS 时停止；万一该回调被移除或 Looper 长时间阻塞，
     * 音轨也会在原生层自行播完停止，不会一直响。向上取整，保证不早于请求时长结束。
     * 返回值是 AudioTrack.setLoopPoints 的 loopCount，总播放遍数为该值加一。
     */
    static int toneLoopCount(int durationMs){
        long segmentMs=TONE_COUNT*1000L/TONE_RATE;
        long plays=durationMs<=0?1:(durationMs+segmentMs-1)/segmentMs;
        return (int)Math.min(Math.max(plays,1),TONE_MAX_LOOPS)-1;
    }

    /**
     * 双音警报。原实现用 ToneGenerator 的 TONE_CDMA_ALERT_CALL_GUARD，该提示音极短且音量低，
     * startTone 返回成功但现场听不见（2026-09-19 生产机实测：任务回执 success 而设备无声）。
     * 改为与 D22 已验证的 MediaAlarm 相同的做法：自行合成 880/1320Hz 交替方波并用 AudioTrack
     * 无限循环播放，显式指定内置扬声器，并校验播放状态，播不出时返回 false 让上层报失败。
     */
    private static final class AndroidTone implements Tone {
        private static final int RATE=TONE_RATE;
        private static final int HALF=TONE_HALF;
        private static final int COUNT=TONE_COUNT;
        private final AudioManager audio;private AudioTrack track;
        AndroidTone(AudioManager audio){this.audio=audio;}
        public boolean start(int durationMs){
            short[] samples=new short[COUNT];
            for(int i=0;i<COUNT;i++){
                double frequency=(i/HALF)%2==0?880:1320;
                int local=i%HALF;
                // 每段首尾淡入淡出，避免切换与循环接缝处的爆音
                double fade=Math.min(1,Math.min(local,HALF-1-local)/160.0);
                samples[i]=(short)(Math.sin(2*Math.PI*frequency*i/RATE)*22000*Math.max(0,fade));
            }
            AudioTrack built=new AudioTrack.Builder()
                    .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                    .setAudioFormat(new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                            .setSampleRate(RATE).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                    .setBufferSizeInBytes(COUNT*2).setTransferMode(AudioTrack.MODE_STATIC).build();
            track=built;
            if(built.getState()!=AudioTrack.STATE_NO_STATIC_DATA)return false;
            if(built.write(samples,0,COUNT)!=COUNT)return false;
            if(built.setLoopPoints(0,COUNT,toneLoopCount(durationMs))!=AudioTrack.SUCCESS)return false;
            if(audio!=null)for(AudioDeviceInfo device:audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS))
                if(device.getType()==AudioDeviceInfo.TYPE_BUILTIN_SPEAKER){built.setPreferredDevice(device);break;}
            built.play();
            return built.getPlayState()==AudioTrack.PLAYSTATE_PLAYING;
        }
        public void stop(){
            AudioTrack current=track;track=null;
            if(current==null)return;
            try{current.stop();}catch(Exception ignored){}
            current.release();
        }
    }
}
