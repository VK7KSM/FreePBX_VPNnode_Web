package net.elfradio.elfremote;

import fi.iki.elonen.NanoHTTPD;
import org.json.JSONObject;
import java.net.InetAddress;
import java.io.EOFException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

final class RescueHttpServer extends NanoHTTPD {
    interface Status { String get(); }
    private final RescueJobs jobs;
    private final Status status;
    private final int uid;
    private AdbSessions adb;
    private CorePush push;
    void setPush(CorePush value){push=value;}
    void setAdb(AdbSessions value){adb=value;}

    RescueHttpServer(int port, RescueJobs jobs, Status status) {
        this(port, jobs, status, -1);
    }

    RescueHttpServer(int port, RescueJobs jobs, Status status, int uid) {
        super("127.0.0.1", port);
        this.uid = uid;
        this.jobs = jobs;
        this.status = status;
        // 限制并发连接与队列，防止停滞请求无限创建线程。
        setAsyncRunner(new AsyncRunner() {
            private final java.util.concurrent.ThreadPoolExecutor pool =
                    new java.util.concurrent.ThreadPoolExecutor(4, 4, 0,
                    java.util.concurrent.TimeUnit.SECONDS, new java.util.concurrent.ArrayBlockingQueue<>(8));
            private final java.util.Set<ClientHandler> clients =
                    java.util.Collections.synchronizedSet(new java.util.HashSet<>());
            public void exec(ClientHandler handler) {
                clients.add(handler);
                try { pool.execute(handler); }
                catch (java.util.concurrent.RejectedExecutionException busy) { handler.close(); clients.remove(handler); }
            }
            public void closed(ClientHandler handler) { clients.remove(handler); }
            public void closeAll() {
                synchronized (clients) { for (ClientHandler c : clients) c.close(); clients.clear(); }
                pool.shutdownNow();
            }
        });
    }

