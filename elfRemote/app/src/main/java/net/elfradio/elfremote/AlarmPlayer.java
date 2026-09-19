package net.elfradio.elfremote;

import android.content.Context;
import android.content.SharedPreferences;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.os.Handler;
import org.json.JSONObject;
import java.io.IOException;

final class AlarmPlayer {
    static final int DURATION_MS = 10000;
    private final SharedPreferences state;
    private final AudioManager audio;
    private final Handler handler;
    private final Runnable changed;
    private ToneGenerator tone;
    private final Runnable ended = () -> finish("completed");

    AlarmPlayer(Context context, Handler handler, Runnable changed) {
        this.state = context.getSharedPreferences("alarm-state", Context.MODE_PRIVATE);
        this.audio = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
        this.handler = handler;
        this.changed = changed;
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
        if (audio == null || audio.getStreamVolume(AudioManager.STREAM_ALARM) == 0) throw new IOException("alarm-muted");
        release();
        if (!state.edit().putString("task_id", taskId).putString("state", "starting")
                .putLong("started_at_ms", System.currentTimeMillis()).putInt("duration_ms", DURATION_MS).commit())
            throw new IOException("alarm-state-unavailable");
        try {
            tone = new ToneGenerator(AudioManager.STREAM_ALARM, 100);
            if (!tone.startTone(ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD, DURATION_MS)) throw new IOException("alarm-start-failed");
            if (!state.edit().putString("state", "playing").commit()) throw new IOException("alarm-state-unavailable");
            if (!handler.postDelayed(ended, DURATION_MS)) throw new IOException("alarm-timer-unavailable");
            RuntimeLog.event("alarm_started duration_ms=" + DURATION_MS);
            return snapshot();
        } catch (Exception error) { finish("failed"); throw error; }
    }

    synchronized JSONObject stop() throws Exception { finish("stopped"); return snapshot(); }

    synchronized JSONObject snapshot() throws Exception {
        return new JSONObject().put("state", state.getString("state", "idle"))
                .put("started_at_ms", state.getLong("started_at_ms", 0))
                .put("duration_ms", state.getInt("duration_ms", 0));
    }

    private synchronized void finish(String outcome) {
        release();
        if (!state.edit().putString("state", outcome).commit()) RuntimeLog.event("alarm_state_save_failed");
        RuntimeLog.event("alarm_finished state=" + outcome);
        changed.run();
    }

    private void release() {
        handler.removeCallbacks(ended);
        if (tone != null) { tone.stopTone(); tone.release(); tone = null; }
    }

    synchronized void close() {
        release();
        if ("playing".equals(state.getString("state", "")))
            state.edit().putString("state", "interrupted").commit();
    }
}
