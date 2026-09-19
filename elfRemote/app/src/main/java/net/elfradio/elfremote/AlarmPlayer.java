package net.elfradio.elfremote;

import android.content.Context;
import android.content.SharedPreferences;
import android.media.AudioDeviceInfo;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.os.Handler;
import org.json.JSONObject;
import java.io.IOException;

final class AlarmPlayer {
    static final int DURATION_MS = 10000;
    private final SharedPreferences state;
    private final AudioManager audio;
    private final Handler handler;
    private final Runnable changed;
    private AudioTrack track;
    private final Runnable ended = () -> finish("completed");

    AlarmPlayer(Context context, Handler handler, Runnable changed) {
        this.state = context.getSharedPreferences("alarm-state", Context.MODE_PRIVATE);
        this.audio = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
        this.handler = handler;
        this.changed = changed;
        // 上次播放途中进程被杀时音量可能停在最大，先恢复再标记中断。
        restoreVolume();
        if ("playing".equals(state.getString("state", "")) || "starting".equals(state.getString("state", "")))
            state.edit().putString("state", "interrupted").commit();
    }

    synchronized JSONObject play(String taskId) throws Exception {
        if (taskId.equals(state.getString("task_id", ""))) {
            String previous = state.getString("state", "");
            if (!"playing".equals(previous) && !"completed".equals(previous) && !"stopped".equals(previous))
                throw new IOException("alarm-" + previous);
            return snapshot();
        }
        if (audio == null) throw new IOException("alarm-audio-unavailable");
        int maximum = audio.getStreamMaxVolume(AudioManager.STREAM_ALARM);
        if (maximum <= 0) throw new IOException("alarm-volume-unavailable");
        release();
        int original = audio.getStreamVolume(AudioManager.STREAM_ALARM);
        if (!state.edit().putString("task_id", taskId).putString("state", "starting")
                .putLong("started_at_ms", System.currentTimeMillis()).putInt("duration_ms", DURATION_MS)
                .putInt("saved_volume", original).putBoolean("volume_saved", true).commit())
            throw new IOException("alarm-state-unavailable");
        try {
            // 警报是用来找设备的，警报音量为零时也必须响；原音量已存进状态，结束或下次启动时恢复。
            audio.setStreamVolume(AudioManager.STREAM_ALARM, maximum, 0);
            if (!startTone()) throw new IOException("alarm-start-failed");
            if (!state.edit().putString("state", "playing").commit()) throw new IOException("alarm-state-unavailable");
            if (!handler.postDelayed(ended, DURATION_MS)) throw new IOException("alarm-timer-unavailable");
            RuntimeLog.event("alarm_started duration_ms=" + DURATION_MS + " loops=" + AlarmTone.loopCount(DURATION_MS));
            return snapshot();
        } catch (Exception error) { finish("failed"); throw error; }
    }

    /**
     * 用 MediaAlarm 已在 D22 上验证过的构造方式起音，并显式路由到内置扬声器。
     * 循环次数有限，postDelayed 失效时原生层最多多响一个片段就自己停。
     * 播不出时返回 false，让上层如实报失败，不要出现回执成功而设备无声。
     */
    private boolean startTone() {
        short[] samples = AlarmTone.samples();
        AudioTrack built = new AudioTrack(AudioManager.STREAM_ALARM, AlarmTone.RATE, AudioFormat.CHANNEL_OUT_MONO,
                AudioFormat.ENCODING_PCM_16BIT, AlarmTone.COUNT * 2, AudioTrack.MODE_STATIC);
        track = built;
        if (built.getState() != AudioTrack.STATE_NO_STATIC_DATA) return false;
        if (built.write(samples, 0, AlarmTone.COUNT) != AlarmTone.COUNT) return false;
        if (built.setLoopPoints(0, AlarmTone.COUNT, AlarmTone.loopCount(DURATION_MS)) != AudioTrack.SUCCESS) return false;
        for (AudioDeviceInfo device : audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS))
            if (device.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) { built.setPreferredDevice(device); break; }
        built.play();
        return built.getPlayState() == AudioTrack.PLAYSTATE_PLAYING;
    }

    synchronized JSONObject stop() throws Exception { finish("stopped"); return snapshot(); }

    synchronized JSONObject snapshot() throws Exception {
        return new JSONObject().put("state", state.getString("state", "idle"))
                .put("started_at_ms", state.getLong("started_at_ms", 0))
                .put("duration_ms", state.getInt("duration_ms", 0));
    }

    private synchronized void finish(String outcome) {
        release();
        restoreVolume();
        if (!state.edit().putString("state", outcome).commit()) RuntimeLog.event("alarm_state_save_failed");
        RuntimeLog.event("alarm_finished state=" + outcome);
        changed.run();
    }

    private void release() {
        handler.removeCallbacks(ended);
        AudioTrack current = track; track = null;
        if (current == null) return;
        try { current.stop(); } catch (Exception ignored) {}
        current.release();
    }

    private void restoreVolume() {
        if (audio == null || !state.getBoolean("volume_saved", false)) return;
        try { audio.setStreamVolume(AudioManager.STREAM_ALARM, state.getInt("saved_volume", 0), 0); }
        catch (Exception ignored) {}
        state.edit().putBoolean("volume_saved", false).commit();
    }

    synchronized void close() {
        release();
        restoreVolume();
        if ("playing".equals(state.getString("state", "")))
            state.edit().putString("state", "interrupted").commit();
    }
}
