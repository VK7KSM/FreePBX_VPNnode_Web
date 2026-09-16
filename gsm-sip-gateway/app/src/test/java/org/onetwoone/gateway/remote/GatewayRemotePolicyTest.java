package org.onetwoone.gateway.remote;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE,sdk=28)
public class GatewayRemotePolicyTest {
    @Test public void recoveryBackoffIsBoundedAndMonotonic() {
        assertEquals(5000,GatewayRemotePolicy.retryDelay(1));
        assertEquals(10000,GatewayRemotePolicy.retryDelay(2));
        long previous=0;
        for(int failures=1;failures<1000;failures++) {
            long delay=GatewayRemotePolicy.retryDelay(failures);
            assertTrue(delay>=previous);
            assertTrue(delay<=300000);
            previous=delay;
        }
        assertEquals(300000,GatewayRemotePolicy.retryDelay(Integer.MAX_VALUE));
    }
    @Test public void gatewayAdvertisesOnlyNarrowWifiCapabilities() throws Exception {
        org.json.JSONObject profile=GatewayRemotePolicy.profile();
        assertTrue(profile.getBoolean("managed_wifi_scan_tasks"));
        assertTrue(profile.getBoolean("managed_wifi_config_tasks"));
        assertTrue(profile.getBoolean("managed_mobile_status"));
        assertTrue(profile.getBoolean("managed_exec_tasks"));
        assertFalse(profile.getBoolean("managed_config_tasks"));
        assertFalse(profile.has("managed_hotspot_tasks"));
    }
}
