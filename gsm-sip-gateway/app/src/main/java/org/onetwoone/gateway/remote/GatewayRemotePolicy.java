package org.onetwoone.gateway.remote;

import org.json.JSONArray;
import org.json.JSONObject;

/** Gateway profile for the shared elfRemote registration/report contract. */
public final class GatewayRemotePolicy {
    public static final String PRODUCT = "elfremote_gateway";
    public static final String PACKAGE = "org.onetwoone.gateway";
    public static final String BASE_URL = "https://v.elfradio.net";
    public static final long REPORT_MS = 60_000L;

    public static JSONObject profile() throws Exception {
        JSONObject body = new JSONObject().put("product_id", PRODUCT).put("app_package", PACKAGE)
                .put("model_id", "mdl_pixel3").put("model_hint", "Pixel 3")
                .put("app_cert_sha256", "9b31f89fa50b672ecfe02d73a534cc03f6cf893739aec268f9fe0b71e72da72e")
                .put("app_abi", "arm64-v8a");
        for (String key : new String[]{"managed_update", "managed_update_v2", "managed_media",
                "managed_media_prepare_v1", "managed_adb_session", "managed_adb_tunnel_v1", "managed_alarm_tasks",
                "managed_file_tasks", "managed_file_return", "managed_file_operations",
                "managed_lost_tasks", "managed_wipe_v1", "managed_config_tasks"}) body.put(key, false);
        return body.put("managed_update",true).put("managed_update_v2",true).put("managed_adb_session",true).put("managed_adb_tunnel_v1",true)
                .put("managed_exec_tasks",true)
                .put("managed_alarm_tasks",true).put("managed_locate_tasks",true)
                .put("managed_lost_message_v1",true)
                .put("managed_sip_account",true)
                .put("managed_mobile_status",true)
                .put("managed_proxy_tasks",true).put("managed_proxy_v1",true)
                .put("managed_pixel_companion_v1",true)
                .put("managed_file_operations",true).put("managed_file_delete",true)
                .put("managed_file_tasks",true).put("managed_file_return",true)
                .put("managed_wifi_scan_tasks",true).put("managed_wifi_config_tasks",true)
                .put("managed_media_modes", new JSONArray());
    }

    public static long retryDelay(int failures) {
        return Math.min(300_000L, 5_000L << Math.min(6, Math.max(0, failures - 1)));
    }

    private GatewayRemotePolicy() {}
}
