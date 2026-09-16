package org.onetwoone.gateway.remote;

import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import org.json.JSONObject;

final class GatewayArtifactDownload {
    static void download(JSONObject verifiedManifest,File destination) throws Exception {
        HttpURLConnection connection=(HttpURLConnection)new URL(verifiedManifest.getString("url")).openConnection();
        connection.setInstanceFollowRedirects(false);connection.setConnectTimeout(15000);connection.setReadTimeout(20000);
        connection.setRequestProperty("User-Agent","elfRemote-Gateway/1.5.0");
        connection.setRequestProperty("Accept-Encoding","identity");
        try {
            if(connection.getResponseCode()!=200)throw new IOException("APK download HTTP "+connection.getResponseCode());
            long length=connection.getContentLengthLong();
            if(length!=-1&&length!=verifiedManifest.getLong("size"))throw new SecurityException("download length mismatch");
            try(InputStream input=connection.getInputStream()) {
                copyVerified(input,destination,verifiedManifest.getLong("size"),verifiedManifest.getString("sha256"),System.nanoTime()+300_000_000_000L);
            }
        } finally {connection.disconnect();}
    }
    static void copyVerified(InputStream source,File destination,long expected,String hash,long deadline) throws Exception {
        if(expected<=0||expected>GatewayUpdatePolicy.MAX_BYTES||!hash.matches("[0-9a-f]{64}"))throw new SecurityException("invalid download contract");
        File parent=destination.getParentFile();
        if(parent==null||!parent.isDirectory()||!destination.getAbsoluteFile().equals(destination.getCanonicalFile()))
            throw new IOException("invalid staging path");
        if(destination.exists()) {
            if(destination.length()==expected&&hash.equals(GatewayApkVerifier.sha256(destination)))return;
            throw new SecurityException("existing artifact differs");
        }
        File partial=File.createTempFile("gateway-download-",".part",parent);
        try {
            long total=0;
            try(FileOutputStream output=new FileOutputStream(partial)) {
                byte[] buffer=new byte[65536];int count;
                while((count=source.read(buffer))!=-1) {
                    if(System.nanoTime()>deadline)throw new IOException("download deadline exceeded");
                    total+=count;if(total>expected)throw new SecurityException("download oversized");
                    output.write(buffer,0,count);
                }
                output.getFD().sync();
            }
            if(System.nanoTime()>deadline)throw new IOException("download deadline exceeded");
            if(total!=expected||!hash.equals(GatewayApkVerifier.sha256(partial)))throw new SecurityException("download integrity failed");
            if(destination.exists()||!partial.renameTo(destination))throw new IOException("artifact commit failed");
        } finally {if(partial.exists()&&!partial.delete())throw new IOException("partial cleanup failed");}
    }
    private GatewayArtifactDownload() {}
}
