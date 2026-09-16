package org.onetwoone.gateway.remote;

import android.content.Context;
import java.io.*;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.zip.GZIPInputStream;
import org.json.JSONObject;

/** Verifies and atomically stages the bundled proxy core without starting it. */
final class GatewayProxyAssets {
    static final String VERSION="v1.19.31";
    static final long COMPRESSED_SIZE=21_808_349L,EXECUTABLE_SIZE=63_866_712L;
    static final String COMPRESSED_SHA256="de00bc53ed151636ca078c812a82a5315687d8d52164db230f1935b2a37904f6";
    static final String EXECUTABLE_SHA256="dbd8af275219a097d66362d543b32f65ba0d4de9d96a49bf5e9abdcdad3af6f1";
    private static final String ASSET="proxy/mihomo-android-arm64-v8-v1.19.31.dat";

    static JSONObject stage(Context context)throws Exception {
        File root=new File(context.getFilesDir(),"proxy-core"),target=stagedFile(context);
        if(!root.isDirectory()&&!root.mkdirs())throw new IOException("proxy asset directory unavailable");
        if(valid(target,EXECUTABLE_SIZE,EXECUTABLE_SHA256))return status(target,true);
        File compressed=new File(root,"core.gz.new"),expanded=new File(root,"core.new");delete(compressed);delete(expanded);
        try(InputStream source=context.getAssets().open(ASSET)){copyVerified(source,compressed,COMPRESSED_SIZE,COMPRESSED_SHA256,COMPRESSED_SIZE);}
        try(InputStream source=new GZIPInputStream(new BufferedInputStream(new FileInputStream(compressed)))){
            copyVerified(source,expanded,EXECUTABLE_SIZE,EXECUTABLE_SHA256,EXECUTABLE_SIZE);
        } finally {delete(compressed);}
        if(target.exists()&&!target.delete())throw new IOException("proxy asset replacement unavailable");
        if(!expanded.renameTo(target))throw new IOException("proxy asset commit failed");
        if(!target.setReadable(true,true)||!target.setExecutable(true,true))throw new IOException("proxy asset permissions unavailable");
        return status(target,true);
    }
    static File stagedFile(Context context){return new File(new File(context.getFilesDir(),"proxy-core"),"mihomo-"+VERSION);}
    static JSONObject manifest(Context context)throws Exception {
        try(InputStream input=context.getAssets().open("proxy/manifest.json")){byte[] bytes=read(input,4096);JSONObject value=new JSONObject(new String(bytes,java.nio.charset.StandardCharsets.UTF_8));
            if(value.optInt("schema_version")!=1||!VERSION.equals(value.optString("version"))||!"arm64-v8a".equals(value.optString("abi"))
                    ||value.optLong("compressed_size")!=COMPRESSED_SIZE||value.optLong("executable_size")!=EXECUTABLE_SIZE
                    ||!COMPRESSED_SHA256.equals(value.optString("compressed_sha256"))||!EXECUTABLE_SHA256.equals(value.optString("executable_sha256")))
                throw new SecurityException("proxy manifest mismatch");return value;}
    }
    static void copyVerified(InputStream source,File target,long expectedSize,String expectedHash,long maximum)throws Exception {
        MessageDigest digest=MessageDigest.getInstance("SHA-256");long total=0;byte[] buffer=new byte[65536];
        try(FileOutputStream output=new FileOutputStream(target)){for(int count;(count=source.read(buffer))!=-1;){total+=count;if(total>maximum)throw new IOException("proxy asset too large");output.write(buffer,0,count);digest.update(buffer,0,count);}output.getFD().sync();}
        if(total!=expectedSize||!expectedHash.equals(hex(digest.digest()))){delete(target);throw new SecurityException("proxy asset integrity mismatch");}
    }
    static boolean valid(File file,long size,String hash)throws Exception {
        if(!file.isFile()||file.length()!=size)return false;MessageDigest digest=MessageDigest.getInstance("SHA-256");byte[] buffer=new byte[65536];
        try(InputStream input=new BufferedInputStream(new FileInputStream(file))){for(int count;(count=input.read(buffer))!=-1;)digest.update(buffer,0,count);}
        return hash.equals(hex(digest.digest()));
    }
    private static JSONObject status(File target,boolean verified)throws Exception{return new JSONObject().put("schema_version",1).put("bundled",true).put("version",VERSION)
            .put("abi","arm64-v8a").put("verified",verified).put("executable_size",target.length()).put("write_locked",true);}
    private static byte[] read(InputStream input,int maximum)throws Exception {ByteArrayOutputStream output=new ByteArrayOutputStream();byte[] buffer=new byte[1024];for(int count;(count=input.read(buffer))!=-1;){output.write(buffer,0,count);if(output.size()>maximum)throw new IOException("proxy manifest too large");}return output.toByteArray();}
    private static String hex(byte[] bytes){StringBuilder value=new StringBuilder();for(byte b:bytes)value.append(String.format(Locale.ROOT,"%02x",b&255));return value.toString();}
    private static void delete(File file)throws IOException {if(file.exists()&&!file.delete())throw new IOException("proxy temporary cleanup failed");}
    private GatewayProxyAssets(){}
}
