package net.elfradio.elfremote;

final class HealRecovery {
    // 仅收尾跨开机遗留命令，保留原件，绝不重放。旧版无开机标记时只识别旧重启脚本。
    static String script() {
        return "recover_heal() {\n"
                + "  [ -f \"$DIR/heal.running\" ] || return 0\n"
                + "  current=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || true)\n"
                + "  [ -n \"$current\" ] || return 0\n"
                + "  previous=$(cat \"$DIR/heal.boot\" 2>/dev/null || true)\n"
                + "  if [ -n \"$previous\" ]; then\n"
                + "    [ \"$previous\" != \"$current\" ] || return 0\n"
                + "  else\n"
                + "    [ \"$(wc -l < \"$DIR/heal.running\")\" -eq 1 ] || return 0\n"
                + "    grep -Eq '^set -e; test \\$\\(date \\+%s\\) -lt [0-9]+; sync; reboot$' \"$DIR/heal.running\" || return 0\n"
                + "    modified=$(stat -c %Y \"$DIR/heal.running\") || return 0\n"
                + "    read up rest < /proc/uptime || return 0\n"
                + "    boot_at=$(($(date +%s) - ${up%%.*}))\n"
                + "    [ \"$modified\" -lt $((boot_at - 2)) ] || return 0\n"
                + "    for process in /proc/[0-9]*/cmdline; do\n"
                + "      if tr '\\000' '\\n' < \"$process\" 2>/dev/null | grep -Fxq \"$DIR/heal.running\"; then return 0; fi\n"
                + "    done\n"
                + "  fi\n"
                + "  archive=\"$DIR/heal-archive/$(date +%s)-$$\"\n"
                + "  mkdir -p \"$archive\" || return 1\n"
                + "  for item in heal.running heal.boot heal.rc heal.out; do\n"
                + "    [ ! -f \"$DIR/$item\" ] || cp -p \"$DIR/$item\" \"$archive/$item\" || return 1\n"
                + "  done\n"
                + "  cmp -s \"$DIR/heal.running\" \"$archive/heal.running\" || return 1\n"
                + "  rm -f \"$DIR/heal.running\" \"$DIR/heal.boot\"\n"
                + "}\n"
                + "recover_heal\n";
    }

    private HealRecovery() { }
}
