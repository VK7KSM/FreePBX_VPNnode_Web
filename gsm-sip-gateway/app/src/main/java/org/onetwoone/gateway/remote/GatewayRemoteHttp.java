package org.onetwoone.gateway.remote;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Proxy;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

final class GatewayRemoteHttp {
    private static class HttpRejected extends java.io.IOException {HttpRejected(int code){super("HTTP "+code);}}
    static final class RetryLater extends java.io.IOException {
        final long delayMs;
        RetryLater(int code,long delay) { super("HTTP "+code); delayMs=delay; }
    }
    /** Server no longer knows this device id (for example after a backend migration); re-enrol with the same token. */
    static final class PairingRequired extends HttpRejected {
        PairingRequired() { super(404); }
    }
    static boolean pairingRequired(HttpURLConnection connection) {
        try (InputStream in = connection.getErrorStream()) {
            if (in == null) return false;
            byte[] buffer = new byte[4096]; int count = in.read(buffer);
            return count > 0 && new JSONObject(new String(buffer, 0, count, StandardCharsets.UTF_8)).optBoolean("pairing_required");
        } catch (Exception ignored) { return false; }
    }
    static JSONObject request(String path, JSONObject body) throws Exception {
        if (!path.startsWith("/api/devices/") && !"/api/elfremote/update-progress".equals(path)
                && !"/api/elfremote/task-progress".equals(path)) throw new IllegalArgumentException("invalid route");
        URL url=new URL(GatewayRemotePolicy.BASE_URL+path);byte[] bytes=body==null?null:body.toString().getBytes(StandardCharsets.UTF_8);Exception last=null;
        for(Proxy route:GatewayProxyRoute.attempts())try{return request(url,bytes,route);}catch(RetryLater limited){throw limited;}catch(HttpRejected rejected){throw rejected;}catch(SecurityException rejected){throw rejected;}catch(java.io.IOException unavailable){last=unavailable;}
        throw last==null?new java.io.IOException("request unavailable"):last;
    }
    private static JSONObject request(URL url,byte[] body,Proxy route) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) GatewayProxyRoute.open(url,route);
        connection.setConnectTimeout(15000); connection.setReadTimeout(20000);
        connection.setInstanceFollowRedirects(false);
        connection.setRequestProperty("User-Agent", "elfRemote-Gateway/1.5.0");
        connection.setRequestProperty("Accept", "application/json");
        try {
            if (body != null) {
                connection.setRequestMethod("POST"); connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setFixedLengthStreamingMode(body.length);
                try (OutputStream out = connection.getOutputStream()) { out.write(body); }
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
            if (code == 404 && pairingRequired(connection)) throw new PairingRequired();
            if (code != 200) throw new HttpRejected(code);
            try (InputStream in = connection.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[4096]; int count;
                while ((count = in.read(buffer)) != -1) {
                    if (out.size() + count > 256 * 1024) throw new java.io.IOException("response too large");
                    out.write(buffer, 0, count);
                }
                JSONObject result = new JSONObject(out.toString("UTF-8"));
                if (!result.optBoolean("ok")) throw new java.io.IOException("request rejected");
                GatewayProxyRoute.succeeded(route);
                return result;
            }
        } finally { connection.disconnect(); }
    }
    private GatewayRemoteHttp() {}
}
