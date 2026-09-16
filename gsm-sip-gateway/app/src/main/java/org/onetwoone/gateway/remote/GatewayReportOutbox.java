package org.onetwoone.gateway.remote;

import org.json.JSONObject;

/** Prevents a report frozen by a replaced APK from poisoning the next version. */
final class GatewayReportOutbox {
    static JSONObject resume(String raw,String currentVersion)throws Exception {
        JSONObject value=new JSONObject(raw==null?"{}":raw);
        if(!currentVersion.equals(value.optString("app_version")))return null;
        return value;
    }
    private GatewayReportOutbox(){}
}
