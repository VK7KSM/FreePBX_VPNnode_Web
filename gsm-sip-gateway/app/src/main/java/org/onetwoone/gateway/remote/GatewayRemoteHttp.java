package org.onetwoone.gateway.remote;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

final class GatewayRemoteHttp {
    static final class RetryLater extends java.io.IOException {
        final long delayMs;
        RetryLater(int code,long delay) { super("HTTP "+code); delayMs=delay; }
    }
    static JSONObject request(String path, JSONObject body) throws Exception {
        if (!path.startsWith("/api/devices/") && !"/api/elfremote/update-progress".equals(path)
                && !"/api/elfremote/task-progress".equals(path)) throw new IllegalArgumentException("invalid route");
        HttpURLConnection connection = (HttpURLConnection) new URL(GatewayRemotePolicy.BASE_URL + path).openConnection();
        connection.setConnectTimeout(15000); connection.setReadTimeout(20000);
        connection.setInstanceFollowRedirects(false);
        connection.setRequestProperty("User-Agent", "elfRemote-Gateway/1.5.0");
        connection.setRequestProperty("Accept", "application/json");
        try {
            if (body != null) {
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                connection.setRequestMethod("POST"); connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream out = connection.getOutputStream()) { out.write(bytes); }
            }
            int code = connection.getResponseCode();
            if (code == 429 || code == 503) {
                long delay=300_000L;
                String retry=connection.getHeaderField("Retry-After");
                if (retry!=null) {
                    try { delay=Math.min(86400L,Math.max(0,Long.parseLong(retry)))*1000; }
                    catch(NumberFormatException ignored) {
                        long date=connection.getHeaderFieldDate("Retry-After",0);
                        if(date>0) delay=Math.min(86_400_000L,Math.max(0,date-System.currentTimeMillis()));
                    }
                }
                throw new RetryLater(code,delay);
            }
            if (code != 200) throw new java.io.IOException("HTTP " + code);
            try (InputStream in = connection.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[4096]; int count;
                while ((count = in.read(buffer)) != -1) {
                    if (out.size() + count > 256 * 1024) throw new java.io.IOException("response too large");
                    out.write(buffer, 0, count);
                }
                JSONObject result = new JSONObject(out.toString("UTF-8"));
                if (!result.optBoolean("ok")) throw new java.io.IOException("request rejected");
                return result;
            }
        } finally { connection.disconnect(); }
    }
    private GatewayRemoteHttp() {}
}
