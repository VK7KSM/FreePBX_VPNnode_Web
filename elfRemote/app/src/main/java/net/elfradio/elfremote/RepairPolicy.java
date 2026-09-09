package net.elfradio.elfremote;

import org.json.JSONObject;

import java.security.MessageDigest;
import java.util.Map;

final class RepairPolicy {
    static final String TYPE_PULL_LOGS = "pull_logs";
    static final String TYPE_HEAL_NETWORK = "heal_network";
    static final String TYPE_REBOOT = "reboot";
    static final String TYPE_INSTALL_APK = "install_apk";
    static final String TYPE_RESTART_ADBD = "restart_adbd";
    static final String TYPE_SCAN_WIFI = "scan_wifi";
    static final String TYPE_PLAY_ALARM = "play_alarm";
    static final String TYPE_STOP_ALARM = "stop_alarm";
    static final String TYPE_LOCATE_NOW = "locate_now";
    static final String PHASE_RUNNING = "running";
    static final String PHASE_INSTALLING = "installing";
    static final String PHASE_DONE = "done";
    static final String TASK_APK = "/data/local/elfremote/task.apk";
    static final String WANT_FILE = "/data/local/elfremote/task.want";
    static final String PHASE_FILE = "/data/local/elfremote/task.phase";
    static final String BOOT_FILE = "/data/local/elfremote/task.boot";
    static final String ST_PENDING = "pending";
    static final String ST_CLAIMED = "claimed";
    static final String ST_RUNNING = "running";
    static final String ST_SUCCESS = "success";
    static final String ST_FAILED = "failed";
    static final String ST_EXPIRED = "expired";
    static final String ST_REJECTED = "rejected";
    static final int MAX_LOG_BYTES = 3 * 1024 * 1024;
    static final String LAST_TASK_FILE = "/data/local/elfremote/task.last";
    static final String[] LOG_PATHS = {
            "/data/local/tmp/elfremote_wd.log",
            "/data/local/tmp/elfremote_wd.stats",
            "/data/local/elfremote/watchdog.log",
            "/data/local/elfremote/watchdog.stats",
            "/data/local/elfremote/update.state",
            "/data/local/elfremote/update.out",
            "/data/local/elfremote/health.ok"
    };

    static final class Pack {
        String text = "";
        String sha256 = "";
        int size;
        boolean truncated;
    }

    static boolean allowedType(String type) {
        if("root_exec".equals(type)) return true;
        if("set_lost_mode".equals(type)) return true;
        if (configType(type)) return true;
        return TYPE_PULL_LOGS.equals(type)
                || TYPE_HEAL_NETWORK.equals(type)
                || TYPE_REBOOT.equals(type)
                || TYPE_INSTALL_APK.equals(type)
                || TYPE_RESTART_ADBD.equals(type)
                || TYPE_SCAN_WIFI.equals(type)
                || TYPE_PLAY_ALARM.equals(type) || TYPE_STOP_ALARM.equals(type) || TYPE_LOCATE_NOW.equals(type);
    }

    static boolean configType(String type) {
        return "connect_wifi".equals(type) || "contacts_read".equals(type) || "contact_add".equals(type)
                || "contact_update".equals(type) || "contact_delete".equals(type);
    }

    static String rejectReason(JSONObject task, long nowMs) {
        if (task == null) return "missing";
        if (task.optString("id", "").length() == 0) return "missing-id";
        if (task.optString("idempotency_key", "").length() == 0) return "missing-key";
        if (!allowedType(task.optString("type", ""))) return "unknown-type";
        long exp = task.optLong("expires_at", 0L);
        if (exp > 0 && nowMs >= exp) return "expired";
        return "";
    }

    static JSONObject parseOffer(JSONObject task, long nowMs) {
        if (task == null) return null;
        if (rejectReason(task, nowMs).length() > 0) return null;
        return task;
    }

    static boolean alreadyDone(String lastId, String taskId) {
        return alreadyDone(lastId, PHASE_DONE, taskId);
    }

    static boolean alreadyDone(String lastId, String phase, String taskId) {
        if (lastId == null || lastId.length() == 0 || !lastId.equals(taskId)) return false;
        if (phase == null || phase.length() == 0) return true;
        return PHASE_DONE.equals(phase);
    }

    static boolean shouldConfirmReboot(String lastId, String phase, String taskId) {
        return lastId != null && lastId.equals(taskId) && PHASE_RUNNING.equals(phase);
    }

    static boolean shouldConfirmReboot(String lastId, String phase, String taskId,
                                       String armedBoot, String nowBoot) {
        if (!shouldConfirmReboot(lastId, phase, taskId)) return false;
        if (armedBoot == null || armedBoot.length() == 0) return false;
        if (nowBoot == null || nowBoot.length() == 0) return false;
        return !armedBoot.equals(nowBoot);
    }

