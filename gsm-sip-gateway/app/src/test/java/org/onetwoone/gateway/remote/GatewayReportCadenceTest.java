package org.onetwoone.gateway.remote;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

/**
 * 上报间隔要如实报给面板。
 *
 * <p>2026-09-23 起因：面板原先按网络类型查表猜间隔，WiFi 一律当成 15 分钟，
 * 而这台网关每 60 秒上报一次。面板的轨迹断点阈值是「两倍间隔」，于是被放到 30 分钟，
 * 比真实节奏宽了 30 倍——2026-09-19 那次死锁停报近 8 分钟，轨迹上一个断点都没出现，
 * 故障被完全掩盖。设备报上真实间隔后，阈值自动变成 2 分钟。
 */
@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE,sdk=28)
public class GatewayReportCadenceTest {

    @Test public void reportIntervalMustFallInsideThePanelAcceptedRange() {
        // 面板 cadence() 只采信 [60000, 86400000]，越界会被悄悄回退成查表值，
        // 那样这个字段等于没加，而且不会有任何报错。
        assertTrue("上报间隔低于面板下限，会被回退成查表值",
                GatewayRemotePolicy.REPORT_MS >= GatewayRemotePolicy.REPORT_INTERVAL_MIN_MS);
        assertTrue("上报间隔高于面板上限，会被回退成查表值",
                GatewayRemotePolicy.REPORT_MS <= GatewayRemotePolicy.REPORT_INTERVAL_MAX_MS);
    }

    @Test public void reportedCadenceIsTheSteadyStateNotTheBackoff() {
        // 报的必须是稳态常量。退避值不是节奏信号：它从 5 秒起步（比稳态还快），
        // 一路涨到 300 秒（比稳态慢五倍），跨在 REPORT_MS 两侧。
        // 拿它当上报间隔，面板的断点阈值会随故障忽宽忽窄，正好和这个字段的目的相反。
        boolean seenShorter=false,seenLonger=false;
        for(int failures=1;failures<=10;failures++){
            long backoff=GatewayRemotePolicy.retryDelay(failures);
            if(backoff<GatewayRemotePolicy.REPORT_MS)seenShorter=true;
            if(backoff>GatewayRemotePolicy.REPORT_MS)seenLonger=true;
        }
        assertTrue("退避会比稳态更快（首次 5 秒）",seenShorter);
        assertTrue("退避会比稳态更慢（上限 300 秒）",seenLonger);
        // 稳态值本身不随失败次数变化，这才是可以报给面板的那个数。
        assertEquals(60_000L,GatewayRemotePolicy.REPORT_MS);
    }
}
