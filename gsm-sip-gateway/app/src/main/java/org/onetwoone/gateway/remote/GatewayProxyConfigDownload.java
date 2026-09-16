package org.onetwoone.gateway.remote;

import android.content.Context;
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import org.json.JSONObject;

/** Same-origin, bounded proxy configuration delivery with cooperative cancellation. */
final class GatewayProxyConfigDownload {
    interface Cancel {boolean cancelled();}
    static File download(Context context,JSONObject params,Cancel cancel)throws Exception {
        if(params==null||params.length()!=3)throw new SecurityException("invalid proxy config contract");String raw=params.optString("url"),hash=params.optString("sha256");long size=params.optLong("size");
        URL url=validateUrl(raw);if(size<2||size>GatewayProxyPolicy.MAX_CONFIG_BYTES||!hash.matches("[0-9a-f]{64}"))throw new SecurityException("invalid proxy config contract");
        HttpURLConnection connection=(HttpURLConnection)url.openConnection();connection.setInstanceFollowRedirects(false);connection.setConnectTimeout(15000);connection.setReadTimeout(20000);
        connection.setRequestProperty("User-Agent","elfRemote-Gateway/1.5.0");connection.setRequestProperty("Accept","application/x-yaml, text/yaml, application/octet-stream");connection.setRequestProperty("Accept-Encoding","identity");
        try{if(cancel.cancelled())throw new InterruptedIOException("proxy task cancelled");if(connection.getResponseCode()!=200)throw new IOException("proxy config HTTP unavailable");
            long length=connection.getContentLengthLong();if(length!=-1&&length!=size)throw new SecurityException("proxy config length mismatch");
            return GatewayProxyConfigStage.stage(context,new CancelInput(connection.getInputStream(),cancel),size,hash);
        }finally{connection.disconnect();}
    }
    static URL validateUrl(String raw)throws Exception {if(raw==null||raw.length()>4096||raw.chars().anyMatch(c->c<0x20||c==0x7f))throw new SecurityException("proxy config URL rejected");URL expected=new URL(GatewayRemotePolicy.BASE_URL),actual=new URL(raw);
        int expectedPort=expected.getPort()==-1?expected.getDefaultPort():expected.getPort(),actualPort=actual.getPort()==-1?actual.getDefaultPort():actual.getPort();
        if(!"https".equalsIgnoreCase(actual.getProtocol())||!expected.getHost().equalsIgnoreCase(actual.getHost())||expectedPort!=actualPort
                ||actual.getUserInfo()!=null||actual.getRef()!=null||!actual.getPath().matches("/api/elfremote/proxy-config/[A-Za-z0-9-]{1,128}")
                ||!actual.getPath().equals(actual.toURI().getRawPath()))throw new SecurityException("proxy config origin rejected");return actual;}
    private static final class CancelInput extends FilterInputStream {private final Cancel cancel;CancelInput(InputStream in,Cancel cancel){super(in);this.cancel=cancel;}
        @Override public int read(byte[] b,int off,int len)throws IOException{if(cancel.cancelled())throw new InterruptedIOException("proxy task cancelled");return super.read(b,off,len);}
        @Override public int read()throws IOException{if(cancel.cancelled())throw new InterruptedIOException("proxy task cancelled");return super.read();}}
    private GatewayProxyConfigDownload(){}
}
