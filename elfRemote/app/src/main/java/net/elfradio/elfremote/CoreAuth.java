package net.elfradio.elfremote;

import java.io.*;
import java.security.*;
import java.nio.charset.StandardCharsets;

/** 私有随机凭据认证本机调用；回环地址与UID防火墙不代替认证。 */
final class CoreAuth {
    static final String NAME="core-auth-token";
    static boolean authorized(String token,String header){
        if(token==null||!token.matches("[a-f0-9]{64}")||header==null)return false;
        return MessageDigest.isEqual(("Bearer "+token).getBytes(StandardCharsets.US_ASCII),header.getBytes(StandardCharsets.US_ASCII));
    }
    static boolean allowed(File file,String header){try{return authorized(read(file),header);}catch(Exception unavailable){return false;}}
    static synchronized String ensure(File folder)throws Exception {
        File f=new File(folder,NAME);
        if(!f.isFile()){
            byte[] bytes=new byte[32];new SecureRandom().nextBytes(bytes);StringBuilder text=new StringBuilder();
            for(byte b:bytes)text.append(String.format(java.util.Locale.US,"%02x",b&255));
            RescueFiles.write(f,text.toString());
            f.setReadable(false,false);f.setWritable(false,false);f.setReadable(true,true);f.setWritable(true,true);
        }
        return read(f);
    }
    static String read(File file)throws Exception {
        String token=RescueFiles.read(file,128).trim();if(!token.matches("[a-f0-9]{64}"))throw new IOException("core-auth-unavailable");return token;
    }
    private CoreAuth(){}
}
