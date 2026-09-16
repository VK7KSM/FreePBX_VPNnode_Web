package org.onetwoone.gateway.remote;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.*;
import javax.net.ssl.HandshakeCompletedListener;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSession;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/** TLS over the local SOCKS5 listener; DNS names are resolved by the proxy. */
final class GatewayProxyTlsSocketFactory extends SSLSocketFactory {
    interface ProxySocketProvider { Socket create(Proxy proxy) throws IOException; }
    private final SSLSocketFactory tls;
    private final Proxy proxy;
    private final ProxySocketProvider sockets;
    private GatewayProxyTlsSocketFactory(){this((SSLSocketFactory)SSLSocketFactory.getDefault(),GatewayProxyRoute.socksProxy(),Socket::new);}
    GatewayProxyTlsSocketFactory(SSLSocketFactory tls,Proxy proxy,ProxySocketProvider sockets){this.tls=tls;this.proxy=proxy;this.sockets=sockets;}
    static GatewayProxyTlsSocketFactory create(){return new GatewayProxyTlsSocketFactory();}
    @Override public String[] getDefaultCipherSuites(){return tls.getDefaultCipherSuites();}
    @Override public String[] getSupportedCipherSuites(){return tls.getSupportedCipherSuites();}
    @Override public Socket createSocket(){return new DeferredProxyTlsSocket(tls,proxy,sockets);}
    @Override public Socket createSocket(String host,int port)throws IOException{return wrap(connect(host,port,null,0),host,port);}
    @Override public Socket createSocket(String host,int port,InetAddress local,int localPort)throws IOException{return wrap(connect(host,port,local,localPort),host,port);}
    @Override public Socket createSocket(InetAddress host,int port)throws IOException{return createSocket(host.getHostAddress(),port);}
    @Override public Socket createSocket(InetAddress host,int port,InetAddress local,int localPort)throws IOException{return createSocket(host.getHostAddress(),port,local,localPort);}
    @Override public Socket createSocket(Socket socket,String host,int port,boolean autoClose)throws IOException{return tls.createSocket(socket,host,port,autoClose);}
    private Socket connect(String host,int port,InetAddress local,int localPort)throws IOException {if(host==null||host.isEmpty()||port<1||port>65535)throw new IOException("invalid proxy TLS target");
        Socket socket=new Socket(GatewayProxyRoute.socksProxy());try{if(local!=null)socket.bind(new InetSocketAddress(local,localPort));socket.connect(InetSocketAddress.createUnresolved(host,port),15000);return socket;}
        catch(IOException failure){try{socket.close();}catch(IOException ignored){}throw failure;}}
    private Socket wrap(Socket socket,String host,int port)throws IOException{try{return tls.createSocket(socket,host,port,true);}catch(IOException failure){try{socket.close();}catch(IOException ignored){}throw failure;}}

