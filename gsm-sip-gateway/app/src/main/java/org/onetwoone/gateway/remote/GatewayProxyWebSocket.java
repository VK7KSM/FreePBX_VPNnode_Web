package org.onetwoone.gateway.remote;

import java.net.Proxy;
import java.util.concurrent.TimeUnit;
import org.java_websocket.client.WebSocketClient;

/** One bounded proxy attempt followed by one direct attempt on the same authenticated WSS session. */
final class GatewayProxyWebSocket {
    interface Connector {void route(Proxy proxy);boolean connect()throws Exception;boolean reconnect()throws Exception;}
    static boolean connect(WebSocketClient client)throws Exception{return connect(new Connector(){public void route(Proxy proxy){client.setProxy(proxy);}
        public boolean connect()throws Exception{return client.connectBlocking(10,TimeUnit.SECONDS);}public boolean reconnect()throws Exception{return client.reconnectBlocking();}},GatewayProxyRoute.preferred());}
    static boolean connect(Connector connector,boolean preferProxy)throws Exception {if(!preferProxy){connector.route(Proxy.NO_PROXY);return connector.connect();}
        connector.route(GatewayProxyRoute.httpProxy());if(connector.connect())return true;connector.route(Proxy.NO_PROXY);return connector.reconnect();}
    private GatewayProxyWebSocket(){}
}