    @Override public Response serve(IHTTPSession session) {
        try {
            InetAddress peer = InetAddress.getByName(session.getRemoteIpAddress());
            if (!peer.isSiteLocalAddress() && !peer.isLoopbackAddress())
                return response(Response.Status.FORBIDDEN, "仅开放局域网");
            String path = session.getUri();
            if(session.getMethod()==Method.GET && "/diagnostics".equals(path))
                return json(Response.Status.OK,RescueDiagnostics.collect());
            if(session.getMethod()==Method.GET && "/files/recent".equals(path))return json(Response.Status.OK,jobs.fileHistory());
            if (session.getMethod() == Method.POST && ("/prepare-upgrade".equals(path) || "/resume".equals(path))) {
                if (session.getHeaders().containsKey("origin")) return response(Response.Status.FORBIDDEN,"不接受浏览器跨站请求");
                if(adb!=null&&"/prepare-upgrade".equals(path))adb.close();
                return json(Response.Status.OK, jobs.upgrade("/prepare-upgrade".equals(path)));
            }
            if (session.getMethod() == Method.GET && "/health".equals(path))
                return json(Response.Status.OK, new JSONObject().put("version", BuildConfig.VERSION_NAME)
                        .put("version_code", BuildConfig.VERSION_CODE)
                        .put("service", "elfremote-root-rescue").put("busy", jobs.isBusy())
                        .put("uid", uid)
                        .put("independent_push",push!=null)
                        .put("diagnostics",true).put("history_days",30)
                        .put("uptime_ms", System.nanoTime() / 1000000L));
            if (session.getMethod() == Method.GET && "/".equals(path))
                return response(Response.Status.OK, status.get());
            if(session.getMethod()==Method.GET && "/push/status".equals(path) && push!=null)return json(Response.Status.OK,push.status());
            if(session.getMethod()==Method.GET && "/push/log".equals(path) && push!=null)return json(Response.Status.OK,push.logs());
            if (session.getMethod() == Method.GET && path.startsWith("/jobs/")) {
                JSONObject result = jobs.get(path.substring(6));
                return result == null ? response(Response.Status.NOT_FOUND, "任务不存在")
                        : json(Response.Status.OK, result);
            }
            if (session.getMethod()==Method.POST && path.startsWith("/jobs/") && path.endsWith("/cancel")) {
                if (session.getHeaders().containsKey("origin")) return response(Response.Status.FORBIDDEN,"不接受浏览器跨站请求");
                JSONObject result=jobs.cancel(path.substring(6,path.length()-7));
                return result==null ? response(Response.Status.NOT_FOUND,"任务不存在") : json(Response.Status.ACCEPTED,result);
            }
            if (session.getMethod() != Method.POST || !("/exec".equals(path)||"/file-commit".equals(path)||"/file-snapshot".equals(path)||"/file-manage".equals(path)||"/system-settings".equals(path)||"/sip-account".equals(path)||"/zello-account".equals(path)||("/adb/open".equals(path)&&adb!=null)||(push!=null&&("/push/config".equals(path)||"/push/hint".equals(path)||"/push/disable".equals(path)))))
                return response(Response.Status.NOT_FOUND, "使用 POST /exec 或 GET /jobs/任务号");
            // 本批仅开放本机回环，云端复用既有管理员登录与设备凭据。
            String contentType = session.getHeaders().get("content-type");
            if (contentType == null || !contentType.split(";")[0].trim().equalsIgnoreCase("application/json")
                    || session.getHeaders().containsKey("transfer-encoding")
                    || session.getHeaders().containsKey("origin"))
                return response(Response.Status.BAD_REQUEST, "需要无Origin的application/json请求");
            long length = Long.parseLong(session.getHeaders().get("content-length"));
            if (length < 1 || length > 16384) return response(Response.Status.BAD_REQUEST, "请求大小超限");
            // 命令正文有严格上限，直接读取，避免独立进程依赖不存在的临时目录。
            byte[] body = new byte[(int) length];
            InputStream input = session.getInputStream();
            int offset = 0;
            while (offset < body.length) {
                int count = input.read(body, offset, body.length - offset);
                if (count < 0) throw new EOFException("请求正文不完整");
                offset += count;
            }
            JSONObject request = new JSONObject(new String(body, StandardCharsets.UTF_8));
            if("/push/config".equals(path))return json(Response.Status.OK,push.configure(request));
            if("/push/hint".equals(path)){push.hint();return json(Response.Status.OK,push.status());}
            if("/push/disable".equals(path)){push.disable();return json(Response.Status.OK,push.status());}
            if("/adb/open".equals(path))return json(Response.Status.ACCEPTED,adb.open(request));
            if("/zello-account".equals(path))return json(Response.Status.ACCEPTED,jobs.submitZelloAccount(request.getString("id"),request.getJSONObject("params")));
            if("/system-settings".equals(path))return json(Response.Status.ACCEPTED,jobs.submitSettings(request.getString("id"),request.getJSONObject("params")));
            if("/sip-account".equals(path))return json(Response.Status.ACCEPTED,jobs.submitSipAccount(request.getString("id"),request.getJSONObject("params")));
            if("/file-manage".equals(path))return json(Response.Status.ACCEPTED,jobs.submitFileOperation(request.getString("id"),request.getJSONObject("params")));
            if("/file-commit".equals(path))return json(Response.Status.ACCEPTED,jobs.submitFile(request.getString("id"),request.getJSONObject("params")));
            if("/file-snapshot".equals(path))return json(Response.Status.ACCEPTED,jobs.submitSnapshot(request.getString("id"),request.getJSONObject("params")));
            JSONObject result = jobs.submit(request.getString("id"), request.getString("command"),
                    request.optInt("timeout", 30));
            return json(Response.Status.ACCEPTED, result);
        } catch (IllegalStateException busy) {
            return response(Response.Status.CONFLICT, busy.getMessage());
        } catch (Exception error) {
            return response(Response.Status.BAD_REQUEST, "请求失败：" + error.getMessage());
        }
    }

    private static Response json(Response.Status code, JSONObject body) {
        Response result = newFixedLengthResponse(code, "application/json; charset=utf-8", body.toString());
        result.addHeader("Cache-Control", "no-store"); result.addHeader("Connection", "close"); return result;
    }
    private static Response response(Response.Status code, String body) {
        Response result = newFixedLengthResponse(code, "text/plain; charset=utf-8", body);
        result.addHeader("Cache-Control", "no-store"); result.addHeader("Connection", "close"); return result;
    }
}
