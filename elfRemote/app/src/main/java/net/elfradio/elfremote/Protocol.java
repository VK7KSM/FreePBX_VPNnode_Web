package net.elfradio.elfremote;

import org.json.JSONObject;

final class Protocol {
    static final String BASE_URL = "https://v.elfradio.net";
    static final String APP_VERSION = "0.1.2-d22xx-control-plane";

    static String enrollPath() {
        return BASE_URL + "/api/devices/enroll";
    }

    static String enrollStatusPath(String code, String enrollId) {
        return BASE_URL + "/api/devices/enroll-status?code=" + code + "&enroll_id=" + enrollId;
    }

    static String reportPath() {
        return BASE_URL + "/api/devices/report";
    }

    static String httpFallbackUrl(String url) {
        if (url == null) return "";
        if (url.startsWith("https://")) return "http://" + url.substring("https://".length());
        return url;
    }

    static String describeNonJson(String body) {
        if (body == null) return "空响应";
        String t = body.trim();
        if (t.length() == 0) return "空响应";
        char c = t.charAt(0);
        if (c == '{' || c == '[') return null;
        if (c == '<') return "控制面返回网页，配对接口未部署";
        String head = t.length() > 48 ? t.substring(0, 48) : t;
        return "非JSON: " + head;
    }

    static JSONObject parseObject(String body) throws Exception {
        String err = describeNonJson(body);
        if (err != null) throw new Exception(err);
        return new JSONObject(body);
    }

    static boolean isOk(JSONObject obj) {
        return obj != null && obj.optBoolean("ok", false);
    }

    static String formatPairCode(String code) {
        if (code == null) return "------";
        String c = code.trim();
        if (c.length() == 0) return "------";
        if (c.length() == 6) return c.substring(0, 3) + "  " + c.substring(3);
        return c;
    }

    static String remainingHint(long expiresAtMs, long nowMs) {
        if (expiresAtMs <= 0) return "";
        long left = expiresAtMs - nowMs;
        if (left <= 0) return "配对码已过期，请重新获取";
        long min = (left + 59999L) / 60000L;
        if (min < 1) min = 1;
        return "有效约 " + min + " 分钟";
    }

    static long parseIsoMillis(String iso) {
        if (iso == null) return 0;
        String s = iso.trim();
        if (s.length() < 19) return 0;
        try {
            if (s.endsWith("Z")) s = s.substring(0, s.length() - 1) + "+0000";
            java.text.SimpleDateFormat f;
            if (s.contains(".")) {
                f = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSZ", java.util.Locale.US);
            } else {
                f = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssZ", java.util.Locale.US);
            }
            java.util.Date d = f.parse(s);
            return d == null ? 0 : d.getTime();
        } catch (Exception e) {
            return 0;
        }
    }

    static String formatNetError(Exception e) {
        if (e == null) return "网络失败";
        String msg = e.getMessage();
        if (msg == null) msg = "";
        if (msg.startsWith("控制面") || msg.startsWith("非JSON") || msg.startsWith("空响应")) {
            return msg;
        }
        String name = e.getClass().getSimpleName();
        if (msg.length() == 0) return name;
        if (msg.length() > 80) msg = msg.substring(0, 80);
        return name + ": " + msg;
    }

    private Protocol() {}
}
