package net.elfradio.elfremote;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.Charset;

final class WatchdogPolicy {
    static final String PKG = "net.elfradio.elfremote";
    static final String COMPONENT = "net.elfradio.elfremote/.ReportService";
    static final String INIT_SERVICE = "elfremote_wd";
    static final String DIR = "/data/local/elfremote";
    static final String SCRIPT_PATH = "/data/local/elfremote/watchdog.sh";
    static final String MAGISK_WRAPPER_PATH = "/data/adb/service.d/elfremote_watchdog.sh";
    static final String INIT_RC_PATH = "/system/etc/init/elfremote.rc";
    static final String LOCK_DIR = "/data/local/elfremote/lock.d";
    static final String PID_FILE = "/data/local/elfremote/watchdog.pid";
    static final String LOG = DIR + "/watchdog.log";
    static final String STATS = DIR + "/watchdog.stats";
    static final int SLEEP_SEC = 20;
    static final int STATS_EVERY_LOOPS = 15;
    static final int LOG_MAX_BYTES = 24 * 1024;
    static final long WD_RSS_KB_MAX = 4096;
    static final long APP_RSS_KB_MAX = 64 * 1024;
    static final String NOTIFY_CHANNEL = "elfremote-quiet";

    static boolean notificationLaunchesUi() {
        return false;
    }

    static long pairedReportIntervalMs() {
        return 60_000L;
    }

    static long unpairedReportIntervalMs() {
        return 10_000L;
    }

