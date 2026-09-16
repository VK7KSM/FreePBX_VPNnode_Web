package org.onetwoone.gateway.remote;

import android.content.Context;
import android.content.SharedPreferences;
import android.media.AudioManager;
import android.media.ToneGenerator;
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
                new AndroidVolume((AudioManager)context.getSystemService(Context.AUDIO_SERVICE)),AndroidTone::new);
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
    private static final class AndroidTone implements Tone {
        private final ToneGenerator value=new ToneGenerator(AudioManager.STREAM_ALARM,100);
        public boolean start(int durationMs){return value.startTone(ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD,durationMs);}
        public void stop(){value.stopTone();value.release();}
    }
}
