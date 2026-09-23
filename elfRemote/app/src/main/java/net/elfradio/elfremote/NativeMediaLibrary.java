package net.elfradio.elfremote;

import android.content.Context;
import java.io.*;
import java.security.MessageDigest;
import java.util.zip.*;
import org.json.JSONObject;

/**
 * 加载 WebRTC 原生库。
 *
 * 这个库有 12 MB，占整包 95%，但只有通信终端与远程桌面用得到。所以一个版本出两个包：
 * 全量包自带它（供首次装机，不依赖任何网络），精简包不带（做日常更新，约 0.8 MB）。
 *
 * 落盘位置是 getFilesDir()，不是 getCodeCacheDir()——**系统在应用升级时会清空 codeCacheDir**，
 * 而 files 目录在替换 /system/app 下的 APK 再重启之后仍然存在。早先的版本用的是 codeCacheDir，
 * 所以库只是「每次升级重新从 APK 里解一遍」，精简包一来就什么都不剩了。
 *
 * 查找顺序，先近后远：
 *   1. files 目录里已有、且与期望的哈希一致 → 直接加载，一次网络请求都没有
 *   2. 自己的 APK 里有（装的是全量包）→ 解出来落盘 → 加载
 *   3. 都没有（装的是精简包、机器上还没库）→ 从自有服务器下载，验哈希后落盘 → 加载
 * 四条都不成立时返回 false，媒体与远程桌面不可用，其余功能照常。
 */
final class NativeMediaLibrary implements org.webrtc.NativeLibraryLoader {
    static final String LIB = "libjingle_peerconnection_so.so";
    /** 精简包里由打包工具写入，说明它需要哪一份库。全量包没有这个文件——它自带库。 */
    static final String IDENTITY_ASSET = "assets/media-native.json";
    private static final long MAX_BYTES = 32L * 1024 * 1024;
    private static volatile String lastFailure = "";
    // 校验一次 12 MB 要读满整个文件。进程内确认过就记住，别让每五分钟一次的上报
    // 都去重算一遍哈希；进程重启会重新校验，落盘损坏照样发现得了。
    private static volatile boolean confirmed;

    private final Context context;
    NativeMediaLibrary(Context context){this.context=context;}

    static String abi(){return android.os.Process.is64Bit()?"arm64-v8a":"armeabi-v7a";}
    static String entry(boolean is64Bit){return "lib/"+(is64Bit?"arm64-v8a":"armeabi-v7a")+"/"+LIB;}

    /** 库不在且取不回来时，面板据此把媒体与远程桌面的按钮置灰，而不是让人点了莫名失败。 */
    static String lastFailure(){return lastFailure;}

    private File target(){
        return new File(new File(context.getFilesDir(),"media-native/"+abi()),LIB);
    }

    @Override public synchronized boolean load(String name){
        if(!"jingle_peerconnection_so".equals(name))return false;
        try{
            if(!resolve(true))return false;
            System.load(target().getAbsolutePath());
            lastFailure="";return true;
        }catch(Exception|LinkageError e){
            lastFailure="load_failed";
            RuntimeLog.error("media_native_load_failed",new Exception(e));
            return false;
        }
    }