    static String script() {
        return ""
                + "#!/system/bin/sh\n"
                + "# Independent keeper for elfRemote only.\n"
                + "export PATH=/system/bin:/system/xbin:/sbin:/vendor/bin:$PATH\n"
                + "SCRIPT=" + SCRIPT_PATH + "\n"
                + "PKG=" + PKG + "\n"
                + "COMP=" + COMPONENT + "\n"
                + "DIR=" + DIR + "\n"
                + "LOCK=" + LOCK_DIR + "\n"
                + "PIDF=" + PID_FILE + "\n"
                + "LOG=" + LOG + "\n"
                + "STATS=" + STATS + "\n"
                + "SLEEP=" + SLEEP_SEC + "\n"
                + "STATS_EVERY=" + STATS_EVERY_LOOPS + "\n"
                + "LOG_MAX=" + LOG_MAX_BYTES + "\n"
                + "\n"
                + "if [ \"$1\" = \"--foreground\" ]; then\n"
                + "  ELFREMOTE_WD_DAEMON=1\n"
                + "fi\n"
                + "if [ -z \"$ELFREMOTE_WD_DAEMON\" ]; then\n"
                + "  export ELFREMOTE_WD_DAEMON=1\n"
                + "  trap '' HUP\n"
                + "  if command -v setsid >/dev/null 2>&1; then\n"
                + "    setsid /system/bin/sh \"$SCRIPT\" --foreground </dev/null >/dev/null 2>&1 &\n"
                + "  else\n"
                + "    /system/bin/sh \"$SCRIPT\" --foreground </dev/null >/dev/null 2>&1 &\n"
                + "  fi\n"
                + "  exit 0\n"
                + "fi\n"
                + "\n"
                + secureDirectoryCommands()
                + "if ! mkdir \"$LOCK\" 2>/dev/null; then\n"
                + "  old=$(cat \"$PIDF\" 2>/dev/null)\n"
                + "  if [ -n \"$old\" ] && [ -d /proc/$old ]; then\n"
                + "    exit 0\n"
                + "  fi\n"
                + "  rm -rf \"$LOCK\"\n"
                + "  mkdir \"$LOCK\" || exit 0\n"
                + "fi\n"
                + "echo $$ > \"$PIDF\"\n"
                + "cleanup() {\n"
                + "  cur=$(cat \"$PIDF\" 2>/dev/null)\n"
                + "  if [ \"$cur\" = \"$$\" ]; then\n"
                + "    rm -f \"$PIDF\"\n"
                + "    rm -rf \"$LOCK\"\n"
                + "  fi\n"
                + "}\n"
                + "trap cleanup EXIT INT TERM\n"
                + "renice 19 $$ >/dev/null 2>&1\n"
                + "\n"
                + "log() {\n"
                + "  if [ -f \"$LOG\" ]; then\n"
                + "    sz=$(wc -c < \"$LOG\" 2>/dev/null || echo 0)\n"
                + "    sz=${sz% }\n"
                + "    if [ \"$sz\" -gt \"$LOG_MAX\" ] 2>/dev/null; then\n"
                + "      tail -c 8192 \"$LOG\" > \"$LOG.tmp\" 2>/dev/null && mv \"$LOG.tmp\" \"$LOG\"\n"
                + "    fi\n"
                + "  fi\n"
                + "  echo \"$(date '+%Y-%m-%d %H:%M:%S') $*\" >> \"$LOG\"\n"
                + "}\n"
                + "\n"
                + "pkg_pid() {\n"
                + "  p=$(pidof \"$PKG\" 2>/dev/null)\n"
                + "  set -- $p\n"
                + "  echo \"$1\"\n"
                + "}\n"
                + "\n"
                + "rss_kb() {\n"
                + "  pid=\"$1\"\n"
                + "  [ -n \"$pid\" ] && [ -d /proc/$pid ] || { echo 0; return; }\n"
                + "  while IFS= read line; do\n"
                + "    case \"$line\" in\n"
                + "      VmRSS:*) set -- $line; echo \"$2\"; return ;;\n"
                + "    esac\n"
                + "  done < /proc/$pid/status\n"
                + "  echo 0\n"
                + "}\n"
                + "\n"
                + "start_app() {\n"
                + "  if [ \"$(getprop sys.boot_completed)\" != 1 ]; then\n"
                + "    log \"wait boot\"\n"
                + "    return\n"
                + "  fi\n"
                + "  if ! mkdir \"$DIR/starting.d\" 2>/dev/null; then\n"
                + "    log \"skip duplicate start\"\n"
                + "    return\n"
                + "  fi\n"
                + "  if /system/bin/am start-foreground-service --user 0 -n \"$COMP\" >>\"$LOG\" 2>&1; then\n"
                + "    log \"started foreground service\"\n"
                + "  elif /system/bin/am startservice --user 0 -n \"$COMP\" >>\"$LOG\" 2>&1; then\n"
                + "    log \"started service\"\n"
                + "  else\n"
                + "    log \"start service failed\"\n"
                + "  fi\n"
                + "}\n"
                + "\n"
                + "run_heal() {\n"
                + "  cmdf=\"$DIR/heal.cmd\"\n"
                + "  [ -f \"$cmdf\" ] || return\n"
                + "  mv \"$cmdf\" \"$DIR/heal.running\" 2>/dev/null || return\n"
                + "  log \"heal run\"\n"
                + "  /system/bin/sh \"$DIR/heal.running\" > \"$DIR/heal.out\" 2>&1\n"
                + "  echo $? > \"$DIR/heal.rc.tmp\"\n"
                + "  chmod 0660 \"$DIR/heal.out\" \"$DIR/heal.rc.tmp\" 2>/dev/null || true\n"
                + "  mv \"$DIR/heal.rc.tmp\" \"$DIR/heal.rc\"\n"
                + "  rm -f \"$DIR/heal.running\"\n"
                + "}\n"
                + "\n"
                + "run_update() {\n"
                + "  retry_at=$(cat \"$DIR/update.retry-at\" 2>/dev/null)\n"
                + "  case \"$retry_at\" in ''|*[!0-9]*) retry_at=0 ;; esac\n"
                + "  [ \"$(date +%s)\" -ge \"$retry_at\" ] || return\n"
                + "  cmdf=\"$DIR/update.job\"\n"
                + "  [ -f \"$cmdf\" ] || return\n"
                + "  mv \"$cmdf\" \"$DIR/update.running\" 2>/dev/null || return\n"
                + "  log \"update run\"\n"
                + "  if [ ! -f \"$DIR/updater.apk\" ] || [ -f \"$DIR/update.job.json\" -a \"$DIR/update.job.json\" -nt \"$DIR/updater.apk\" ]; then\n"
                + "    src=/system/app/ElfRemote/ElfRemote.apk\n"
                + "    p=$(pm path net.elfradio.elfremote 2>/dev/null)\n"
                + "    p=${p#package:}\n"
                + "    p=${p%%$'\\r'*}\n"
                + "    p=${p%%$'\\n'*}\n"
                + "    [ -n \"$p\" ] && [ -f \"$p\" ] && src=\"$p\"\n"
                + "    cp \"$src\" \"$DIR/updater.apk\" 2>/dev/null || true\n"
                + "  fi\n"
                + "  chmod 0660 \"$DIR/updater.apk\" \"$DIR/update.job.json\" 2>/dev/null || true\n"
                + "  /system/bin/sh \"$DIR/update.running\" > \"$DIR/update.out\" 2>&1\n"
                + "  upd_rc=$?\n"
                + "  echo $upd_rc > \"$DIR/update.rc.tmp\"\n"
                + "  chmod 0660 \"$DIR/update.out\" \"$DIR/update.rc.tmp\" \"$DIR/update.state\" 2>/dev/null || true\n"
                + "  mv \"$DIR/update.rc.tmp\" \"$DIR/update.rc\"\n"
                + "  if [ $upd_rc -ne 0 ]; then\n"
                + "    log \"update retry rc=$upd_rc\"\n"
                + "    echo $(($(date +%s) + 60)) > \"$DIR/update.retry-at\"\n"
                + "    mv \"$DIR/update.running\" \"$DIR/update.job\" 2>/dev/null || true\n"
                + "  else\n"
                + "    rm -f \"$DIR/update.running\"\n"
                + "    rm -f \"$DIR/update.retry-at\"\n"
                + "  fi\n"
                + "}\n"
                + "\n"
                + "log \"start pid=$$\"\n"
                + "if [ -f \"$DIR/update.managed\" ] && [ -f \"$DIR/update.running\" ] && [ ! -f \"$DIR/update.job\" ]; then\n"
                + "  mv \"$DIR/update.running\" \"$DIR/update.job\"\n"
                + "  log \"resume managed update\"\n"
                + "fi\n"
                + "loop=0\n"
                + "while true; do\n"
                + "  run_heal\n"
                + "  run_update\n"
                + "  loop=$((loop + 1))\n"
                + "  if [ $((loop % SLEEP)) -eq 1 ]; then\n"
                + "    pid=$(pkg_pid)\n"
                + "    if [ -z \"$pid\" ]; then\n"
                + "      log \"missing; start service\"\n"
                + "      start_app\n"
                + "    fi\n"
                + "  fi\n"
                + "  if [ $((loop % (STATS_EVERY * SLEEP))) -eq 0 ]; then\n"
                + "    pid=$(pkg_pid)\n"
                + "    echo \"ts=$(date +%s) wd_rss_kb=$(rss_kb $$) app_rss_kb=$(rss_kb $pid) app_pid=$pid wd_pid=$$\" > \"$STATS\"\n"
                + "  fi\n"
                + "  rmdir \"$DIR/starting.d\" 2>/dev/null\n"
                + "  sleep 1\n"
                + "done\n";
    }

