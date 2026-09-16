package org.onetwoone.gateway.remote;

import org.json.JSONObject;

/** Necessary admission evidence; an idle sample alone is not an installation lease. */
final class GatewayInstallGate {
    static boolean liveIdle(JSONObject health,String expectedIdentity,int installedCode,long elapsedNow) {
        if(health==null||expectedIdentity==null||!expectedIdentity.matches("[0-9a-f]{64}"))return false;
        long sampled=health.optLong("sample_elapsed_ms",-1);
        return sampled>=0&&elapsedNow>=sampled&&elapsedNow-sampled<=2000
                &&Boolean.TRUE.equals(health.opt("running"))&&Boolean.TRUE.equals(health.opt("paired"))
                &&Boolean.FALSE.equals(health.opt("busy"))
                &&installedCode==health.optInt("version_code",-1)
                &&expectedIdentity.equals(health.optString("identity_sha256"));
    }
    private GatewayInstallGate(){}
}
