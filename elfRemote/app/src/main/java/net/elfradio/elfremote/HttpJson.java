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

    static void download(String url, java.io.File dest) throws Exception {
        HttpURLConnection c = (HttpURLConnection) Protocol.requireHttpsUrl(url).openConnection();
        try {
            c.setConnectTimeout(20000);
            c.setReadTimeout(60000);
            c.setInstanceFollowRedirects(false);
            c.setRequestMethod("GET");
            c.setRequestProperty("User-Agent", "elfRemote/" + Protocol.appVersion());
            int code = c.getResponseCode();
            if (code < 200 || code >= 300) throw new Exception("download HTTP " + code);
            java.io.InputStream in = c.getInputStream();
            java.io.FileOutputStream out = new java.io.FileOutputStream(dest);
            try {
                byte[] buf = new byte[4096];
                int n;
                while ((n = in.read(buf)) >= 0) out.write(buf, 0, n);
            } finally {
                out.close();
                in.close();
            }
        } finally {
            c.disconnect();
        }
    }

    private static String exchange(String method, String url, String json) throws Exception {
        try {
            return exchangeOnce(method, url, json);
        } catch (Exception e) {
            RuntimeLog.error("https_failed", e);
            throw e;
        }
    }

    private static String exchangeOnce(String method, String url, String json) throws Exception {
        HttpURLConnection c = (HttpURLConnection) Protocol.requireHttpsUrl(url).openConnection();
        RuntimeLog.event("https_start method=" + method);
        try {
            c.setConnectTimeout(15000);
            c.setReadTimeout(20000);
            c.setInstanceFollowRedirects(false);
            c.setRequestMethod(method);
            c.setRequestProperty("Accept", "application/json");
            c.setRequestProperty("User-Agent", "elfRemote/" + Protocol.appVersion());
            c.setRequestProperty("User-Agent", "elfRemote/" + Protocol.appVersion());
            if (json != null) {
                byte[] body = json.getBytes("UTF-8");
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                OutputStream os = c.getOutputStream();
                os.write(body);
                os.close();
            }
            int code = c.getResponseCode();
            if (code >= 300 && code < 400) throw new java.io.IOException("redirect refused");
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            if (in == null) return "{}";
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[2048];
            int n;
            while ((n = in.read(buf)) >= 0) {
                if (bos.size() + n > 1024 * 1024) throw new java.io.IOException("response too large");
                bos.write(buf, 0, n);
            }
            in.close();
            RuntimeLog.event("https_complete code=" + code + " response_bytes=" + bos.size());
            return new String(bos.toByteArray(), Charset.forName("UTF-8"));
        } finally {
            c.disconnect();
        }
    }

    private HttpJson() {}
}
