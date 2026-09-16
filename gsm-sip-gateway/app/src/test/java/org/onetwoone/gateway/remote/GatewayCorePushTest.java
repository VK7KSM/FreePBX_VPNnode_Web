package org.onetwoone.gateway.remote;

import org.junit.Test;
import static org.junit.Assert.*;

public class GatewayCorePushTest {
    @Test public void reconnectsOnlyWhenAnEstablishedMqttRouteChanges(){
        assertTrue(GatewayCorePush.routeMismatch(true,false,true));
        assertTrue(GatewayCorePush.routeMismatch(true,true,false));
        assertFalse(GatewayCorePush.routeMismatch(true,true,true));
        assertFalse(GatewayCorePush.routeMismatch(true,false,false));
        assertFalse(GatewayCorePush.routeMismatch(false,false,true));
    }
}
