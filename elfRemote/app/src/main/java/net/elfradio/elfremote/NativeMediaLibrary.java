package net.elfradio.elfremote;

import android.content.Context;
import java.io.*;
import java.util.zip.*;

/** 系统组件不会自动展开APK的JNI目录，从本应用已验证APK按进程ABI加载。 */
final class NativeMediaLibrary implements org.webrtc.NativeLibraryLoader {
    private final Context context;
    NativeMediaLibrary(Context context){this.context=context;}
    static String entry(boolean is64Bit){return "lib/"+(is64Bit?"arm64-v8a":"armeabi-v7a")+"/libjingle_peerconnection_so.so";}
    @Override public synchronized boolean load(String name){
        if(!"jingle_peerconnection_so".equals(name))return false;
        String abi=android.os.Process.is64Bit()?"arm64-v8a":"armeabi-v7a";
        File directory=new File(context.getCodeCacheDir(),"media-native/"+BuildConfig.VERSION_CODE+"/"+abi);
        try(ZipFile apk=new ZipFile(context.getApplicationInfo().sourceDir)){
            ZipEntry entry=apk.getEntry(entry(android.os.Process.is64Bit()));
            if(entry==null||entry.getSize()<1||entry.getSize()>32L*1024*1024)throw new IOException("当前设备没有匹配的音视频原生库");
            if(!directory.isDirectory()&&!directory.mkdirs())throw new IOException("音视频库缓存目录不可用");
            File file=new File(directory,"libjingle_peerconnection_so.so");
            if(!matches(file,entry.getSize(),entry.getCrc())){
                File temporary=File.createTempFile("native-",".tmp",directory);
                try{
                    try(InputStream in=apk.getInputStream(entry);FileOutputStream out=new FileOutputStream(temporary)){
                        byte[] buffer=new byte[32768];int n;long length=0;
                        while((n=in.read(buffer))!=-1){length+=n;if(length>entry.getSize())throw new IOException("原生库长度不匹配");out.write(buffer,0,n);}out.getFD().sync();
                    }
                    if(!matches(temporary,entry.getSize(),entry.getCrc())||!temporary.setReadable(true,true)||!temporary.setExecutable(true,true)||!temporary.renameTo(file))throw new IOException("原生库缓存校验失败");
                }finally{temporary.delete();}
            }
            System.load(file.getAbsolutePath());RuntimeLog.event("media_native_loaded abi="+abi);return true;
        }catch(Exception|LinkageError e){RuntimeLog.error("media_native_load_failed",new Exception(e));return false;}
    }
    static boolean matches(File file,long size,long crc)throws IOException{
        if(!file.isFile()||file.length()!=size)return false;CRC32 actual=new CRC32();
        try(InputStream in=new FileInputStream(file)){byte[] b=new byte[32768];int n;while((n=in.read(b))!=-1)actual.update(b,0,n);}return actual.getValue()==crc;
    }
}
