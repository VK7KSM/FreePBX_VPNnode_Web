package net.elfradio.elfremote;

import android.content.Context;
import android.media.*;
import android.os.Handler;

/** 双音交替警报：响30秒、停10秒；结束后恢复原音量。 */
final class MediaAlarm {
    private final AudioManager audio;
    private final Context context;
    private final Handler handler;
    private final android.content.SharedPreferences state;
    private AudioTrack track;
    private boolean active;
    private final Runnable sound=this::sound;
    private final Runnable pause=this::pause;
    private synchronized void pause(){if(!active)return;if(track!=null)track.pause();handler.postDelayed(sound,10000);}
    MediaAlarm(Context c,Handler h){context=c.getApplicationContext();audio=(AudioManager)c.getSystemService(Context.AUDIO_SERVICE);handler=h;state=c.getSharedPreferences("media-alarm",0);restore();}
    synchronized void start() throws Exception {
        if(active)return;
        int original=audio.getStreamVolume(AudioManager.STREAM_ALARM);
        if(!state.edit().putInt("volume",original).putBoolean("saved",true).commit())throw new java.io.IOException("警报原音量保存失败");
        try {
            audio.setStreamVolume(AudioManager.STREAM_ALARM,audio.getStreamMaxVolume(AudioManager.STREAM_ALARM),0);
            int rate=16000,count=rate*14/10;short[] samples=new short[count];
            for(int i=0;i<count;i++){
                double f=(i/(rate*35/100))%2==0?880:1320;
                int local=i%(rate*35/100);double fade=Math.min(1,Math.min(local,rate*35/100-1-local)/160.0);
                samples[i]=(short)(Math.sin(2*Math.PI*f*i/rate)*22000*Math.max(0,fade));
            }
            track=new AudioTrack(AudioManager.STREAM_ALARM,rate,AudioFormat.CHANNEL_OUT_MONO,AudioFormat.ENCODING_PCM_16BIT,count*2,AudioTrack.MODE_STATIC);
            if(track.getState()!=AudioTrack.STATE_NO_STATIC_DATA||track.write(samples,0,count)!=count)throw new java.io.IOException("警报音频初始化失败");
            if(track.setLoopPoints(0,count,-1)!=AudioTrack.SUCCESS)throw new java.io.IOException("警报循环初始化失败");
            for(AudioDeviceInfo device:audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS))if(device.getType()==AudioDeviceInfo.TYPE_BUILTIN_SPEAKER){track.setPreferredDevice(device);break;}
            active=true;sound();
        }catch(Exception e){close();throw e;}
    }
    private synchronized void sound(){if(!active||track==null)return;WakeScheduler.hold(context,"media-alarm-cycle",60000L);track.play();handler.postDelayed(pause,30000);}
    private void restore(){if(audio!=null&&state.getBoolean("saved",false)){audio.setStreamVolume(AudioManager.STREAM_ALARM,state.getInt("volume",0),0);state.edit().clear().commit();}}
    synchronized void close(){active=false;WakeScheduler.release("media-alarm-cycle");handler.removeCallbacks(sound);handler.removeCallbacks(pause);if(track!=null){try{track.stop();}catch(Exception ignored){}track.release();track=null;}restore();}
}
