package org.onetwoone.gateway.remote;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.LinkedHashMap;
import java.util.Map;
import org.json.JSONObject;

/** Read-only recognition of the already deployed Pixel production modules. */
final class GatewayPixelLegacyHealth {
    private static final String CHARGE_ID="pixel_charge_bypass";
    private static final String AUDIO_ID="pixel_sip_audio_access";
    private static final Map<String,Map<String,String>> EXPECTED=new LinkedHashMap<>();
    static {
        Map<String,String> charge=new LinkedHashMap<>();
        charge.put("module.prop","76869ebbddafa30fea1410c9e071ec286ce68b9df2d03fd9da578d426538f27e");
        charge.put("service.sh","7f63103fbae50fa33a2af9b2cf2b884194aa2a86bd1a26e491c092812cd60ce8");
        EXPECTED.put(CHARGE_ID,charge);
        Map<String,String> audio=new LinkedHashMap<>();
        audio.put("module.prop","70691df7c0646227de658ff3813ebb5e31ab354fc70d3d31a93157fd455f3da7");
        audio.put("post-fs-data.sh","c6e23a8195bc3200401709de135221d9c41bf1cc63c887d1679b895851d1ad7e");
        audio.put("service.sh","6233f74763ee3566733689fecdc64a652214360146b1cb5b9fe1cf7ebb98a5be");
        audio.put("sepolicy.rule","86032c436541f7b0a0d0e93dc7e63ade877bfd953b46521c0696c022dd9690b1");
        EXPECTED.put(AUDIO_ID,audio);
    }

    static JSONObject snapshot() throws Exception {
        return snapshot(new File("/data/adb/modules"));
    }

    static JSONObject snapshot(File modulesRoot) throws Exception {
        JSONObject charge=module(modulesRoot,CHARGE_ID);
        JSONObject audio=module(modulesRoot,AUDIO_ID);
        boolean recognized=charge.optBoolean("recognized")&&audio.optBoolean("recognized");
        boolean enabled=recognized&&!charge.optBoolean("disabled")&&!audio.optBoolean("disabled");
        return new JSONObject().put("mode","legacy_managed")
                .put("recognized",recognized).put("enabled",enabled).put("write_locked",true)
                .put("charge_bypass",charge).put("sip_audio_access",audio);
    }

    private static JSONObject module(File root,String expectedId) throws Exception {
        File directory=new File(root,expectedId),property=new File(directory,"module.prop");
        JSONObject result=new JSONObject().put("id",expectedId).put("installed",directory.isDirectory())
                .put("disabled",new File(directory,"disable").isFile()).put("recognized",false);
        if(!directory.isDirectory()||!property.isFile())return result;
        Map<String,String> values=properties(property);
        String actualId=values.get("id"),version=values.get("version");
        if(version!=null&&!version.isEmpty())result.put("version",bounded(version,64));
        boolean filesVerified=true;
        for(Map.Entry<String,String> entry:EXPECTED.get(expectedId).entrySet()) {
            File file=new File(directory,entry.getKey());
            if(!file.isFile()||!entry.getValue().equals(sha256(file))){filesVerified=false;break;}
        }
        result.put("files_verified",filesVerified);
        result.put("recognized",expectedId.equals(actualId)&&filesVerified);
        return result;
    }

    private static Map<String,String> properties(File file) throws Exception {
        if(file.length()<1||file.length()>4096)throw new IOException("module metadata size invalid");
        Map<String,String> result=new LinkedHashMap<>();
        try(BufferedReader reader=new BufferedReader(new InputStreamReader(new FileInputStream(file),StandardCharsets.UTF_8))) {
            for(String line;(line=reader.readLine())!=null;) {
                int split=line.indexOf('=');if(split<=0)continue;
                String key=line.substring(0,split).trim(),value=line.substring(split+1).trim();
                if(key.matches("[A-Za-z0-9_.-]{1,64}"))result.put(key,bounded(value,256));
            }
        }
        return result;
    }

    private static String bounded(String value,int length) throws IOException {
        if(value.length()>length)throw new IOException("module metadata value too long");
        return value;
    }

    private static String sha256(File file) throws Exception {
        if(file.length()<1||file.length()>65536)throw new IOException("module file size invalid");
        MessageDigest digest=MessageDigest.getInstance("SHA-256");
        try(InputStream input=new FileInputStream(file)) {
            byte[] buffer=new byte[4096];for(int read;(read=input.read(buffer))!=-1;)digest.update(buffer,0,read);
        }
        StringBuilder text=new StringBuilder();for(byte value:digest.digest())text.append(String.format(java.util.Locale.ROOT,"%02x",value&255));
        return text.toString();
    }

    private GatewayPixelLegacyHealth() {}
}
