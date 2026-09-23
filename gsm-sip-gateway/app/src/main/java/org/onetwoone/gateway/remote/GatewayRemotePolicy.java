package org.onetwoone.gateway.remote;

import org.json.JSONArray;
import org.json.JSONObject;

/** Gateway profile for the shared elfRemote registration/report contract. */
public final class GatewayRemotePolicy {
    public static final String PRODUCT = "elfremote_gateway";
    public static final String PACKAGE = "org.onetwoone.gateway";
    public static final String BASE_URL = "https://v.elfradio.net";
    /**
     * 稳态上报间隔。随报告体上报给面板，面板用它算轨迹断点阈值（两倍间隔）。
     * 在此之前面板是按网络类型查表猜的，WiFi 一律当成 15 分钟，于是这台每分钟上报的
     * 网关断点阈值被放到 30 分钟——2026-09-19 那次死锁停报 8 分钟，轨迹上一个断点都没有。
     * 这里要报稳态值，不能报退避后的实际延迟：故障时退避会越来越长，
     * 阈值跟着变宽，等于越出问题越不容易被发现。
     */
    public static final long REPORT_MS = 60_000L;
    /** 面板采信的区间，与前端 cadence() 一致；超出这个范围服务端会回退到查表值。 */
    public static final long REPORT_INTERVAL_MIN_MS = 60_000L, REPORT_INTERVAL_MAX_MS = 86_400_000L;

    public static JSONObject profile() throws Exception {
        JSONObject body = new JSONObject().put("product_id", PRODUCT).put("app_package", PACKAGE)
                .put("model_id", "mdl_pixel3").put("model_hint", "Pixel 3")
                .put("app_cert_sha256", "9b31f89fa50b672ecfe02d73a534cc03f6cf893739aec268f9fe0b71e72da72e")
                .put("app_abi", "arm64-v8a");
        for (String key : new String[]{"managed_update", "managed_update_v2", "managed_media",
                "managed_media_prepare_v1", "managed_adb_session", "managed_adb_tunnel_v1", "managed_alarm_tasks",
                "managed_file_tasks", "managed_file_return", "managed_file_operations",
                "managed_lost_tasks", "managed_wipe_v1", "managed_config_tasks", "managed_desktop_v1"}) body.put(key, false);
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
