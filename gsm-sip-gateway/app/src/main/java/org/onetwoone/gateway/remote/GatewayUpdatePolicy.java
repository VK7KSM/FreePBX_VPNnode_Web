package org.onetwoone.gateway.remote;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;
import org.json.JSONObject;

/** Artifact signature and task binding are separate; never rewrite signed bytes. */
final class GatewayUpdatePolicy {
    static final long MAX_BYTES=64L*1024*1024;
    static final String CERT="9b31f89fa50b672ecfe02d73a534cc03f6cf893739aec268f9fe0b71e72da72e";
    static final String PUBLIC_KEY =
            "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuHuRa52XY+MxbuXi5azn"
            + "9/MoJZEHiGi80WsQOr3ODkaqaLgdd9UBxjkj0dirBmTMGP3yNkm9LUjKxCAyhcd6"
            + "RlRe6I6PuFMx6eYOfGfYDu/VTtkCrAYiOJOnnynJfHF8Rul93mLyTA19Vx5S7FWW"
            + "JtWN43p0VRVU3YOuat97yWJS4xH2RAzNYz+fLK8GTHSYGdaedF6yiETAH9HB7TLs"
            + "c6v0ajptxVD/pU5q1zAWjllpTpcfcN97ma2Bpd82PohOTukFFhzkRO9ZJL5t2zpO"
            + "Aev2EdkUUH+FvzsMHDwg8po9Yb3tdw0OfDH5hhk7+Q+GUDV/A8sgANTIRa31Yajc"
            + "5QIDAQAB";
    static JSONObject validateOffer(JSONObject offer,String device,int installed,long now) throws Exception {
        String raw=offer.getString("manifest_raw");
        if(raw.length()>65536) throw new SecurityException("manifest too large");
        PublicKey key=KeyFactory.getInstance("RSA").generatePublic(new X509EncodedKeySpec(Base64.getDecoder().decode(PUBLIC_KEY)));
        if(!signatureValid(key,raw,offer.getString("signature"))) throw new SecurityException("manifest signature invalid");
        JSONObject manifest=new JSONObject(raw);
        validateFields(manifest,offer,device,installed,now);
        return manifest;
    }
    static boolean signatureValid(PublicKey key,String raw,String encoded) {
        try {
            Signature verifier=Signature.getInstance("SHA256withRSA");
            verifier.initVerify(key);verifier.update(raw.getBytes(StandardCharsets.UTF_8));
            if(encoded==null||!encoded.matches("[0-9a-fA-F]{512}"))return false;
            byte[] signature=new byte[256];
            for(int i=0;i<signature.length;i++)signature[i]=(byte)Integer.parseInt(encoded.substring(i*2,i*2+2),16);
            return verifier.verify(signature);
        } catch(Exception invalid) {return false;}
    }
    static void validateFields(JSONObject m,JSONObject offer,String device,int installed,long now) throws Exception {
        if(device==null||device.isEmpty()||!GatewayRemotePolicy.PRODUCT.equals(m.optString("product_id"))
                ||!"gateway".equals(m.optString("channel"))||!GatewayRemotePolicy.PACKAGE.equals(m.optString("package"))
                ||!"mdl_pixel3".equals(m.optString("model_id"))||!"arm64-v8a".equals(m.optString("abi"))
                ||!CERT.equals(m.optString("certSha256"))) throw new SecurityException("wrong product");
        if(m.optInt("versionCode",0)<=installed||m.optString("versionName").isEmpty()) throw new SecurityException("invalid version");
        if(m.optLong("size",0)<=0||m.optLong("size")>MAX_BYTES||!m.optString("sha256").matches("[0-9a-f]{64}"))
            throw new SecurityException("invalid artifact");
        if(m.optLong("expires_at",0)<=now||offer.optLong("task_expires_at",0)<=now) throw new SecurityException("expired");
        if(!device.equals(offer.optString("task_device_id")) || (m.has("device_id")&&!device.equals(m.optString("device_id"))))
            throw new SecurityException("wrong device");
        if(!offer.optString("task_id").matches("update-[a-zA-Z0-9-]{1,80}")) throw new SecurityException("invalid task");
        String job=m.optString("job_id");
        if(!job.matches("[a-zA-Z0-9-]{1,100}")) throw new SecurityException("invalid artifact id");
        URI uri=new URI(m.getString("url"));
        if(!"https".equals(uri.getScheme())||!"v.elfradio.net".equals(uri.getHost())||uri.getPort()!=-1
                ||uri.getRawUserInfo()!=null||uri.getRawQuery()!=null||uri.getRawFragment()!=null
                ||!("/api/elfremote/apk/"+job).equals(uri.getRawPath())) throw new SecurityException("invalid download origin");
    }
    private GatewayUpdatePolicy() {}
}
