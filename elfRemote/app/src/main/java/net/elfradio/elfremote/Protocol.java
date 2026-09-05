package net.elfradio.elfremote;

import org.json.JSONObject;

final class Protocol {
    static final String BASE_URL = "https://v.elfradio.net";
    static final String APP_VERSION = "0.1.0-d22xx-control-plane";

    static String enrollPath() {
        return BASE_URL + "/api/devices/enroll";
    }

    static String enrollStatusPath(String code, String enrollId) {
        return BASE_URL + "/api/devices/enroll-status?code=" + code + "&enroll_id=" + enrollId;
    }

    static String reportPath() {
        return BASE_URL + "/api/devices/report";
    }

    static JSONObject parseObject(String body) throws Exception {
        return new JSONObject(body == null ? "{}" : body);
    }

    static boolean isOk(JSONObject obj) {
        return obj != null && obj.optBoolean("ok", false);
    }

    private Protocol() {}
}
