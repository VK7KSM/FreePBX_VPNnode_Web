package org.onetwoone.gateway.remote;

import org.junit.Test;
import static org.junit.Assert.*;

public class GatewayProxyRuntimeTest {
    @Test public void acceptsOnlyThisApplicationsExactStagedCore(){
        assertTrue(GatewayProxyRuntime.safeSource("/data/user/0/org.onetwoone.gateway/files/proxy-core/mihomo-v1.19.31"));
        assertTrue(GatewayProxyRuntime.safeSource("/data/data/org.onetwoone.gateway/files/proxy-core/mihomo-v1.19.31"));
        assertFalse(GatewayProxyRuntime.safeSource("/data/user/0/other/files/proxy-core/mihomo-v1.19.31"));
        assertFalse(GatewayProxyRuntime.safeSource("/data/user/0/org.onetwoone.gateway/files/proxy-core/../secret"));
        assertFalse(GatewayProxyRuntime.safeSource("/sdcard/mihomo-v1.19.31"));
    }
}
