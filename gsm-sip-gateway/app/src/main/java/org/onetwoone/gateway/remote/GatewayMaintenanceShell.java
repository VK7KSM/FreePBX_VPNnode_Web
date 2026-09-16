package org.onetwoone.gateway.remote;

import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/** Short-lived maintenance shell running as Android's shell UID, never root. */
final class GatewayMaintenanceShell implements Closeable {
    interface Listener {void output(int channel,byte[] data);void closed(String reason);}
    private final Process process;private final OutputStream input;private final Listener listener;private volatile boolean closed;
    GatewayMaintenanceShell(Listener listener)throws IOException {
        this.listener=listener;
        process=new ProcessBuilder("/product/bin/su","shell","-c","exec /system/bin/sh").start();input=process.getOutputStream();
    }
    void start(){read(process.getInputStream(),1);read(process.getErrorStream(),2);Thread waiter=new Thread(()->{try{process.waitFor();}catch(InterruptedException e){Thread.currentThread().interrupt();}finally{close();listener.closed("");}},"gateway-shell-wait");waiter.setDaemon(true);waiter.start();}
    synchronized void input(byte[] data)throws IOException {if(closed)throw new IOException("shell closed");if(data.length>65536)throw new IOException("input too large");input.write(data);input.flush();}
    private void read(InputStream source,int channel){Thread reader=new Thread(()->{byte[] buffer=new byte[8192];try{for(int n;!closed&&(n=source.read(buffer))>=0;)if(n>0)listener.output(channel,java.util.Arrays.copyOf(buffer,n));}catch(IOException ignored){}},"gateway-shell-output");reader.setDaemon(true);reader.start();}
    public synchronized void close(){if(closed)return;closed=true;try{input.close();}catch(IOException ignored){}process.destroy();}
}