    static String rebootCommand() {
        return "reboot";
    }

    static String expiringRebootCommand(long deadline) {
        if (deadline <= 0) throw new IllegalArgumentException("reboot deadline missing");
        return "set -e; test $(date +%s) -lt " + (deadline / 1000L) + "; sync; reboot";
    }

    static String adbdCommand() {
        return "set -e\n"
                + "old_port=$(getprop service.adb.tcp.port)\n"
                + "added4=0; added6=0; changed=0\n"
                + "restore() { rc=$?; trap - EXIT; if [ \"$rc\" != 0 ]; then"
                + " set +e; if [ \"$changed\" = 1 ]; then setprop service.adb.tcp.port \"$old_port\"; stop adbd; start adbd; fi;"
                + " if [ \"$added4\" = 1 ]; then iptables -D INPUT ! -i lo -p tcp --dport 5555 -j DROP; fi;"
                + " if [ \"$added6\" = 1 ]; then ip6tables -D INPUT ! -i lo -p tcp --dport 5555 -j DROP; fi; fi; exit \"$rc\"; }\n"
                + "trap restore EXIT\n"
                + "rule() { if ! \"$1\" -C INPUT ! -i lo -p tcp --dport 5555 -j DROP 2>/dev/null; then"
                + " \"$1\" -I INPUT 1 ! -i lo -p tcp --dport 5555 -j DROP;"
                + " case \"$1\" in iptables) added4=1;; ip6tables) added6=1;; esac; fi; }\n"
                + "rule iptables\nrule ip6tables\n"
                + "changed=1\nsetprop service.adb.tcp.port 5555\nstop adbd\nstart adbd\n"
                + "tries=0\nwhile ! { [ \"$(getprop init.svc.adbd)\" = running ]"
                + " && netstat -tln | grep -E ':5555[[:space:]]'; }; do"
                + " tries=$((tries+1)); [ \"$tries\" -lt 20 ]; sleep 1; done\n"
                + "test \"$(getprop service.adb.tcp.port)\" = 5555\n"
                + "iptables -C INPUT ! -i lo -p tcp --dport 5555 -j DROP\n"
                + "ip6tables -C INPUT ! -i lo -p tcp --dport 5555 -j DROP\n"
                + "netstat -tln | grep -E ':5555[[:space:]]'\n"
                + "trap - EXIT\necho ADBD_LOOPBACK_OK\n";
    }

    static boolean adbdSucceeded(String rc, String output) {
        if (!"0".equals(rc) || output == null) return false;
        for (String line : output.split("\\r?\\n")) if ("ADBD_LOOPBACK_OK".equals(line.trim()) || "ADBD_LAN_OK".equals(line.trim())) return true;
        return false;
    }

    static String expiringAdbdCommand(long deadline) {
        return expiringAdbdCommand(deadline, "");
    }

    static String expiringAdbdCommand(long deadline, String peer) {
        if (deadline <= 0) throw new IllegalArgumentException("adbd deadline missing");
        String command = adbdCommand();
        if (peer != null && !peer.isEmpty()) {
            String[] parts = peer.split("\\.", -1);
            if (parts.length != 4) throw new IllegalArgumentException("invalid-lan-peer");
            for (String part : parts) if (!part.matches("0|[1-9][0-9]{0,2}") || Integer.parseInt(part) > 255)
                throw new IllegalArgumentException("invalid-lan-peer");
            boolean local = peer.startsWith("192.168.") || peer.startsWith("10.")
                    || (parts[0].equals("172") && Integer.parseInt(parts[1]) >= 16 && Integer.parseInt(parts[1]) <= 31);
            if (!local) throw new IllegalArgumentException("invalid-lan-peer");
            String rule = "INPUT -i wlan+ -s " + peer + " -p tcp --dport 5555 -j ACCEPT";
            command = command.replace("added4=0;", "addedlan=0; added4=0;")
                    .replace("set +e; if", "set +e; if [ \"$addedlan\" = 1 ]; then iptables -D " + rule + "; fi; if")
                    .replace("rule iptables\nrule ip6tables\n", "rule iptables\nrule ip6tables\n"
                            + "if ! iptables -C " + rule + " 2>/dev/null; then iptables -I " + rule.replace("INPUT ", "INPUT 1 ") + "; addedlan=1; fi\n")
                    .replace("trap - EXIT\necho ADBD_LOOPBACK_OK", "iptables -C " + rule + "\ntrap - EXIT\necho ADBD_LAN_OK");
        }
        return "set -e\ntest $(date +%s) -lt " + (deadline / 1000L) + "\n" + command;
    }

