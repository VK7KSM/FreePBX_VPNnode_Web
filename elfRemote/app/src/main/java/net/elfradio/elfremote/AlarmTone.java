package net.elfradio.elfremote;

/**
 * 警报双音的合成与原生层循环次数。
 *
 * 原来 AlarmPlayer 用 ToneGenerator 的 TONE_CDMA_ALERT_CALL_GUARD，该提示音极短且音量低，
 * startTone 返回 true、任务回执 success，但现场完全听不见（2026-09-19 网关生产机实测）。
 * 这里改用 MediaAlarm 已在 D22 上验证过的做法：自行合成 880/1320Hz 交替双音。
 *
 * 两处调用都不能再用 -1 无限循环：上层定时器一旦失效，AudioTrack 必须自己停下来。
 */
final class AlarmTone {
    static final int RATE = 16000;
    static final int HALF = RATE * 35 / 100;   // 每个音持续 350 毫秒
    static final int COUNT = HALF * 4;         // 一个 1.4 秒、首尾可无缝衔接的循环片段

    private AlarmTone() {}

    /** 合成一个可无缝循环的片段：880/1320Hz 交替，每段首尾淡入淡出避免接缝爆音。 */
    static short[] samples() {
        short[] out = new short[COUNT];
        for (int i = 0; i < COUNT; i++) {
            double frequency = (i / HALF) % 2 == 0 ? 880 : 1320;
            int local = i % HALF;
            double fade = Math.min(1, Math.min(local, HALF - 1 - local) / 160.0);
            out[i] = (short) (Math.sin(2 * Math.PI * frequency * i / RATE) * 22000 * Math.max(0, fade));
        }
        return out;
    }

    /** 一个循环片段的毫秒数，1400 毫秒。 */
    static final int SEGMENT_MS = COUNT * 1000 / RATE;
    static final int MAX_PLAYS = 1000;   // 防御异常时长，1000 个片段约 23 分钟

    /**
     * 原生层兜底用的循环次数，直接传给 AudioTrack.setLoopPoints 的第三个参数。
     * 该参数是「再重复几遍」，实际播放片段数是返回值加一，语义与网关的 toneLoopCount 一致。
     * 片段数向上取整，保证播放不早于请求时长结束，宁可多响一个片段也不能被截断。
     * 定时器正常时仍由上层按请求时长停止，这个次数只在定时器失效时起作用。
     */
    static int loopCount(int durationMs) {
        long plays = durationMs <= 0 ? 1 : ((long) durationMs + SEGMENT_MS - 1) / SEGMENT_MS;
        if (plays < 1) plays = 1;
        if (plays > MAX_PLAYS) plays = MAX_PLAYS;
        return (int) plays - 1;
    }
}
