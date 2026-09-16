package org.onetwoone.gateway.remote;

import org.json.JSONObject;

/** Builds the bounded, read-only Pixel runtime status sent to the management service. */
final class GatewayPixelStatus {
    private static final int MAX_SNAPSHOT_LENGTH=2048;
    private static final int MAX_VERSION_LENGTH=64;

    static JSONObject snapshot(boolean assetsVerified,String healthJson,String storedError) throws Exception {
        JSONObject result=base(assetsVerified,"legacy_managed");
        if(healthJson==null||healthJson.isEmpty())
            return unavailable(assetsVerified,!assetsVerified&&storedError!=null&&!storedError.isEmpty()
                    ?"asset_verification_failed":"unavailable");
        if(healthJson.getBytes(java.nio.charset.StandardCharsets.UTF_8).length>MAX_SNAPSHOT_LENGTH)
            return unavailable(assetsVerified,"invalid_snapshot");
        try {
            JSONObject source=new JSONObject(healthJson);
            String mode=source.optString("mode",null);
            if(!java.util.Arrays.asList("legacy_managed","companion_staged","companion_active","unavailable").contains(mode))throw new IllegalArgumentException();
            result.put("mode",mode)
                    .put("recognized",requiredBoolean(source,"recognized"))
                    .put("enabled",requiredBoolean(source,"enabled"))
                    .put("charge_bypass",module(source,"charge_bypass"))
                    .put("sip_audio_access",module(source,"sip_audio_access"))
                    .put("companion",companion(source));
            return result;
        } catch(Exception invalid) {
            return unavailable(assetsVerified,"invalid_snapshot");
        }
    }

    private static JSONObject companion(JSONObject source) throws Exception {
        Object raw=source.opt("companion");if(!(raw instanceof JSONObject))return emptyCompanion();
        JSONObject input=(JSONObject)raw,units=input.optJSONObject("units");if(units==null)throw new IllegalArgumentException();
        JSONObject output=new JSONObject().put("installed",requiredBoolean(input,"installed"))
                .put("disabled",requiredBoolean(input,"disabled")).put("recognized",requiredBoolean(input,"recognized"))
                .put("active",requiredBoolean(input,"active")).put("rollback_available",requiredBoolean(input,"rollback_available"))
                .put("units",new JSONObject().put("charge",requiredBoolean(units,"charge"))
                        .put("audio",requiredBoolean(units,"audio")).put("adb_tcp",requiredBoolean(units,"adb_tcp")));
        if(input.has("version")){String version=input.optString("version","");if(version.isEmpty()||version.length()>MAX_VERSION_LENGTH||hasControl(version))throw new IllegalArgumentException();output.put("version",version);}
        return output;
    }

    private static JSONObject module(JSONObject source,String key) throws Exception {
        Object raw=source.opt(key);if(!(raw instanceof JSONObject))throw new IllegalArgumentException();
        JSONObject input=(JSONObject)raw;
        JSONObject output=new JSONObject().put("installed",requiredBoolean(input,"installed"))
                .put("disabled",requiredBoolean(input,"disabled"))
                .put("recognized",requiredBoolean(input,"recognized"))
                .put("files_verified",optionalBoolean(input,"files_verified",false));
        if(input.has("version")) {
            Object version=input.opt("version");
            if(!(version instanceof String)||((String)version).isEmpty()||((String)version).length()>MAX_VERSION_LENGTH
                    ||hasControl((String)version))
                throw new IllegalArgumentException();
            output.put("version",version);
        }
        return output;
    }

    private static boolean requiredBoolean(JSONObject source,String key) {
        Object value=source.opt(key);if(!(value instanceof Boolean))throw new IllegalArgumentException();
        return (Boolean)value;
    }

    private static boolean optionalBoolean(JSONObject source,String key,boolean fallback) {
        if(!source.has(key))return fallback;
        return requiredBoolean(source,key);
    }

    private static JSONObject unavailable(boolean assetsVerified,String mode) throws Exception {
        return base(assetsVerified,mode).put("recognized",false).put("enabled",false)
                .put("charge_bypass",emptyModule()).put("sip_audio_access",emptyModule()).put("companion",emptyCompanion());
    }

    private static JSONObject base(boolean assetsVerified,String mode) throws Exception {
        return new JSONObject().put("schema_version",1).put("assets_verified",assetsVerified)
                .put("mode",mode).put("write_locked",true);
    }

    private static JSONObject emptyModule() throws Exception {
        return new JSONObject().put("installed",false).put("disabled",false)
                .put("recognized",false).put("files_verified",false);
    }
    private static JSONObject emptyCompanion() throws Exception {
        return new JSONObject().put("installed",false).put("disabled",false).put("recognized",false)
                .put("active",false).put("rollback_available",false)
                .put("units",new JSONObject().put("charge",false).put("audio",false).put("adb_tcp",false));
    }

    private static boolean hasControl(String value) {
        for(int i=0;i<value.length();i++)if(Character.isISOControl(value.charAt(i)))return true;
        return false;
    }

    private GatewayPixelStatus() {}
}
