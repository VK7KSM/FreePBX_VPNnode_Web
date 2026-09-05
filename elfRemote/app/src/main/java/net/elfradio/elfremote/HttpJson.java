package net.elfradio.elfremote;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.Charset;

final class HttpJson {
    static String post(String url, String json) throws Exception {
        return exchange("POST", url, json);
    }

    static String get(String url) throws Exception {
        return exchange("GET", url, null);
    }

    private static String exchange(String method, String url, String json) throws Exception {
        try {
            return exchangeOnce(method, url, json);
        } catch (javax.net.ssl.SSLException e) {
            String fallback = Protocol.httpFallbackUrl(url);
            if (fallback.length() == 0 || fallback.equals(url)) throw e;
            try {
                return exchangeOnce(method, fallback, json);
            } catch (Exception e2) {
                throw new Exception(
                        Protocol.formatNetError(e) + "；HTTP " + Protocol.formatNetError(e2), e2);
            }
        }
    }

    private static String exchangeOnce(String method, String url, String json) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        try {
            c.setConnectTimeout(15000);
            c.setReadTimeout(20000);
            c.setInstanceFollowRedirects(true);
            c.setRequestMethod(method);
            c.setRequestProperty("Accept", "application/json");
            c.setRequestProperty("User-Agent", "elfRemote/" + Protocol.APP_VERSION);
            if (json != null) {
                byte[] body = json.getBytes("UTF-8");
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                OutputStream os = c.getOutputStream();
                os.write(body);
                os.close();
            }
            InputStream in = c.getResponseCode() >= 400 ? c.getErrorStream() : c.getInputStream();
            if (in == null) return "{}";
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[2048];
            int n;
            while ((n = in.read(buf)) >= 0) bos.write(buf, 0, n);
            in.close();
            return new String(bos.toByteArray(), Charset.forName("UTF-8"));
        } finally {
            c.disconnect();
        }
    }

    private HttpJson() {}
}
