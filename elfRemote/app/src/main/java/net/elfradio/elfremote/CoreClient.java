package net.elfradio.elfremote;

import org.json.JSONObject;
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** 应用与独立维护核心之间的本机通道。 */
final class CoreClient {
    static JSONObject request(String path, JSONObject body) throws Exception {
        return request(path,body,3000);
    }
    static JSONObject request(String path, JSONObject body, int readTimeout) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL("http://127.0.0.1:8765" + path).openConnection();
        c.setConnectTimeout(1500); c.setReadTimeout(readTimeout); c.setInstanceFollowRedirects(false);
        try {
            if (body != null) {
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                c.setRequestMethod("POST"); c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json"); c.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream out = c.getOutputStream()) { out.write(bytes); }
            }
            int code = c.getResponseCode();
            if (code == 404) return null;
            if (code < 200 || code >= 300) throw new IOException("core-http-" + code);
            try (InputStream in = c.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[4096]; int n;
                while ((n = in.read(buffer)) >= 0) {
                    if (out.size() + n > 600000) throw new IOException("core-response-too-large");
                    out.write(buffer, 0, n);
                }
                return new JSONObject(new String(out.toByteArray(), StandardCharsets.UTF_8));
            }
        } finally { c.disconnect(); }
    }
    static JSONObject health() throws Exception {
        JSONObject h = request("/health", null);
        if (h == null || !"elfremote-root-rescue".equals(h.optString("service")) || h.optInt("uid", -1) != 0)
            throw new IOException("core-not-root");
        return h;
    }
    private CoreClient() {}
}
