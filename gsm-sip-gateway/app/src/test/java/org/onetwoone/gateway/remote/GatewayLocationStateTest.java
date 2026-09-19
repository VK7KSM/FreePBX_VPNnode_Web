package org.onetwoone.gateway.remote;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

/**
 * 定位可用性上报。2026-09-19 起因：所有者把手机的位置信息总开关关掉后，
 * 面板只显示「IP · 2000m」，看不出是定位被关了还是还没定到，每次都得连设备翻 dumpsys。
 * 设备其实知道原因，以前却只在面板主动下发定位任务时才回报。
 */
@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE,sdk=28)
public class GatewayLocationStateTest {

    @Test public void anyEnabledProviderCountsAsAvailable() throws Exception {
        // 三个来源里有任意一个可用就算可用，不要求 GPS 一定开着——
        // 只开 WiFi/基站定位是正当配置，不该被报成不可用。
        assertTrue(GatewayLocationSampler.classify(true,true,true,false,false).getBoolean("enabled"));
        assertTrue(GatewayLocationSampler.classify(true,true,false,true,false).getBoolean("enabled"));
        assertTrue(GatewayLocationSampler.classify(true,true,false,false,true).getBoolean("enabled"));
        assertEquals("ok",GatewayLocationSampler.classify(true,true,false,false,true).getString("reason"));
    }

    @Test public void allProvidersOffReportsLocationDisabled() throws Exception {
        JSONObject state=GatewayLocationSampler.classify(true,true,false,false,false);
        assertFalse(state.getBoolean("enabled"));
        assertEquals("location_disabled",state.getString("reason"));
    }

    @Test public void reasonPriorityIsServiceThenPermissionThenSwitch() throws Exception {
        // 没有定位服务最优先，其次是没授权，最后才是总开关关闭。
        // 顺序写反的话，权限被拒时会被报成「定位已关闭」，让人去改一个改不好的地方。
        assertEquals("provider_unavailable",GatewayLocationSampler.classify(false,true,true,true,true).getString("reason"));
        assertEquals("permission_denied",GatewayLocationSampler.classify(true,false,true,true,true).getString("reason"));
        assertEquals("permission_denied",GatewayLocationSampler.classify(true,false,false,false,false).getString("reason"));
        assertEquals("location_disabled",GatewayLocationSampler.classify(true,true,false,false,false).getString("reason"));
    }

    @Test public void stateCarriesEachProviderButNoCoordinates() throws Exception {
        JSONObject state=GatewayLocationSampler.classify(true,true,true,false,true);
        assertTrue(state.getBoolean("gps"));
        assertFalse(state.getBoolean("fused"));
        assertTrue(state.getBoolean("network"));
        // 这个字段是给面板显示可用性的，不该夹带位置。
        for(String forbidden:new String[]{"lat","lng","acc_m","at"})
            assertFalse("不得包含坐标字段 "+forbidden,state.has(forbidden));
    }
}
