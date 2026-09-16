package org.onetwoone.gateway.remote;

import android.content.Context;
import java.io.*;
import java.security.MessageDigest;
import org.json.JSONArray;
import org.json.JSONObject;

/** Verifies bundled Pixel recovery assets without installing or executing them. */
final class GatewayPixelAssets {
    private static final String ROOT="pixel_gateway_companion/";
    interface Source { InputStream open(String path) throws Exception; }

    static JSONObject verify(Context context) throws Exception {
        return verify(context.getAssets().open(ROOT+"manifest.json"),path->context.getAssets().open(ROOT+path));
    }

    static JSONObject verify(InputStream manifestInput,Source source) throws Exception {
        JSONObject manifest=new JSONObject(read(manifestInput,65536));
        if(manifest.optInt("schema_version")!=1||!"elfremote_gateway".equals(manifest.optString("product"))
                ||!"crosshatch".equals(manifest.optString("device"))
                ||!"do_not_replace_recognized_legacy_modules".equals(manifest.optString("deployment_policy")))
            throw new SecurityException("pixel asset manifest identity invalid");
        JSONArray files=manifest.optJSONArray("files");if(files==null||files.length()<1||files.length()>32)
            throw new SecurityException("pixel asset manifest file count invalid");
        java.util.HashSet<String> seen=new java.util.HashSet<>();
        for(int index=0;index<files.length();index++) {
            JSONObject entry=files.getJSONObject(index);String path=entry.optString("path");
            if(!path.matches("[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+){1,4}")||path.contains("..")||!seen.add(path))
                throw new SecurityException("pixel asset path invalid");
            long expectedSize=entry.optLong("size",-1);String expectedHash=entry.optString("sha256");
            if(expectedSize<1||expectedSize>65536||!expectedHash.matches("[0-9a-f]{64}"))
                throw new SecurityException("pixel asset metadata invalid");
            byte[] body;try(InputStream input=source.open(path)){body=readBytes(input,65536);}
            if(body.length!=expectedSize||!expectedHash.equals(sha256(body)))
                throw new SecurityException("pixel asset integrity mismatch");
        }
        return new JSONObject().put("verified",true).put("file_count",files.length())
                .put("deployment_policy",manifest.getString("deployment_policy"));
    }

    private static String read(InputStream input,int maximum) throws Exception {
        return new String(readBytes(input,maximum),java.nio.charset.StandardCharsets.UTF_8);
    }
    private static byte[] readBytes(InputStream input,int maximum) throws Exception {
        ByteArrayOutputStream output=new ByteArrayOutputStream();byte[] buffer=new byte[4096];
        for(int read;(read=input.read(buffer))!=-1;){output.write(buffer,0,read);if(output.size()>maximum)throw new IOException("pixel asset too large");}
        return output.toByteArray();
    }
    private static String sha256(byte[] body) throws Exception {
        StringBuilder text=new StringBuilder();for(byte value:MessageDigest.getInstance("SHA-256").digest(body))
            text.append(String.format(java.util.Locale.ROOT,"%02x",value&255));return text.toString();
    }
    private GatewayPixelAssets() {}
}
