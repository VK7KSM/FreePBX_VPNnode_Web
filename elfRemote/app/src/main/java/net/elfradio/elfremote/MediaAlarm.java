package net.elfradio.elfremote;

import android.content.Context;
import android.media.*;
import android.os.Handler;

/** 双音交替警报：响30秒、停10秒；结束后恢复原音量。 */
final class MediaAlarm {
    private static final int RING_MS=30000,PAUSE_MS=10000;
    private final AudioManager audio;
    private final Context context;
    private final Handler handler;
    private final android.content.SharedPreferences state;
    private AudioTrack track;
    private MediaFlash flash;
    private boolean active;
    private boolean played;
    private final Runnable sound=this::sound;
    private final Runnable pause=this::pause;
    // 停的时候直接 stop 而不是 pause：下一轮要重新装填并重设有限循环次数。
    private synchronized void pause(){if(!active)return;if(track!=null){try{track.stop();}catch(Exception ignored){}}if(flash!=null)flash.stop();handler.postDelayed(sound,PAUSE_MS);}
    MediaAlarm(Context c,Handler h){context=c.getApplicationContext();audio=(AudioManager)c.getSystemService(Context.AUDIO_SERVICE);handler=h;state=c.getSharedPreferences("media-alarm",0);restore();}
    synchronized void start() throws Exception {
        if(active)return;
        int original=audio.getStreamVolume(AudioManager.STREAM_ALARM);
        if(!state.edit().putInt("volume",original).putBoolean("saved",true).commit())throw new java.io.IOException("警报原音量保存失败");
        try {
            audio.setStreamVolume(AudioManager.STREAM_ALARM,audio.getStreamMaxVolume(AudioManager.STREAM_ALARM),0);
            int count=AlarmTone.COUNT;short[] samples=AlarmTone.samples();
            track=new AudioTrack(AudioManager.STREAM_ALARM,AlarmTone.RATE,AudioFormat.CHANNEL_OUT_MONO,AudioFormat.ENCODING_PCM_16BIT,count*2,AudioTrack.MODE_STATIC);
            if(track.getState()!=AudioTrack.STATE_NO_STATIC_DATA||track.write(samples,0,count)!=count)throw new java.io.IOException("警报音频初始化失败");
            // 有限循环：Handler 失效时最多多响一个片段就停，不会一直响下去。
            if(track.setLoopPoints(0,count,AlarmTone.loopCount(RING_MS))!=AudioTrack.SUCCESS)throw new java.io.IOException("警报循环初始化失败");
            for(AudioDeviceInfo device:audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS))if(device.getType()==AudioDeviceInfo.TYPE_BUILTIN_SPEAKER){track.setPreferredDevice(device);break;}
            prepareFlash();active=true;played=false;sound();
        }catch(Exception e){close();throw e;}
    }
    private void prepareFlash(){
        try{
            android.hardware.camera2.CameraManager manager=(android.hardware.camera2.CameraManager)context.getSystemService(Context.CAMERA_SERVICE);
            for(String id:manager.getCameraIdList()){
                android.hardware.camera2.CameraCharacteristics c=manager.getCameraCharacteristics(id);
                if(Boolean.TRUE.equals(c.get(android.hardware.camera2.CameraCharacteristics.FLASH_INFO_AVAILABLE))
                    &&Integer.valueOf(android.hardware.camera2.CameraCharacteristics.LENS_FACING_BACK).equals(c.get(android.hardware.camera2.CameraCharacteristics.LENS_FACING))){
                    flash=new MediaFlash(on->manager.setTorchMode(id,on),new MediaFlash.Scheduler(){public void post(Runnable r,long delay){handler.postDelayed(r,delay);}public void remove(Runnable r){handler.removeCallbacks(r);}});return;
                }
            }
            RuntimeLog.event("alarm_flash_unavailable");
        }catch(Exception error){RuntimeLog.error("alarm_flash_unavailable",error);}
    }
    private synchronized void sound(){
        if(!active||track==null)return;
        WakeScheduler.hold(context,"media-alarm-cycle",60000L);
        // 第二轮起要重新装填静态缓冲并重设循环次数，否则上一轮用掉的次数不会回来，后面几轮会哑掉。
        if(played){
            try{track.stop();}catch(Exception ignored){}
            if(track.reloadStaticData()!=AudioTrack.SUCCESS||track.setLoopPoints(0,AlarmTone.COUNT,AlarmTone.loopCount(RING_MS))!=AudioTrack.SUCCESS)
                RuntimeLog.event("alarm_loop_rearm_failed");
        }
        played=true;
        track.play();
        if(flash!=null)flash.start();
        handler.postDelayed(pause,RING_MS);
    }
    private void restore(){if(audio!=null&&state.getBoolean("saved",false)){audio.setStreamVolume(AudioManager.STREAM_ALARM,state.getInt("volume",0),0);state.edit().clear().commit();}}
    synchronized void close(){active=false;played=false;WakeScheduler.release("media-alarm-cycle");handler.removeCallbacks(sound);handler.removeCallbacks(pause);if(flash!=null){flash.stop();flash=null;}if(track!=null){try{track.stop();}catch(Exception ignored){}track.release();track=null;}restore();}
}
