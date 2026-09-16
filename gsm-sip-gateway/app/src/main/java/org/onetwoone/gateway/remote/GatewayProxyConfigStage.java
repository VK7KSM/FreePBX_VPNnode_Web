package org.onetwoone.gateway.remote;

import android.content.Context;
import java.io.File;
import java.io.InputStream;

/** Stages an opaque configuration by digest; configuration contents never enter preferences or task receipts. */
final class GatewayProxyConfigStage {
    static File destination(Context context,String sha256)throws Exception {
        if(sha256==null||!sha256.matches("[0-9a-f]{64}"))throw new SecurityException("invalid proxy config digest");
        File root=new File(context.getFilesDir(),"proxy-config");if(!root.isDirectory()&&!root.mkdirs())throw new java.io.IOException("proxy config directory unavailable");
        return new File(root,sha256+".yaml").getCanonicalFile();
    }
    static File stage(Context context,InputStream source,long size,String sha256)throws Exception {
        if(size<2||size>GatewayProxyPolicy.MAX_CONFIG_BYTES)throw new SecurityException("invalid proxy config size");File target=destination(context,sha256);
        if(GatewayProxyAssets.valid(target,size,sha256))return target;
        if(target.exists()&&!target.delete())throw new java.io.IOException("proxy config replacement unavailable");
        File next=new File(target.getPath()+".new");if(next.exists()&&!next.delete())throw new java.io.IOException("proxy config temporary cleanup failed");
        try{GatewayProxyAssets.copyVerified(source,next,size,sha256,size);if(!next.renameTo(target))throw new java.io.IOException("proxy config commit failed");
            if(!target.setReadable(true,true)||!target.setWritable(true,true))throw new java.io.IOException("proxy config permissions unavailable");return target;}
        finally{if(next.exists()&&!next.delete())throw new java.io.IOException("proxy config temporary cleanup failed");}
    }
    private GatewayProxyConfigStage(){}
}
