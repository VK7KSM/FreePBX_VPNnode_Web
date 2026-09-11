package net.elfradio.elfremote;

/** 历史补传使用独立时钟，不能重新生成定位/照片报告或推迟正常采样。 */
final class StatusDrainPolicy {
    static long delay(boolean cellular,int pending,int failures) {
        if(pending<=0)return 0;
        long cadence=cellular?3600000L:60000L;
        return Math.max(cadence,StatusReporter.retryDelay(60000L,failures));
    }
    private StatusDrainPolicy() {}
}