    /**
     * 把库弄到位，但不加载。
     *
     * 必须在后台提前跑：装了精简包又没有本地库的机器要下 12 MB，
     * 等管理员按下「通信」那一刻才开始下载，等到的只会是一个超时。
     * allowNetwork=false 时只查本地与自带包，绝不联网——上报路径用的是这一种。
     */
    synchronized boolean resolve(boolean allowNetwork){
        if(confirmed)return true;
        File file=target();
        JSONObject identity=identity();
        try{
            // 1. 本地已有且哈希对得上——设备静置时每次启动都走这条，不产生任何流量。
            if(identity!=null&&matches(file,identity.getLong("size"),identity.getString("sha256"))){
                lastFailure="";confirmed=true;return true;
            }
            if(identity==null&&file.isFile()&&file.length()>0){
                // 没有身份信息（极旧的包）时退回「有就用」，不至于把已经能用的设备弄坏。
                lastFailure="";confirmed=true;return true;
            }
            // 2. 装的是全量包：从自己的 APK 里解出来。系统应用不会自动展开 JNI 目录，所以要手解。
            if(extractFromApk(file)){
                RuntimeLog.event("media_native_ready source=apk abi="+abi());
                lastFailure="";confirmed=true;return true;
            }
            // 3. 装的是精简包且本地还没有：按身份信息去自有服务器取。
            //    先看空间：库要占临时文件与就位文件两份地方。空间不够就不下载——
            //    以前每次上报都再下一遍、写到一半失败再删，移动数据上持续放血；
            //    现在报 no_space 停在这里，下一次上报再看一眼空间（看空间不花流量）。
            if(identity!=null&&!enoughSpace(context.getFilesDir(),identity.getLong("size"))){
                lastFailure="no_space";return false;
            }
            if(allowNetwork&&identity!=null&&download(file,identity)){
                RuntimeLog.event("media_native_ready source=download abi="+abi());
                lastFailure="";confirmed=true;return true;
            }
            lastFailure=identity==null?"no_identity":(allowNetwork?"unavailable":"pending_download");
            return false;
        }catch(Exception e){
            lastFailure="resolve_failed";
            RuntimeLog.error("media_native_resolve_failed",new Exception(e));
            return false;
        }
    }

    /** 上报用：只看本地，不联网。没有库时通信与远程桌面按钮应当是灰的。 */
    static boolean ready(Context context){
        try{ return new NativeMediaLibrary(context).resolve(false); }
        catch(Exception e){ return false; }
    }

    /** 开机/上报线程里调一次，缺库时在后台补齐。已经有库的机器是一次哈希校验的事。 */
    static void prepare(final Context context){
        new Thread(new Runnable(){ @Override public void run(){
            try{ new NativeMediaLibrary(context).resolve(true); }
            catch(Exception e){ RuntimeLog.error("media_native_prepare_failed",new Exception(e)); }
        }},"media-native-prepare").start();
    }

    /** 精简包里的身份文件；全量包没有，此时用 APK 内那份库现算，两边走同一套校验。 */
    private JSONObject identity(){
        try(ZipFile apk=new ZipFile(context.getApplicationInfo().sourceDir)){
            ZipEntry meta=apk.getEntry(IDENTITY_ASSET);
            if(meta!=null){
                try(InputStream in=apk.getInputStream(meta)){
                    return new JSONObject(new String(readAll(in,8192),"UTF-8"));
                }
            }
            ZipEntry lib=apk.getEntry(entry(android.os.Process.is64Bit()));
            if(lib==null||lib.getSize()<1||lib.getSize()>MAX_BYTES)return null;
            try(InputStream in=apk.getInputStream(lib)){
                return new JSONObject().put("abi",abi()).put("name",LIB)
                    .put("size",lib.getSize()).put("sha256",hex(digest(in,null)));
            }
        }catch(Exception e){return null;}
    }

    private boolean extractFromApk(File file)throws Exception{
        try(ZipFile apk=new ZipFile(context.getApplicationInfo().sourceDir)){
            ZipEntry entry=apk.getEntry(entry(android.os.Process.is64Bit()));
            if(entry==null||entry.getSize()<1||entry.getSize()>MAX_BYTES)return false;
            try(InputStream in=apk.getInputStream(entry)){return install(file,in,entry.getSize(),null);}
        }
    }

