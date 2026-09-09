package net.elfradio.elfremote;

import org.json.JSONObject;

final class RebootPolicy {
    static final long WINDOW_MS = 120000L;

    // 只有执行器实际写下本次开机标记，才可确认本次命令引起了重启。
    static String outcome(JSONObject intent, String boot, String executedBoot, boolean failed, long now) {
        if (intent.optInt("format") != 2) return "legacy-unconfirmed";
        if (failed) return "command-failed";
        String armed = intent.optString("boot");
        if (!armed.equals(boot)) return armed.equals(executedBoot) ? "confirmed" : "not-executed";
        if (now >= intent.optLong("deadline")) return executedBoot.isEmpty() ? "not-executed" : "unconfirmed";
        return "waiting";
    }

    static String command(long deadline, String boot, String marker) {
        if (deadline <= 0 || !boot.matches("[a-zA-Z0-9-]{1,64}")) throw new IllegalArgumentException("invalid reboot intent");
        String file = RescueFiles.quote(marker), temp = RescueFiles.quote(marker + ".tmp");
        String failed = RescueFiles.quote(marker + ".failed");
        return "set -e\n"
                + "trap 'rc=$?; if [ \"$rc\" != 0 ]; then echo \"$rc\" > " + failed + "; fi' EXIT\n"
                + "test \"$(cat /proc/sys/kernel/random/boot_id)\" = " + RescueFiles.quote(boot) + "\n"
                + "test $(date +%s) -lt " + deadline / 1000L + "\nsync\n"
                + "printf '%s\\n' " + RescueFiles.quote(boot) + " > " + temp + "\nmv " + temp + " " + file + "\nsync\n"
                + "test $(date +%s) -lt " + deadline / 1000L + "\nreboot\n";
    }

    private RebootPolicy() { }
}