    static String initRc() {
        return ""
                + "# Standalone init unit for elfRemote. Do not merge into other device keepers.\n"
                + "service " + INIT_SERVICE + " /system/bin/sh " + SCRIPT_PATH + " --foreground\n"
                + "    class late_start\n"
                + "    user root\n"
                + "    group root\n"
                + "    seclabel u:r:magisk:s0\n"
                + "    oneshot\n"
                + "    disabled\n"
                + "\n"
                + "on property:sys.boot_completed=1\n"
                + "    start " + INIT_SERVICE + "\n";
    }

    static String magiskWrapper() {
        return ""
                + "#!/system/bin/sh\n"
                + "# Independent Magisk late-start launcher for elfRemote only.\n"
                + "export PATH=/system/bin:/system/xbin:/sbin:/vendor/bin:$PATH\n"
                + "export ELFREMOTE_WD_DAEMON=1\n"
                + "exec /system/bin/sh " + SCRIPT_PATH + " --foreground\n";
    }

    static String applyCommands(String stagedDir) {
        return ""
                + "#!/system/bin/sh\n"
                + "export PATH=/system/bin:/system/xbin:/sbin:/vendor/bin:$PATH\n"
                + "STAGED=\"" + stagedDir + "\"\n"
                + "DIR=" + DIR + "\n"
                + secureDirectoryCommands()
                + "copy_if_changed() {\n"
                + "  src=\"$1\"; dst=\"$2\"; mode=\"$3\"\n"
                + "  if [ -f \"$dst\" ] && cmp -s \"$src\" \"$dst\" 2>/dev/null; then\n"
                + "    return 0\n"
                + "  fi\n"
                + "  cp \"$src\" \"$dst\"\n"
                + "  chmod \"$mode\" \"$dst\"\n"
                + "  return 1\n"
                + "}\n"
                + "copy_if_changed \"$STAGED/watchdog.sh\" " + SCRIPT_PATH + " 0755 || true\n"
                + "if [ -d /data/adb/service.d ]; then\n"
                + "  copy_if_changed \"$STAGED/magisk.sh\" " + MAGISK_WRAPPER_PATH + " 0755 || true\n"
                + "fi\n"
                + "need_init=0\n"
                + "if [ -d /system/etc/init ]; then\n"
                + "  if [ ! -f " + INIT_RC_PATH + " ] || ! cmp -s \"$STAGED/elfremote.rc\" "
                + INIT_RC_PATH + " 2>/dev/null; then\n"
                + "    need_init=1\n"
                + "  fi\n"
                + "  if [ \"$need_init\" = 1 ]; then\n"
                + "    if cp \"$STAGED/elfremote.rc\" " + INIT_RC_PATH + " 2>/dev/null; then\n"
                + "      chmod 0644 " + INIT_RC_PATH + "\n"
                + "    else\n"
                + "      mount -o remount,rw /system 2>/dev/null || true\n"
                + "      cp \"$STAGED/elfremote.rc\" " + INIT_RC_PATH + " 2>/dev/null || true\n"
                + "      chmod 0644 " + INIT_RC_PATH + " 2>/dev/null || true\n"
                + "      restorecon " + INIT_RC_PATH + " 2>/dev/null || true\n"
                + "      mount -o remount,ro /system 2>/dev/null || true\n"
                + "    fi\n"
                + "    start " + INIT_SERVICE + " 2>/dev/null || true\n"
                + "  fi\n"
                + "fi\n"
                + "alive=0\n"
                + "if [ -f " + PID_FILE + " ]; then\n"
                + "  p=$(cat " + PID_FILE + ")\n"
                + "  [ -n \"$p\" ] && [ -d /proc/$p ] && alive=1\n"
                + "fi\n"
                + "if [ \"$alive\" = 0 ]; then\n"
                + "  /system/bin/sh " + SCRIPT_PATH + " >/dev/null 2>&1\n"
                + "fi\n"
                + "exit 0\n";
    }