    private boolean download(File file,JSONObject identity){
        File staged=null;
        try{
            JSONObject offer=MediaNativeManifest.fetch(context,identity);
            if(offer==null)return false;
            File directory=file.getParentFile();
            if(!directory.isDirectory()&&!directory.mkdirs())throw new IOException("音视频库目录不可用");
            staged=File.createTempFile("native-dl-",".tmp",directory);
            // 走 HttpJson 而不是自己开连接：证书校验、禁跳转、长度上限那几条约束
            // 已经在那里统一实现过一次，这里再写一遍迟早会写漏其中一条。
            HttpJson.download(offer.getString("url"),staged,MAX_BYTES);
            try(InputStream in=new FileInputStream(staged)){
                return install(file,in,identity.getLong("size"),identity.getString("sha256"));
            }
        }catch(Exception e){
            RuntimeLog.error("media_native_download_failed",new Exception(e));return false;
        }finally{ if(staged!=null)staged.delete(); }
    }

    /** 下载 + 就位要两份空间，再留 16 MB 给日志与数据库正常增长，别把机器塞到一字节不剩。 */
    static long requiredSpace(long size){return size*2+16L*1024*1024;}
    /** 目录可能还没建：往上找到第一个存在的祖先再问剩余空间。 */
    static boolean enoughSpace(File directory,long size){
        File probe=directory;
        while(probe!=null&&!probe.exists())probe=probe.getParentFile();
        if(probe==null)return false;
        long usable=probe.getUsableSpace();
        // 个别文件系统答 0 表示「不知道」而不是「没有」；此时不拦，交给写入本身去失败。
        return usable<=0||usable>=requiredSpace(size);
    }

    /** 先写临时文件、校验通过才改名就位：半截文件绝不能被当成可用的库加载。 */
    private boolean install(File file,InputStream in,long size,String expected)throws Exception{
        File directory=file.getParentFile();
        if(!directory.isDirectory()&&!directory.mkdirs())throw new IOException("音视频库目录不可用");
        File temporary=File.createTempFile("native-",".tmp",directory);
        try{
            MessageDigest sha=MessageDigest.getInstance("SHA-256");
            long length=0;
            try(FileOutputStream out=new FileOutputStream(temporary)){
                byte[] buffer=new byte[32768];int n;
                while((n=in.read(buffer))!=-1){
                    length+=n;if(length>size)throw new IOException("原生库长度超出预期");
                    sha.update(buffer,0,n);out.write(buffer,0,n);
                }
                out.getFD().sync();
            }
            if(length!=size)throw new IOException("原生库长度不匹配");
            if(expected!=null&&!expected.equals(hex(sha.digest())))throw new IOException("原生库哈希不匹配");
            if(!temporary.setReadable(true,true)||!temporary.setExecutable(true,true))throw new IOException("原生库权限设置失败");
            File previous=new File(file.getAbsolutePath()+".old");
            if(file.isFile()&&!file.renameTo(previous))file.delete();
            if(!temporary.renameTo(file))throw new IOException("原生库就位失败");
            previous.delete();
            return true;
        }finally{ temporary.delete(); }
    }

    static boolean matches(File file,long size,String sha256){
        if(!file.isFile()||file.length()!=size)return false;
        try(InputStream in=new FileInputStream(file)){
            return sha256!=null&&sha256.equals(hex(digest(in,null)));
        }catch(Exception e){return false;}
    }

    private static byte[] digest(InputStream in,MessageDigest reuse)throws Exception{
        MessageDigest sha=reuse!=null?reuse:MessageDigest.getInstance("SHA-256");
        byte[] buffer=new byte[32768];int n;
        while((n=in.read(buffer))!=-1)sha.update(buffer,0,n);
        return sha.digest();
    }

    private static byte[] readAll(InputStream in,int limit)throws IOException{
        ByteArrayOutputStream out=new ByteArrayOutputStream();
        byte[] buffer=new byte[4096];int n;
        while((n=in.read(buffer))!=-1){out.write(buffer,0,n);if(out.size()>limit)throw new IOException("内容过长");}
        return out.toByteArray();
    }

    static String hex(byte[] bytes){
        StringBuilder text=new StringBuilder(bytes.length*2);
        for(byte b:bytes)text.append(Character.forDigit((b>>4)&0xf,16)).append(Character.forDigit(b&0xf,16));
        return text.toString();
    }
}
