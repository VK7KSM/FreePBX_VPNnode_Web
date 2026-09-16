package org.onetwoone.gateway.remote;

import java.net.Proxy;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;
import static org.junit.Assert.*;

public class GatewayProxyWebSocketTest {
    private static final class Fake implements GatewayProxyWebSocket.Connector {final List<Proxy> routes=new ArrayList<>();boolean first,second;public void route(Proxy value){routes.add(value);}public boolean connect(){return first;}public boolean reconnect(){return second;}}
    @Test public void directModeUsesOneAttempt()throws Exception {Fake fake=new Fake();fake.first=true;assertTrue(GatewayProxyWebSocket.connect(fake,false));assertEquals(1,fake.routes.size());assertSame(Proxy.NO_PROXY,fake.routes.get(0));}
    @Test public void proxySuccessDoesNotDuplicateSession()throws Exception {Fake fake=new Fake();fake.first=true;assertTrue(GatewayProxyWebSocket.connect(fake,true));assertEquals(1,fake.routes.size());assertTrue(GatewayProxyRoute.isProxy(fake.routes.get(0)));}
    @Test public void proxyFailureFallsBackDirectOnce()throws Exception {Fake fake=new Fake();fake.second=true;assertTrue(GatewayProxyWebSocket.connect(fake,true));assertEquals(2,fake.routes.size());assertTrue(GatewayProxyRoute.isProxy(fake.routes.get(0)));assertSame(Proxy.NO_PROXY,fake.routes.get(1));}
}
