package org.onetwoone.gateway.remote;

import org.junit.Test;
import static org.junit.Assert.*;

public class GatewayProxyTlsSocketFactoryTest {
    @Test public void exposesPlatformTlsCipherSuites(){GatewayProxyTlsSocketFactory factory=GatewayProxyTlsSocketFactory.create();assertTrue(factory.getDefaultCipherSuites().length>0);assertTrue(factory.getSupportedCipherSuites().length>=factory.getDefaultCipherSuites().length);}
    @Test public void socksEndpointIsLoopbackOnly(){java.net.Proxy proxy=GatewayProxyRoute.socksProxy();assertEquals(java.net.Proxy.Type.SOCKS,proxy.type());java.net.InetSocketAddress address=(java.net.InetSocketAddress)proxy.address();assertTrue(address.getAddress().isLoopbackAddress());assertEquals(17891,address.getPort());}
}
