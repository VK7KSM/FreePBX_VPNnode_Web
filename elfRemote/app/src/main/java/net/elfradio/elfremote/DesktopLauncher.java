package net.elfradio.elfremote;

import org.json.JSONObject;
import java.io.File;
import java.util.regex.Pattern;

/**
 * 核心（root）内的 scrcpy 服务端拉起/结束。
 * scrcpy 对系统服务自称 com.android.shell，剪贴板等服务校验调用 uid，必须以 uid 2000 运行，不能以 root 运行。
 * 视频/控制流由应用进程直接连接 localabstract:scrcpy_<scid>，核心不转发字节。
 */
final class DesktopLauncher {
    private static final Pattern SCID = Pattern.compile("^[0-9a-f]{8}$");
    private final File root;
    private Process current;
    private String currentScid = "";

    DesktopLauncher(File root) { this.root = root; }

    synchronized JSONObject start(JSONObject request) throws Exception {
        String scid = request.getString("scid");
        if (!SCID.matcher(scid).matches()) throw new IllegalArgumentException("scid 无效");
        if (!ScrcpyAsset.verifyInstalled()) throw new IllegalStateException("scrcpy 服务端尚未就绪");
        int maxFps = Math.max(1, Math.min(60, request.optInt("max_fps", 30)));
        int bitRate = Math.max(100000, Math.min(8000000, request.optInt("bit_rate", 1500000)));
        int maxSize = Math.max(0, Math.min(1920, request.optInt("max_size", 0)));
        stopLocked();
        File log = new File(root, "desktop.log");
        if (log.length() > 262144) log.delete();
        String server = "CLASSPATH=" + ScrcpyAsset.TARGET + " app_process / com.genymobile.scrcpy.Server " + ScrcpyAsset.VERSION
                + " scid=" + scid + " tunnel_forward=true audio=false control=true cleanup=true power_on=true"
                + " send_dummy_byte=false log_level=info max_fps=" + maxFps + " video_bit_rate=" + bitRate
                + (maxSize > 0 ? " max_size=" + maxSize : "");
        // setsid 独立进程组；su 2000 降权；输出到核心目录日志。
        current = new ProcessBuilder("/system/bin/setsid", "/system/bin/sh", "-c",
                "PATH=/sbin:/system/xbin:/system/bin:$PATH; exec su 2000 -c " + RescueFiles.quote(server) + " </dev/null >>" + RescueFiles.quote(log.getPath()) + " 2>&1")
                .start();
        currentScid = scid;
        RuntimeLog.event("desktop_server_started scid=" + scid + " fps=" + maxFps + " bit_rate=" + bitRate);
        return new JSONObject().put("ok", true).put("scid", scid).put("socket", "scrcpy_" + scid).put("version", ScrcpyAsset.VERSION);
    }

    synchronized JSONObject stop() throws Exception {
        stopLocked();
        return new JSONObject().put("ok", true);
    }

    synchronized JSONObject status() throws Exception {
        boolean alive = current != null && current.isAlive();
        return new JSONObject().put("running", alive).put("scid", alive ? currentScid : "").put("scrcpy_ready", ScrcpyAsset.verifyInstalled());
    }

    private void stopLocked() {
        if (!currentScid.isEmpty()) {
            // 按 scid 精确结束（含 su 与 app_process 两层）；pkill 自身不在匹配范围。
            try { new ProcessBuilder("/system/bin/pkill", "-f", "scid=" + currentScid).start().waitFor(); } catch (Exception ignored) { }
            RuntimeLog.event("desktop_server_stopped scid=" + currentScid);
        }
        if (current != null) { try { current.destroy(); } catch (Exception ignored) { } current = null; }
        currentScid = "";
    }
}
