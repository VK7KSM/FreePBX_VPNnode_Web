package org.onetwoone.gateway.remote;

import org.junit.Test;
import static org.junit.Assert.*;

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
}
