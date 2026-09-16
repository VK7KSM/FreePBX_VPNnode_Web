package org.onetwoone.gateway.remote;

import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.URL;
import java.net.URLConnection;

/** Process-local explicit route preference. It never changes Android or JVM global proxy settings. */
final class GatewayProxyRoute {
    private static final Proxy LOCAL_HTTP=new Proxy(Proxy.Type.HTTP,new InetSocketAddress("127.0.0.1",GatewayProxyPolicy.HTTP_PORT));
    private static volatile boolean preferred;private static volatile String last="direct";
    static void setPreferred(boolean value){preferred=value;if(!value)last="direct";}
    static Proxy[] attempts(){return preferred?new Proxy[]{LOCAL_HTTP,Proxy.NO_PROXY}:new Proxy[]{Proxy.NO_PROXY};}
    static boolean preferred(){return preferred;}
    static Proxy socksProxy(){return new Proxy(Proxy.Type.SOCKS,new InetSocketAddress("127.0.0.1",GatewayProxyPolicy.SOCKS_PORT));}
    static URLConnection open(URL url,Proxy route)throws Exception{return route==Proxy.NO_PROXY?url.openConnection():url.openConnection(route);}
    static void succeeded(Proxy route){last=route==Proxy.NO_PROXY?"direct":"proxy";}
    static String managementVia(){return last;}
    static boolean isProxy(Proxy route){return route!=Proxy.NO_PROXY;}
    private GatewayProxyRoute(){}
}