    static String installCommand() {
        return "mount -o rw,remount /system"
                + " && cp " + TASK_APK + " /system/app/ElfRemote/ElfRemote.apk"
                + " && chmod 644 /system/app/ElfRemote/ElfRemote.apk"
                + " && reboot";
    }

    static boolean alreadyOnTarget(String haveName, String wantName) {
        return haveName != null && haveName.length() > 0 && haveName.equals(wantName);
    }

    static boolean shouldConfirmInstall(String lastId, String phase, String taskId,
                                        String haveName, String wantName) {
        if (lastId == null || !lastId.equals(taskId)) return false;
        if (!PHASE_INSTALLING.equals(phase)) return false;
        return alreadyOnTarget(haveName, wantName);
    }

    static JSONObject parseInstallParams(JSONObject p) {
        if (p == null) return null;
        try {
            if (!"net.elfradio.elfremote".equals(p.optString("package", ""))) return null;
            if (p.optInt("versionCode", 0) <= 0) return null;
            if (p.optString("versionName", "").length() == 0) return null;
            String sha = p.optString("sha256", "");
            if (sha.length() != 64 || !sha.matches("[0-9a-f]{64}")) return null;
            if (p.optInt("size", 0) <= 0) return null;
            String url = p.optString("url", "");
            if (!url.startsWith("https://")) return null;
            if (url.contains("127.0.0.1") || url.contains("://localhost")) return null;
            return p;
        } catch (Exception e) {
            return null;
        }
    }

    static String typeLabel(String type) {
        if (TYPE_PULL_LOGS.equals(type)) return "拉取日志";
        if (TYPE_HEAL_NETWORK.equals(type)) return "强制自愈";
        if (TYPE_REBOOT.equals(type)) return "受控重启";
        if (TYPE_INSTALL_APK.equals(type)) return "覆盖安装";
        if (TYPE_RESTART_ADBD.equals(type)) return "重启本机adbd";
        if (TYPE_SCAN_WIFI.equals(type)) return "扫描 Wi-Fi";
        return "";
    }

    static String stateLabel(String state) {
        if (ST_PENDING.equals(state)) return "待领取";
        if (ST_CLAIMED.equals(state)) return "已领取";
        if (ST_RUNNING.equals(state)) return "执行中";
        if (ST_SUCCESS.equals(state)) return "成功";
        if (ST_FAILED.equals(state)) return "失败";
        if (ST_EXPIRED.equals(state)) return "已过期";
        if (ST_REJECTED.equals(state)) return "已拒绝";
        return "";
    }

    static Pack packLogs(Map<String, String> files, String logcat, String appVersion) {
        StringBuilder sb = new StringBuilder();
        sb.append("app_version=").append(appVersion == null ? "" : appVersion).append('\n');
        if (files != null) {
            for (Map.Entry<String, String> e : files.entrySet()) {
                if (e.getKey() == null) continue;
                sb.append("== ").append(e.getKey()).append(" ==\n");
                if (e.getValue() != null) sb.append(e.getValue());
                if (sb.length() == 0 || sb.charAt(sb.length() - 1) != '\n') sb.append('\n');
            }
        }
        if (logcat != null && logcat.length() > 0) {
            sb.append("== logcat ==\n").append(logcat);
            if (sb.charAt(sb.length() - 1) != '\n') sb.append('\n');
        }
        Pack p = new Pack();
        try {
            byte[] all = sb.toString().getBytes("UTF-8");
            p.truncated = all.length > MAX_LOG_BYTES;
            if (p.truncated) {
                byte[] cut = new byte[MAX_LOG_BYTES];
                System.arraycopy(all, 0, cut, 0, MAX_LOG_BYTES);
                p.text = new String(cut, "UTF-8");
                byte[] packed = p.text.getBytes("UTF-8");
                while (packed.length > MAX_LOG_BYTES && p.text.length() > 0) {
                    p.text = p.text.substring(0, p.text.length() - 1);
                    packed = p.text.getBytes("UTF-8");
                }
                p.size = packed.length;
                p.sha256 = sha256Hex(packed);
            } else {
                p.text = sb.toString();
                p.size = all.length;
                p.sha256 = sha256Hex(all);
            }
        } catch (Exception e) {
            p.text = "app_version=\npack-error\n";
            p.size = p.text.length();
            p.sha256 = sha256Hex(p.text.getBytes());
        }
        return p;
    }

    static String sha256Hex(byte[] data) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] d = md.digest(data == null ? new byte[0] : data);
            StringBuilder sb = new StringBuilder(d.length * 2);
            for (int i = 0; i < d.length; i++) {
                String h = Integer.toHexString(d[i] & 0xff);
                if (h.length() == 1) sb.append('0');
                sb.append(h);
            }
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    private RepairPolicy() {}
}
