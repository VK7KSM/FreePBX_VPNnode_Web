package org.onetwoone.gateway.remote;

import java.io.*;
import java.net.*;
import javax.net.ssl.*;
import org.junit.Test;
import static org.junit.Assert.*;

public class GatewayProxyTlsSocketFactoryTest {
    @Test public void exposesPlatformTlsCipherSuites(){GatewayProxyTlsSocketFactory factory=GatewayProxyTlsSocketFactory.create();assertTrue(factory.getDefaultCipherSuites().length>0);assertTrue(factory.getSupportedCipherSuites().length>=factory.getDefaultCipherSuites().length);}
    @Test public void socksEndpointIsLoopbackOnly(){java.net.Proxy proxy=GatewayProxyRoute.socksProxy();assertEquals(java.net.Proxy.Type.SOCKS,proxy.type());java.net.InetSocketAddress address=(java.net.InetSocketAddress)proxy.address();assertTrue(address.getAddress().isLoopbackAddress());assertEquals(17891,address.getPort());}
    @Test public void emptySocketDefersThroughSocksAndPreservesTlsHost()throws Exception{
        RecordingSocket raw=new RecordingSocket();RecordingTlsFactory tls=new RecordingTlsFactory();Proxy proxy=GatewayProxyRoute.socksProxy();
        GatewayProxyTlsSocketFactory factory=new GatewayProxyTlsSocketFactory(tls,proxy,value->{raw.proxySeen=value;return raw;});
        Socket socket=factory.createSocket();assertTrue(socket instanceof SSLSocket);assertFalse(raw.connected);
        socket.connect(new InetSocketAddress("mqtt.elfradio.net",8883),12345);
        assertSame(proxy,raw.proxySeen);assertEquals("mqtt.elfradio.net",raw.target.getHostString());assertTrue(raw.target.isUnresolved());
        assertEquals(8883,raw.target.getPort());assertEquals(12345,raw.timeout);assertSame(raw,tls.raw);assertEquals("mqtt.elfradio.net",tls.host);assertEquals(8883,tls.port);assertTrue(tls.autoClose);
        socket.setSoTimeout(4321);assertEquals(4321,tls.socket.timeout);
        SSLParameters parameters=new SSLParameters();parameters.setEndpointIdentificationAlgorithm("HTTPS");((SSLSocket)socket).setSSLParameters(parameters);
        assertSame(parameters,tls.socket.parameters);((SSLSocket)socket).startHandshake();assertTrue(tls.socket.handshake);socket.close();assertTrue(tls.socket.closed);
    }
    @Test public void closeBeforeConnectPreventsLaterConnection()throws Exception{
        GatewayProxyTlsSocketFactory factory=new GatewayProxyTlsSocketFactory(new RecordingTlsFactory(),GatewayProxyRoute.socksProxy(),ignored->new RecordingSocket());
        Socket socket=factory.createSocket();socket.close();try{socket.connect(new InetSocketAddress("mqtt.elfradio.net",8883),1);fail("closed socket connected");}catch(SocketException expected){assertTrue(expected.getMessage().contains("closed"));}
    }

    static final class RecordingSocket extends Socket {
        boolean connected,closed;InetSocketAddress target;int timeout;Proxy proxySeen;
        @Override public void connect(SocketAddress endpoint,int timeout){connected=true;target=(InetSocketAddress)endpoint;this.timeout=timeout;}
        @Override public boolean isConnected(){return connected;}
        @Override public void close(){closed=true;}
    }
    static final class RecordingTlsFactory extends SSLSocketFactory {
        RecordingSocket raw;String host;int port;boolean autoClose;final RecordingSslSocket socket=new RecordingSslSocket();
        public String[] getDefaultCipherSuites(){return new String[]{"TEST"};}public String[] getSupportedCipherSuites(){return new String[]{"TEST"};}
        public Socket createSocket(Socket raw,String host,int port,boolean autoClose){this.raw=(RecordingSocket)raw;this.host=host;this.port=port;this.autoClose=autoClose;socket.connected=true;return socket;}
        public Socket createSocket(String h,int p){throw new UnsupportedOperationException();}public Socket createSocket(String h,int p,InetAddress l,int lp){throw new UnsupportedOperationException();}
        public Socket createSocket(InetAddress h,int p){throw new UnsupportedOperationException();}public Socket createSocket(InetAddress h,int p,InetAddress l,int lp){throw new UnsupportedOperationException();}
    }
    static final class RecordingSslSocket extends SSLSocket {
        boolean connected,closed,handshake;int timeout;SSLParameters parameters;
        public boolean isConnected(){return connected;}public void close(){closed=true;}public void setSoTimeout(int value){timeout=value;}public int getSoTimeout(){return timeout;}
        public InputStream getInputStream(){return new ByteArrayInputStream(new byte[0]);}public OutputStream getOutputStream(){return new ByteArrayOutputStream();}
        public String[] getSupportedCipherSuites(){return new String[]{"TEST"};}public String[] getEnabledCipherSuites(){return new String[]{"TEST"};}public void setEnabledCipherSuites(String[] value){}
        public String[] getSupportedProtocols(){return new String[]{"TLSv1.2"};}public String[] getEnabledProtocols(){return new String[]{"TLSv1.2"};}public void setEnabledProtocols(String[] value){}
        public SSLSession getSession(){return null;}public void addHandshakeCompletedListener(HandshakeCompletedListener value){}public void removeHandshakeCompletedListener(HandshakeCompletedListener value){}
        public SSLParameters getSSLParameters(){return parameters;}public void setSSLParameters(SSLParameters value){parameters=value;}
        public void startHandshake(){handshake=true;}public void setUseClientMode(boolean value){}public boolean getUseClientMode(){return true;}public void setNeedClientAuth(boolean value){}public boolean getNeedClientAuth(){return false;}
        public void setWantClientAuth(boolean value){}public boolean getWantClientAuth(){return false;}public void setEnableSessionCreation(boolean value){}public boolean getEnableSessionCreation(){return true;}
    }
}
