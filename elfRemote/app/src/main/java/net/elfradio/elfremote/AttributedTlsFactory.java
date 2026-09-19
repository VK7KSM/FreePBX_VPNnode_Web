package net.elfradio.elfremote;

import javax.net.ssl.SSLSocketFactory;
import java.io.IOException;
import java.net.*;

/** 在TLS握手和网络连接前标记底层套接字，包含握手与重传流量。 */
final class AttributedTlsFactory extends SSLSocketFactory {
    interface Tagger { void tag(Socket socket)throws Exception; }
    private final SSLSocketFactory delegate;
    private final Tagger tagger;
    AttributedTlsFactory(SSLSocketFactory delegate,Tagger tagger){this.delegate=delegate;this.tagger=tagger;}
    public String[] getDefaultCipherSuites(){return delegate.getDefaultCipherSuites();}
    public String[] getSupportedCipherSuites(){return delegate.getSupportedCipherSuites();}
    private Socket plain()throws IOException {
        Socket socket=new Socket();
        try{socket.getReuseAddress();tagger.tag(socket);return socket;}
        catch(Exception failure){socket.close();throw new IOException("维护连接流量归属失败",failure);}
    }
    public Socket createSocket()throws IOException {
        // 无参TLS套接字由Android在connect时创建底层fd，因此在连接线程设置UID。
        Socket socket=delegate.createSocket();
        try{socket.getReuseAddress();tagger.tag(socket);return socket;}
        catch(Exception failure){socket.close();throw new IOException("维护连接流量归属失败",failure);}
    }
    public Socket createSocket(Socket socket,String host,int port,boolean close)throws IOException {
        try{tagger.tag(socket);return delegate.createSocket(socket,host,port,close);}
        catch(Exception failure){if(close)socket.close();throw new IOException("维护连接流量归属失败",failure);}
    }
    private Socket connect(String host,int port,InetAddress local,int localPort)throws IOException {
        Socket socket=plain();
        try{if(local!=null)socket.bind(new InetSocketAddress(local,localPort));socket.connect(new InetSocketAddress(host,port),10000);return delegate.createSocket(socket,host,port,true);}
        catch(IOException failure){socket.close();throw failure;}
    }
    public Socket createSocket(String host,int port)throws IOException{return connect(host,port,null,0);}
    public Socket createSocket(String host,int port,InetAddress local,int localPort)throws IOException{return connect(host,port,local,localPort);}
    public Socket createSocket(InetAddress host,int port)throws IOException{return connect(host.getHostAddress(),port,null,0);}
    public Socket createSocket(InetAddress host,int port,InetAddress local,int localPort)throws IOException{return connect(host.getHostAddress(),port,local,localPort);}
}
