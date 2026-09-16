package org.onetwoone.gateway.remote;

import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import java.io.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import org.json.JSONObject;

final class GatewayApkVerifier {
    static String sha256(File file) throws Exception {
        MessageDigest digest=MessageDigest.getInstance("SHA-256");
        try(InputStream input=new FileInputStream(file)) {
            byte[] buffer=new byte[65536];int count;
            while((count=input.read(buffer))!=-1)digest.update(buffer,0,count);
        }
        return hex(digest.digest());
    }
    private static String hex(byte[] bytes) {
        StringBuilder value=new StringBuilder();
        for(byte b:bytes)value.append(String.format(Locale.ROOT,"%02x",b&255));
        return value.toString();
    }
    @SuppressWarnings("deprecation")
    static JSONObject inspect(PackageManager pm,File apk) throws Exception {
        if(!apk.isFile()||apk.length()<=0||apk.length()>GatewayUpdatePolicy.MAX_BYTES)throw new IOException("invalid APK size");
        PackageInfo info=pm.getPackageArchiveInfo(apk.getCanonicalPath(),PackageManager.GET_SIGNATURES);
        if(info==null||info.signatures==null||info.signatures.length!=1)throw new SecurityException("APK signature unavailable");
        String certificate=hex(MessageDigest.getInstance("SHA-256").digest(info.signatures[0].toByteArray()));
        if(!GatewayRemotePolicy.PACKAGE.equals(info.packageName)||!GatewayUpdatePolicy.CERT.equals(certificate))
            throw new SecurityException("APK identity mismatch");
        verifyNativeLibraries(apk);
        return new JSONObject().put("package",info.packageName).put("versionCode",info.versionCode)
                .put("versionName",info.versionName).put("certSha256",certificate).put("abi","arm64-v8a")
                .put("size",apk.length()).put("sha256",sha256(apk));
    }
    static void verifyNativeLibraries(File apk) throws Exception {
        Set<String> names=new HashSet<>();
        try(ZipFile zip=new ZipFile(apk)) {
            Enumeration<? extends ZipEntry> entries=zip.entries();
            while(entries.hasMoreElements()) {
                ZipEntry entry=entries.nextElement();String name=entry.getName();
                if(!names.add(name))throw new SecurityException("duplicate APK entry");
                if(name.startsWith("lib/")&&!entry.isDirectory()) {
                    if(!name.startsWith("lib/arm64-v8a/")||!name.endsWith(".so"))throw new SecurityException("unexpected APK ABI");
                    try(InputStream input=zip.getInputStream(entry)) {
                        byte[] header=new byte[20];int read=0;
                        while(read<header.length){int count=input.read(header,read,header.length-read);if(count<0)break;read+=count;}
                        if(read!=20||header[0]!=0x7f||header[1]!='E'||header[2]!='L'||header[3]!='F'
                                ||header[4]!=2||header[5]!=1||(header[18]&255)!=183||header[19]!=0)
                            throw new SecurityException("invalid arm64 ELF");
                    }
                }
            }
        }
        for(String library:new String[]{"libpjsua2.so","libgsm_audio.so","libc++_shared.so"})
            if(!names.contains("lib/arm64-v8a/"+library))throw new SecurityException("gateway native library missing");
    }
    static void matches(JSONObject actual,JSONObject manifest) {
        for(String field:new String[]{"package","versionName","certSha256","abi","sha256"})
            if(!actual.optString(field).equals(manifest.optString(field)))throw new SecurityException("APK manifest mismatch: "+field);
        if(actual.optLong("size")!=manifest.optLong("size")||actual.optInt("versionCode")!=manifest.optInt("versionCode"))
            throw new SecurityException("APK version or size mismatch");
    }
    private GatewayApkVerifier() {}
}
