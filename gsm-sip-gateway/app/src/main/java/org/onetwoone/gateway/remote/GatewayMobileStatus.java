package org.onetwoone.gateway.remote;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONObject;

/** Redacts and validates mobile-network observations before they leave the root core. */
final class GatewayMobileStatus {
    private static final Set<String> NETWORK_TYPES=new HashSet<>(Arrays.asList(
            "unknown","gprs","edge","umts","hsdpa","hsupa","hspa","cdma","1xrtt",
            "evdo_0","evdo_a","evdo_b","ehrpd","iden","hspap","lte","td_scdma","iwlan","nr"));

    static JSONObject sanitize(JSONObject source) throws Exception {
        if(!requiredBoolean(source,"available"))return unavailable();
        int count=requiredInt(source,"active_subscription_count");
        if(count<0||count>8)throw new IllegalArgumentException("invalid subscription count");
        boolean readable=requiredBoolean(source,"data_switch_readable");
        Object enabled=source.opt("mobile_data_enabled");
        if(readable&&!(enabled instanceof Boolean))throw new IllegalArgumentException("invalid data state");
        if(!readable&&enabled!=null&&enabled!=JSONObject.NULL)throw new IllegalArgumentException("unexpected data state");
        String network=source.optString("current_data_network_type",null);
        if(network==null||!NETWORK_TYPES.contains(network))throw new IllegalArgumentException("invalid network type");
        return new JSONObject().put("schema_version",1).put("available",true).put("write_locked",true)
                .put("active_subscription_count",count)
                .put("sim_ready",requiredBoolean(source,"sim_ready"))
                .put("default_data_subscription_valid",requiredBoolean(source,"default_data_subscription_valid"))
                .put("data_switch_readable",readable)
                .put("mobile_data_enabled",readable?enabled:JSONObject.NULL)
                .put("current_data_network_type",network)
                .put("carrier_config_readable",requiredBoolean(source,"carrier_config_readable"))
                .put("apn_provider_readable",requiredBoolean(source,"apn_provider_readable"));
    }

    static JSONObject unavailable() throws Exception {
        return new JSONObject().put("schema_version",1).put("available",false).put("write_locked",true)
                .put("active_subscription_count",0).put("sim_ready",false)
                .put("default_data_subscription_valid",false).put("data_switch_readable",false)
                .put("mobile_data_enabled",JSONObject.NULL).put("current_data_network_type","unknown")
                .put("carrier_config_readable",false).put("apn_provider_readable",false);
    }

    static JSONObject stored(String json) throws Exception {
        if(json==null||json.isEmpty())return unavailable();
        try{return sanitize(new JSONObject(json));}catch(Exception invalid){return unavailable();}
    }

    private static boolean requiredBoolean(JSONObject source,String key) {
        Object value=source.opt(key);if(!(value instanceof Boolean))throw new IllegalArgumentException("invalid "+key);
        return (Boolean)value;
    }
    private static int requiredInt(JSONObject source,String key) {
        Object value=source.opt(key);if(!(value instanceof Integer))throw new IllegalArgumentException("invalid "+key);
        return (Integer)value;
    }
    private GatewayMobileStatus() {}
}
