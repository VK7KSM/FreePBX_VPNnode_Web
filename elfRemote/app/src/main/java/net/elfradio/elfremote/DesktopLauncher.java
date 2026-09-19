package net.elfradio.elfremote;

import org.json.JSONObject;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
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
        // 每次拉起前重申 uid 2000 需要的读取权限，并把可读性写进日志，避免偶发的类路径为空。
        // 核心目录在这里也要按回 0700：早期版本把 scrcpy 放在里面并放宽过它，升级后不能留着。
        try {
            new ProcessBuilder("/system/bin/sh", "-c", "mkdir -p " + ScrcpyAsset.ROOT
                    + "; chmod 2771 /data/local/elfremote; chmod 0700 " + CoreInstaller.DIR
                    + "; chmod 0711 " + ScrcpyAsset.ROOT + "; chmod 0644 " + ScrcpyAsset.TARGET
                    + "; echo \"PRECHECK $(date +%s) $(ls -l " + ScrcpyAsset.TARGET + " 2>&1) readable_by_2000=$(su 2000 -c 'test -r " + ScrcpyAsset.TARGET + " && echo yes || echo no' 2>&1)\" >> " + RescueFiles.quote(log.getPath()))
                    .start().waitFor();
        } catch (Exception ignored) { }
        if (log.length() > 262144) log.delete();
        String server = "CLASSPATH=" + ScrcpyAsset.TARGET + " app_process / com.genymobile.scrcpy.Server " + ScrcpyAsset.VERSION
                + " scid=" + scid + " tunnel_forward=true audio=false control=true cleanup=true power_on=true"
                + " send_dummy_byte=false log_level=info max_fps=" + maxFps + " video_bit_rate=" + bitRate
                + (maxSize > 0 ? " max_size=" + maxSize : "");
        // setsid 独立进程组；su 2000 降权；输出到日志。
        // 移植提醒：这里的 "su 2000 -c" 是 Magisk 风格。D31 上的 AOSP su 不认 -c，
        // 必须写成 "su 2000 /system/bin/sh -c"；另外有的机型会清理 /data/local/tmp，
        // 资产放那里会静默消失，表现成类路径为空的 ClassNotFoundException，必须放核心同级目录。
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
            // pkill -f 要靠 ps 能看到完整参数，部分机型看不到（SIP-dev 在 Android 12 上实测），
            // 匹配不到就会留下一个占着抽象套接字的残留进程，下一次会话连不上。再直接扫一遍 /proc 兜底。
            killByScid(currentScid);
            RuntimeLog.event("desktop_server_stopped scid=" + currentScid);
        }
        if (current != null) { try { current.destroy(); } catch (Exception ignored) { } current = null; }
        currentScid = "";
    }

    /** 直接读 /proc 的 cmdline 按 scid 匹配，连 su 与 app_process 两层一起收掉，自身进程排除在外。 */
    private static void killByScid(String scid) {
        File[] entries = new File("/proc").listFiles();
        if (entries == null) return;
        int self = android.os.Process.myPid();
        String needle = "scid=" + scid;
        for (File entry : entries) {
            int pid;
            try { pid = Integer.parseInt(entry.getName()); } catch (Exception notAPid) { continue; }
            if (pid == self) continue;
            String command = readCmdline(new File(entry, "cmdline"));
            if (command == null || !command.contains(needle)) continue;
            try { android.os.Process.killProcess(pid); } catch (Exception ignored) { }
        }
    }

    /** cmdline 以 NUL 分隔，读成以空格分隔的一行供匹配；进程随时可能消失，读失败即当作不匹配。 */
    private static String readCmdline(File file) {
        try (InputStream in = new FileInputStream(file)) {
            byte[] buffer = new byte[4096];
            int n = in.read(buffer);
            if (n <= 0) return null;
            return new String(buffer, 0, n, "UTF-8").replace('\0', ' ');
        } catch (Exception unavailable) { return null; }
    }
}
