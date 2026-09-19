package org.onetwoone.gateway.remote;

import java.net.Proxy;
import java.util.concurrent.TimeUnit;
import org.java_websocket.client.WebSocketClient;

/** One bounded proxy attempt followed by one direct attempt on the same authenticated WSS session. */
final class GatewayProxyWebSocket {
    interface Connector {void route(Proxy proxy);boolean connect()throws Exception;boolean reconnect()throws Exception;}
    /**
     * WebSocket 走 SOCKS 而不是 HTTP，这一条不能改回去。
     * Java-WebSocket 是用 {@code new Socket(proxy)} 建连的，而 Android 的 libcore 里这个构造器
     * 只认 SOCKS 与 NO_PROXY，给它 HTTP 型代理会直接抛
     * {@code IllegalArgumentException: Invalid Proxy}（Pixel 3 XL / Android 12 实测）。
     * 桌面 JDK 有 HTTP 分支不会抛，所以这个坑在电脑上复现不出来。
     * 面板 HTTP 请求那条路用的是 {@code URL.openConnection(proxy)}，它支持 HTTP 型，不受影响。
     */
    static Proxy websocketProxy(){return GatewayProxyRoute.socksProxy();}
    static boolean connect(WebSocketClient client)throws Exception{return connect(new Connector(){public void route(Proxy proxy){client.setProxy(proxy);}
        public boolean connect()throws Exception{return client.connectBlocking(10,TimeUnit.SECONDS);}public boolean reconnect()throws Exception{return client.reconnectBlocking();}},GatewayProxyRoute.preferred());}
    static boolean connect(Connector connector,boolean preferProxy)throws Exception {if(!preferProxy){connector.route(Proxy.NO_PROXY);return connector.connect();}
        connector.route(websocketProxy());if(connector.connect())return true;connector.route(Proxy.NO_PROXY);return connector.reconnect();}
    private GatewayProxyWebSocket(){}
}
