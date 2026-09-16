package org.onetwoone.gateway.remote;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE,sdk=28)
public class GatewayPixelStatusTest {
    @Test public void emitsOnlyTheApprovedHealthyFields() throws Exception {
        JSONObject input=healthy().put("secret_path","/data/adb/modules/private")
                .put("charge_bypass",healthy().getJSONObject("charge_bypass").put("sha256","private-hash"));
        JSONObject result=GatewayPixelStatus.snapshot(true,input.toString(),"");
        assertEquals(1,result.getInt("schema_version"));assertTrue(result.getBoolean("assets_verified"));
        assertEquals("legacy_managed",result.getString("mode"));assertTrue(result.getBoolean("recognized"));
        assertTrue(result.getBoolean("enabled"));assertTrue(result.getBoolean("write_locked"));
        assertFalse(result.has("secret_path"));assertFalse(result.getJSONObject("charge_bypass").has("sha256"));
        assertFalse(result.getJSONObject("charge_bypass").has("id"));
    }

    @Test public void preservesMissingAndDisabledModuleState() throws Exception {
        JSONObject missing=healthy();
        missing.getJSONObject("charge_bypass").put("installed",false).put("recognized",false).remove("files_verified");
        missing.getJSONObject("charge_bypass").remove("version");
        missing.put("recognized",false).put("enabled",false);
        JSONObject missingResult=GatewayPixelStatus.snapshot(false,missing.toString(),"");
        assertFalse(missingResult.getBoolean("recognized"));assertFalse(missingResult.getBoolean("enabled"));
        assertFalse(missingResult.getJSONObject("charge_bypass").getBoolean("installed"));
        assertFalse(missingResult.getJSONObject("charge_bypass").getBoolean("files_verified"));
        assertFalse(missingResult.getJSONObject("charge_bypass").has("version"));

        JSONObject disabled=healthy();disabled.getJSONObject("sip_audio_access").put("disabled",true);disabled.put("enabled",false);
        JSONObject disabledResult=GatewayPixelStatus.snapshot(true,disabled.toString(),"");
        assertTrue(disabledResult.getJSONObject("sip_audio_access").getBoolean("disabled"));
        assertFalse(disabledResult.getBoolean("enabled"));
    }

    @Test public void rejectsInvalidAndOversizedSnapshotsWithoutLeakingInput() throws Exception {
        String sensitive="/data/adb/modules/private deadbeef token-value";
        JSONObject malformed=GatewayPixelStatus.snapshot(false,"{\"path\":\""+sensitive+"\"}",sensitive);
        assertEquals("invalid_snapshot",malformed.getString("mode"));assertFalse(malformed.toString().contains(sensitive));
        assertCompleteUnavailable(malformed);
        StringBuilder oversized=new StringBuilder("{");while(oversized.length()<9000)oversized.append('x');
        JSONObject tooLarge=GatewayPixelStatus.snapshot(false,oversized.toString(),sensitive);
        assertEquals("invalid_snapshot",tooLarge.getString("mode"));assertFalse(tooLarge.toString().contains(sensitive));
        assertCompleteUnavailable(tooLarge);
        StringBuilder multibyte=new StringBuilder();while(multibyte.length()<1000)multibyte.append('\u6d4b');
        JSONObject utf8=healthy().put("ignored",multibyte.toString());
        assertTrue(utf8.toString().length()<2048);
        assertEquals("invalid_snapshot",GatewayPixelStatus.snapshot(false,utf8.toString(),"").getString("mode"));
    }

    @Test public void usesOnlyFixedUnavailableErrorCategories() throws Exception {
        JSONObject failed=GatewayPixelStatus.snapshot(false,"","java.io.IOException: /secret/path");
        assertEquals("asset_verification_failed",failed.getString("mode"));
        assertFalse(failed.toString().contains("secret"));
        assertCompleteUnavailable(failed);
        JSONObject unavailable=GatewayPixelStatus.snapshot(true,"","");
        assertEquals("unavailable",unavailable.getString("mode"));assertCompleteUnavailable(unavailable);
    }

    @Test public void cannotDisableWriteLockOrCoerceBooleanTypes() throws Exception {
        JSONObject forged=healthy().put("write_locked",false);
        assertTrue(GatewayPixelStatus.snapshot(true,forged.toString(),"").getBoolean("write_locked"));
        forged.getJSONObject("charge_bypass").put("installed","true");
        JSONObject rejected=GatewayPixelStatus.snapshot(true,forged.toString(),"");
        assertEquals("invalid_snapshot",rejected.getString("mode"));assertTrue(rejected.getBoolean("write_locked"));
        forged=healthy();forged.getJSONObject("sip_audio_access").put("version","1.1\nprivate");
        assertEquals("invalid_snapshot",GatewayPixelStatus.snapshot(true,forged.toString(),"").getString("mode"));
    }

    private static JSONObject healthy() throws Exception {
        return new JSONObject().put("mode","legacy_managed").put("recognized",true).put("enabled",true)
                .put("write_locked",false)
                .put("charge_bypass",module("pixel_charge_bypass"))
                .put("sip_audio_access",module("pixel_sip_audio_access"));
    }

    private static JSONObject module(String id) throws Exception {
        return new JSONObject().put("id",id).put("installed",true).put("disabled",false)
                .put("recognized",true).put("version","1.1").put("files_verified",true);
    }

    private static void assertCompleteUnavailable(JSONObject value) throws Exception {
        assertEquals(8,value.length());assertEquals(1,value.getInt("schema_version"));
        assertFalse(value.getBoolean("recognized"));assertFalse(value.getBoolean("enabled"));
        assertTrue(value.getBoolean("write_locked"));
        for(String key:new String[]{"charge_bypass","sip_audio_access"}) {
            JSONObject module=value.getJSONObject(key);assertEquals(4,module.length());
            assertFalse(module.getBoolean("installed"));assertFalse(module.getBoolean("disabled"));
            assertFalse(module.getBoolean("recognized"));assertFalse(module.getBoolean("files_verified"));
        }
    }
}