    /** Paho creates an empty socket first, then connects it. Preserve that API while routing through SOCKS. */
    static final class DeferredProxyTlsSocket extends SSLSocket {
        private final SSLSocketFactory tls;private final Proxy proxy;private final ProxySocketProvider sockets;
        private SSLSocket delegate;private Socket raw;private SocketAddress local;private boolean closed;
        DeferredProxyTlsSocket(SSLSocketFactory tls,Proxy proxy,ProxySocketProvider sockets){this.tls=tls;this.proxy=proxy;this.sockets=sockets;}
        @Override public synchronized void connect(SocketAddress endpoint,int timeout)throws IOException{
            if(closed)throw new SocketException("Socket is closed");if(delegate!=null)throw new SocketException("already connected");
            if(!(endpoint instanceof InetSocketAddress))throw new SocketException("unsupported proxy TLS target");
            InetSocketAddress remote=(InetSocketAddress)endpoint;String host=remote.getHostString();int port=remote.getPort();
            if(host==null||host.isEmpty()||port<1||port>65535)throw new SocketException("invalid proxy TLS target");
            Socket candidate=sockets.create(proxy);raw=candidate;
            try{
                if(local!=null)candidate.bind(local);
                candidate.connect(InetSocketAddress.createUnresolved(host,port),timeout);
                Socket wrapped=tls.createSocket(candidate,host,port,true);
                if(!(wrapped instanceof SSLSocket))throw new IOException("TLS factory returned a non-SSL socket");
                delegate=(SSLSocket)wrapped;raw=null;
            }catch(IOException failure){try{candidate.close();}catch(IOException ignored){}raw=null;throw failure;}
        }
        @Override public void connect(SocketAddress endpoint)throws IOException{connect(endpoint,0);}
        @Override public synchronized void bind(SocketAddress bindpoint)throws IOException{if(delegate!=null)delegate.bind(bindpoint);else if(local!=null)throw new SocketException("Already bound");else local=bindpoint;}
        private synchronized SSLSocket ssl()throws SocketException{if(delegate==null)throw new SocketException(closed?"Socket is closed":"Socket is not connected");return delegate;}
        @Override public InputStream getInputStream()throws IOException{return ssl().getInputStream();}
        @Override public OutputStream getOutputStream()throws IOException{return ssl().getOutputStream();}
        @Override public synchronized void close()throws IOException{closed=true;if(delegate!=null)delegate.close();else if(raw!=null)raw.close();}
        @Override public boolean isConnected(){return delegate!=null&&delegate.isConnected();}
        @Override public boolean isBound(){return delegate!=null?delegate.isBound():local!=null;}
        @Override public boolean isClosed(){return closed||(delegate!=null&&delegate.isClosed());}
        @Override public InetAddress getInetAddress(){return delegate==null?null:delegate.getInetAddress();}
        @Override public InetAddress getLocalAddress(){return delegate==null?null:delegate.getLocalAddress();}
        @Override public int getPort(){return delegate==null?0:delegate.getPort();}
        @Override public int getLocalPort(){return delegate==null?-1:delegate.getLocalPort();}
        @Override public SocketAddress getRemoteSocketAddress(){return delegate==null?null:delegate.getRemoteSocketAddress();}
        @Override public SocketAddress getLocalSocketAddress(){return delegate==null?local:delegate.getLocalSocketAddress();}
        @Override public void setSoTimeout(int timeout)throws SocketException{ssl().setSoTimeout(timeout);}
        @Override public int getSoTimeout()throws SocketException{return ssl().getSoTimeout();}
        @Override public void setTcpNoDelay(boolean value)throws SocketException{ssl().setTcpNoDelay(value);}
        @Override public boolean getTcpNoDelay()throws SocketException{return ssl().getTcpNoDelay();}
        @Override public void setKeepAlive(boolean value)throws SocketException{ssl().setKeepAlive(value);}
        @Override public boolean getKeepAlive()throws SocketException{return ssl().getKeepAlive();}
        @Override public void shutdownInput()throws IOException{ssl().shutdownInput();}
        @Override public void shutdownOutput()throws IOException{ssl().shutdownOutput();}
        @Override public boolean isInputShutdown(){return delegate!=null&&delegate.isInputShutdown();}
        @Override public boolean isOutputShutdown(){return delegate!=null&&delegate.isOutputShutdown();}
        @Override public String[] getSupportedCipherSuites(){return delegate==null?tls.getSupportedCipherSuites():delegate.getSupportedCipherSuites();}
        @Override public String[] getEnabledCipherSuites(){try{return ssl().getEnabledCipherSuites();}catch(SocketException error){return tls.getDefaultCipherSuites();}}
        @Override public void setEnabledCipherSuites(String[] suites){try{ssl().setEnabledCipherSuites(suites);}catch(SocketException error){throw new IllegalStateException(error);}}
        @Override public String[] getSupportedProtocols(){try{return ssl().getSupportedProtocols();}catch(SocketException error){return new String[0];}}
        @Override public String[] getEnabledProtocols(){try{return ssl().getEnabledProtocols();}catch(SocketException error){return new String[0];}}
        @Override public void setEnabledProtocols(String[] protocols){try{ssl().setEnabledProtocols(protocols);}catch(SocketException error){throw new IllegalStateException(error);}}
        @Override public SSLParameters getSSLParameters(){try{return ssl().getSSLParameters();}catch(SocketException error){throw new IllegalStateException(error);}}
        @Override public void setSSLParameters(SSLParameters parameters){try{ssl().setSSLParameters(parameters);}catch(SocketException error){throw new IllegalStateException(error);}}
        @Override public SSLSession getSession(){try{return ssl().getSession();}catch(SocketException error){throw new IllegalStateException(error);}}
        @Override public void addHandshakeCompletedListener(HandshakeCompletedListener listener){try{ssl().addHandshakeCompletedListener(listener);}catch(SocketException error){throw new IllegalStateException(error);}}
        @Override public void removeHandshakeCompletedListener(HandshakeCompletedListener listener){try{ssl().removeHandshakeCompletedListener(listener);}catch(SocketException error){throw new IllegalStateException(error);}}
        @Override public void startHandshake()throws IOException{ssl().startHandshake();}
        @Override public void setUseClientMode(boolean mode){try{ssl().setUseClientMode(mode);}catch(SocketException error){throw new IllegalStateException(error);}}
        @Override public boolean getUseClientMode(){try{return ssl().getUseClientMode();}catch(SocketException error){return true;}}
        @Override public void setNeedClientAuth(boolean need){try{ssl().setNeedClientAuth(need);}catch(SocketException error){throw new IllegalStateException(error);}}
        @Override public boolean getNeedClientAuth(){try{return ssl().getNeedClientAuth();}catch(SocketException error){return false;}}
        @Override public void setWantClientAuth(boolean want){try{ssl().setWantClientAuth(want);}catch(SocketException error){throw new IllegalStateException(error);}}
        @Override public boolean getWantClientAuth(){try{return ssl().getWantClientAuth();}catch(SocketException error){return false;}}
        @Override public void setEnableSessionCreation(boolean flag){try{ssl().setEnableSessionCreation(flag);}catch(SocketException error){throw new IllegalStateException(error);}}
        @Override public boolean getEnableSessionCreation(){try{return ssl().getEnableSessionCreation();}catch(SocketException error){return true;}}
    }
}
