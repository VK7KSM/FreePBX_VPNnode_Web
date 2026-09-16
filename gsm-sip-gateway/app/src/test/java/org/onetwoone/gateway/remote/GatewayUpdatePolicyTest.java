package org.onetwoone.gateway.remote;

import java.security.*;
import java.util.Base64;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE,sdk=28)
public class GatewayUpdatePolicyTest {
    private JSONObject manifest() throws Exception {
        return new JSONObject().put("product_id","elfremote_gateway").put("channel","gateway")
                .put("package","org.onetwoone.gateway").put("model_id","mdl_pixel3").put("abi","arm64-v8a")
                .put("certSha256",GatewayUpdatePolicy.CERT).put("versionCode",10).put("versionName","test")
                .put("size",1024).put("sha256",GatewayUpdatePolicy.CERT).put("expires_at",2000)
                .put("job_id","artifact-1").put("url","https://v.elfradio.net/api/elfremote/apk/artifact-1");
    }
    private JSONObject task() throws Exception {return new JSONObject().put("task_id","update-test").put("task_device_id","test-device").put("task_expires_at",2000);}
    private void rejected(JSONObject m,JSONObject t) throws Exception {
        try {GatewayUpdatePolicy.validateFields(m,t,"test-device",9,1000);fail("invalid offer accepted");}
        catch(SecurityException expected) { }
    }
    @Test public void acceptsBoundGatewayArtifact() throws Exception {GatewayUpdatePolicy.validateFields(manifest(),task(),"test-device",9,1000);}
    @Test public void rejectsForeignProductAndExpiredTasks() throws Exception {
        rejected(manifest().put("channel","d22"),task());
        rejected(manifest().put("package","net.elfradio.elfremote"),task());
        rejected(manifest().put("abi","armeabi-v7a"),task());
        rejected(manifest().put("versionCode",9),task());
        rejected(manifest().put("expires_at",1000),task());
        rejected(manifest(),task().put("task_expires_at",1000));
        rejected(manifest(),task().put("task_device_id","other-device"));
        rejected(manifest().put("device_id","other-device"),task());
        rejected(manifest().put("size",GatewayUpdatePolicy.MAX_BYTES+1),task());
    }
    @Test public void rejectsDownloadOriginConfusion() throws Exception {
        for(String url:new String[]{"http://v.elfradio.net/api/elfremote/apk/artifact-1","https://v.elfradio.net.evil.test/api/elfremote/apk/artifact-1",
                "https://v.elfradio.net/api/elfremote/apk/../artifact-1","https://v.elfradio.net/api/elfremote/apk/artifact-1?target=other"}) {
            rejected(manifest().put("url",url),task());
        }
    }
    @Test public void signatureCoversExactOriginalBytes() throws Exception {
        KeyPairGenerator generator=KeyPairGenerator.getInstance("RSA");generator.initialize(2048);KeyPair pair=generator.generateKeyPair();
        String raw=manifest().toString();Signature signer=Signature.getInstance("SHA256withRSA");
        signer.initSign(pair.getPrivate());signer.update(raw.getBytes("UTF-8"));byte[] bytes=signer.sign();
        StringBuilder hex=new StringBuilder();for(byte b:bytes)hex.append(String.format(java.util.Locale.ROOT,"%02x",b&255));
        String signature=hex.toString();
        assertTrue(GatewayUpdatePolicy.signatureValid(pair.getPublic(),raw,signature));
        assertFalse(GatewayUpdatePolicy.signatureValid(pair.getPublic(),raw+" ",signature));
        assertFalse(GatewayUpdatePolicy.signatureValid(pair.getPublic(),raw,"invalid"));
        assertFalse(GatewayUpdatePolicy.signatureValid(pair.getPublic(),raw,Base64.getEncoder().encodeToString(bytes)));
    }
}