    static String secureDirectoryCommands() {
        return "APP_UID=$(stat -c %u /data/user/0/" + PKG + ") || exit 1\n"
                + "case \"$APP_UID\" in ''|*[!0-9]*) exit 1;; esac\n"
                + "[ \"$APP_UID\" -ge 10000 ] || exit 1\n"
                + "[ ! -L \"$DIR\" ] || exit 1\n"
                + "mkdir -p \"$DIR\" || exit 1\n"
                + "chown 0:0 \"$DIR\" && chmod 0700 \"$DIR\" || exit 1\n"
                + "[ -z \"$(find \"$DIR\" -type l -print)\" ] || exit 1\n"
                + "chown -R 0:\"$APP_UID\" \"$DIR\" || exit 1\n"
                + "find \"$DIR\" -type f -exec chmod 0660 {} \\; || exit 1\n"
                + "find \"$DIR\" -type d -exec chmod 2770 {} \\; || exit 1\n"
                + "umask 007\n";
    }

    static void stage(File dir) throws IOException {
        if (dir == null) throw new IOException("stage dir missing");
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("mkdir " + dir.getPath());
        write(new File(dir, "watchdog.sh"), script());
        write(new File(dir, "elfremote.rc"), initRc());
        write(new File(dir, "magisk.sh"), magiskWrapper());
    }

    private static void write(File f, String text) throws IOException {
        FileOutputStream out = new FileOutputStream(f);
        try {
            out.write(text.getBytes(Charset.forName("UTF-8")));
        } finally {
            out.close();
        }
    }

    private WatchdogPolicy() {}
}
