package org.onetwoone.gateway.remote;

import java.net.Proxy;
import org.junit.After;
import org.junit.Test;
import static org.junit.Assert.*;

public class GatewayProxyRouteTest {
    @After public void reset(){GatewayProxyRoute.setPreferred(false);}
    @Test public void directIsTheOnlyRouteUntilProxyIsHealthy(){Proxy[] routes=GatewayProxyRoute.attempts();assertEquals(1,routes.length);assertSame(Proxy.NO_PROXY,routes[0]);}
    @Test public void healthyProxyIsTriedBeforeDirectFallback(){GatewayProxyRoute.setPreferred(true);Proxy[] routes=GatewayProxyRoute.attempts();assertEquals(2,routes.length);assertTrue(GatewayProxyRoute.isProxy(routes[0]));assertSame(Proxy.NO_PROXY,routes[1]);
        GatewayProxyRoute.succeeded(routes[0]);assertEquals("proxy",GatewayProxyRoute.managementVia());GatewayProxyRoute.succeeded(routes[1]);assertEquals("direct",GatewayProxyRoute.managementVia());}
}
