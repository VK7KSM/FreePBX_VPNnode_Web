package org.onetwoone.gateway.remote;

import java.io.IOException;
import java.net.*;
import javax.net.ssl.SSLSocketFactory;

/** TLS over the local SOCKS5 listener; DNS names are resolved by the proxy. */
final class GatewayProxyTlsSocketFactory extends SSLSocketFactory {
    private final SSLSocketFactory tls=(SSLSocketFactory)SSLSocketFactory.getDefault();
    static GatewayProxyTlsSocketFactory create(){return new GatewayProxyTlsSocketFactory();}
    @Override public String[] getDefaultCipherSuites(){return tls.getDefaultCipherSuites();}
    @Override public String[] getSupportedCipherSuites(){return tls.getSupportedCipherSuites();}
    @Override public Socket createSocket(String host,int port)throws IOException{return wrap(connect(host,port,null,0),host,port);}
    @Override public Socket createSocket(String host,int port,InetAddress local,int localPort)throws IOException{return wrap(connect(host,port,local,localPort),host,port);}
    @Override public Socket createSocket(InetAddress host,int port)throws IOException{return createSocket(host.getHostAddress(),port);}
    @Override public Socket createSocket(InetAddress host,int port,InetAddress local,int localPort)throws IOException{return createSocket(host.getHostAddress(),port,local,localPort);}
    @Override public Socket createSocket(Socket socket,String host,int port,boolean autoClose)throws IOException{return tls.createSocket(socket,host,port,autoClose);}
    private Socket connect(String host,int port,InetAddress local,int localPort)throws IOException {if(host==null||host.isEmpty()||port<1||port>65535)throw new IOException("invalid proxy TLS target");
        Socket socket=new Socket(GatewayProxyRoute.socksProxy());try{if(local!=null)socket.bind(new InetSocketAddress(local,localPort));socket.connect(InetSocketAddress.createUnresolved(host,port),15000);return socket;}
        catch(IOException failure){try{socket.close();}catch(IOException ignored){}throw failure;}}
    private Socket wrap(Socket socket,String host,int port)throws IOException{try{return tls.createSocket(socket,host,port,true);}catch(IOException failure){try{socket.close();}catch(IOException ignored){}throw failure;}}
}
