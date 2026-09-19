package org.onetwoone.gateway.remote;

import android.content.Context;
import java.io.*;

/**
 * 官方 scrcpy 服务端随 APK 原样分发（Apache-2.0，版本永久固定）。
 * 应用侧把它解到私有暂存目录，核心（root）校验哈希后复制到 uid 2000 可读的桌面目录。
 * 核心目录 {@link GatewayCoreClient#DIR} 里存着核心认证口令，保持 0700 不放宽；
 * scrcpy 另放同级的 desktop 目录，只给 0711 目录加 0644 文件，让 uid 2000 能读到它、读不到别的。
 */
final class GatewayScrcpyAsset {
    static final String VERSION="3.3.3";
    static final long SIZE=90_164L;
    static final String SHA256="7e70323ba7f259649dd4acce97ac4fefbae8102b2c6d91e2e7be613fd5354be0";
    static final String ASSET="scrcpy-server";
    static final String PARENT="/data/local/elfremote-gateway";
    static final String ROOT=PARENT+"/desktop";
    static final String TARGET=ROOT+"/scrcpy-server";

    /** 应用侧：解到私有暂存目录；已存在且哈希正确则直接复用。 */
    static File stage(Context context)throws Exception {
        File root=new File(context.getFilesDir(),"desktop-core");
        if(!root.isDirectory()&&!root.mkdirs())throw new IOException("scrcpy asset directory unavailable");
        File target=new File(root,ASSET+"-"+VERSION);
        if(GatewayProxyAssets.valid(target,SIZE,SHA256))return target;
        File next=new File(root,ASSET+".new");
        if(next.exists()&&!next.delete())throw new IOException("scrcpy temporary cleanup failed");
        try(InputStream source=context.getAssets().open(ASSET)){GatewayProxyAssets.copyVerified(source,next,SIZE,SHA256,SIZE);}
        if(target.exists()&&!target.delete())throw new IOException("scrcpy asset replacement unavailable");
        if(!next.renameTo(target))throw new IOException("scrcpy asset commit failed");
        if(!target.setReadable(true,true))throw new IOException("scrcpy asset permissions unavailable");
        return target;
    }

    static File stagedFile(Context context){return new File(new File(context.getFilesDir(),"desktop-core"),ASSET+"-"+VERSION);}

    /** 核心只接受应用私有目录里这一个固定路径，杜绝用请求参数指到任意文件。 */
    static boolean safeSource(String value){
        if(value==null||value.indexOf('\0')>=0)return false;
        return value.matches("/data/(?:user/0|data)/org\\.onetwoone\\.gateway/files/desktop-core/scrcpy-server-3\\.3\\.3");
    }

    /** 核心内自检：目标存在、大小与哈希都对，才允许拉起屏幕服务。 */
    static boolean verifyInstalled(){
        try{return GatewayProxyAssets.valid(new File(TARGET),SIZE,SHA256);}catch(Exception unavailable){return false;}
    }

    private GatewayScrcpyAsset(){}
}
