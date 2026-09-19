package net.elfradio.elfremote;

import org.junit.Test;
import static org.junit.Assert.*;
import java.io.IOException;
import java.net.*;
import javax.net.ssl.SSLSocketFactory;

public class AttributedTlsFactoryTest {
    static class Delegate extends SSLSocketFactory {
        Socket created,wrapped;
        public String[] getDefaultCipherSuites(){return new String[0];}
        public String[] getSupportedCipherSuites(){return new String[0];}
        public Socket createSocket(){return created=new Socket();}
        public Socket createSocket(Socket socket,String host,int port,boolean close){return wrapped=socket;}
        public Socket createSocket(String h,int p){throw new AssertionError();}
        public Socket createSocket(String h,int p,InetAddress l,int n){throw new AssertionError();}
        public Socket createSocket(InetAddress h,int p){throw new AssertionError();}
        public Socket createSocket(InetAddress h,int p,InetAddress l,int n){throw new AssertionError();}
    }
    @Test public void markBeforeConnectAndPreserveSocket()throws Exception {
        Delegate delegate=new Delegate();Socket[] tagged={null};
        AttributedTlsFactory factory=new AttributedTlsFactory(delegate,s->{assertFalse(s.isConnected());tagged[0]=s;});
        try(ServerSocket server=new ServerSocket(0,1,InetAddress.getLoopbackAddress());Socket socket=factory.createSocket("127.0.0.1",server.getLocalPort())){
            assertSame(tagged[0],socket);assertSame(delegate.wrapped,socket);assertTrue(socket.isConnected());
        }
    }
    @Test public void tagFailureClosesSocketBeforeConnecting()throws Exception {
        Delegate delegate=new Delegate();AttributedTlsFactory factory=new AttributedTlsFactory(delegate,s->{throw new IOException("tag failed");});
        try{factory.createSocket();fail();}catch(IOException expected){assertTrue(delegate.created.isClosed());}
    }
}
