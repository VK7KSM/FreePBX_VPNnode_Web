#!/system/bin/sh
# Independent keeper for elfRemote only.
export PATH=/system/bin:/system/xbin:/sbin:/vendor/bin:$PATH
SCRIPT=/data/local/elfremote/watchdog.sh
PKG=net.elfradio.elfremote
COMP=net.elfradio.elfremote/.ReportService
DIR=/data/local/elfremote
LOCK=/data/local/elfremote/lock.d
PIDF=/data/local/elfremote/watchdog.pid
LOG=/data/local/elfremote/watchdog.log
STATS=/data/local/elfremote/watchdog.stats
SLEEP=20
STATS_EVERY=15
LOG_MAX=24576

if [ "$1" = "--foreground" ]; then
  ELFREMOTE_WD_DAEMON=1
fi
if [ -z "$ELFREMOTE_WD_DAEMON" ]; then
  export ELFREMOTE_WD_DAEMON=1
  trap '' HUP
  if command -v setsid >/dev/null 2>&1; then
    setsid /system/bin/sh "$SCRIPT" --foreground </dev/null >/dev/null 2>&1 &
  else
    /system/bin/sh "$SCRIPT" --foreground </dev/null >/dev/null 2>&1 &
  fi
  exit 0
fi

APP_UID=$(stat -c %u /data/user/0/net.elfradio.elfremote) || exit 1
case "$APP_UID" in ''|*[!0-9]*) exit 1;; esac
[ "$APP_UID" -ge 10000 ] || exit 1
if [ -d "$DIR" ] && [ ! -L "$DIR" ] && [ "$(stat -c %u:%g:%a "$DIR")" = "0:$APP_UID:2770" ]; then
  umask 007
else
APP_UID=$(stat -c %u /data/user/0/net.elfradio.elfremote) || exit 1
case "$APP_UID" in ''|*[!0-9]*) exit 1;; esac
[ "$APP_UID" -ge 10000 ] || exit 1
[ ! -L "$DIR" ] || exit 1
mkdir -p "$DIR" || exit 1
chown 0:0 "$DIR" && chmod 0700 "$DIR" || exit 1
[ -z "$(find "$DIR" -type l -print)" ] || exit 1
chown -R 0:"$APP_UID" "$DIR" || exit 1
find "$DIR" -type f -exec chmod 0660 {} \; || exit 1
find "$DIR" -type d -exec chmod 2770 {} \; || exit 1
umask 007
fi
if ! mkdir "$LOCK" 2>/dev/null; then
  old=$(cat "$PIDF" 2>/dev/null)
  if [ -n "$old" ] && [ "$old" != "$$" ] && [ -r /proc/$old/cmdline ] && tr '\000' '\n' < /proc/$old/cmdline | grep -Fxq "$SCRIPT"; then
    exit 0
  fi
  rm -rf "$LOCK"
  mkdir "$LOCK" || exit 0
fi
echo $$ > "$PIDF"
cleanup() {
  cur=$(cat "$PIDF" 2>/dev/null)
  if [ "$cur" = "$$" ]; then
    rm -f "$PIDF"
    rm -rf "$LOCK"
  fi
}
trap cleanup EXIT
trap 'exit 0' INT TERM
renice 19 $$ >/dev/null 2>&1

log() {
  if [ -f "$LOG" ]; then
    sz=$(wc -c < "$LOG" 2>/dev/null || echo 0)
    sz=${sz% }
    if [ "$sz" -gt "$LOG_MAX" ] 2>/dev/null; then
      tail -c 8192 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
    fi
  fi
  echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"
}

pkg_pid() {
  p=$(pidof "$PKG" 2>/dev/null)
  set -- $p
  echo "$1"
}

rss_kb() {
  pid="$1"
  [ -n "$pid" ] && [ -d /proc/$pid ] || { echo 0; return; }
  while IFS= read line; do
    case "$line" in
      VmRSS:*) set -- $line; echo "$2"; return ;;
    esac
  done < /proc/$pid/status
  echo 0
}

start_app() {
  if [ "$(getprop sys.boot_completed)" != 1 ]; then
    log "wait boot"
    return
  fi
  if ! mkdir "$DIR/starting.d" 2>/dev/null; then
    log "skip duplicate start"
    return
  fi
  if /system/bin/am start-foreground-service --user 0 -n "$COMP" >>"$LOG" 2>&1; then
    log "started foreground service"
  elif /system/bin/am startservice --user 0 -n "$COMP" >>"$LOG" 2>&1; then
    log "started service"
  else
    log "start service failed"
  fi
}

run_heal() {
  cmdf="$DIR/heal.cmd"
  [ -f "$cmdf" ] || return
  [ ! -f "$DIR/heal.running" ] || return
  cat /proc/sys/kernel/random/boot_id > "$DIR/heal.boot.tmp" || return
  mv "$DIR/heal.boot.tmp" "$DIR/heal.boot" || return
  mv "$cmdf" "$DIR/heal.running" 2>/dev/null || return
  log "heal run"
  /system/bin/sh "$DIR/heal.running" > "$DIR/heal.out" 2>&1
  echo $? > "$DIR/heal.rc.tmp"
  chmod 0660 "$DIR/heal.out" "$DIR/heal.rc.tmp" 2>/dev/null || true
  mv "$DIR/heal.rc.tmp" "$DIR/heal.rc"
  rm -f "$DIR/heal.running" "$DIR/heal.boot"
}

run_update() {
  retry_at=$(cat "$DIR/update.retry-at" 2>/dev/null)
  case "$retry_at" in ''|*[!0-9]*) retry_at=0 ;; esac
  [ "$(date +%s)" -ge "$retry_at" ] || return
  cmdf="$DIR/update.job"
  [ -f "$cmdf" ] || return
  mv "$cmdf" "$DIR/update.running" 2>/dev/null || return
  log "update run"
  if [ ! -f "$DIR/updater.apk" ] || [ -f "$DIR/update.job.json" -a "$DIR/update.job.json" -nt "$DIR/updater.apk" ]; then
    src=/system/app/ElfRemote/ElfRemote.apk
    p=$(pm path net.elfradio.elfremote 2>/dev/null)
    p=${p#package:}
    p=${p%%$'\r'*}
    p=${p%%$'\n'*}
    [ -n "$p" ] && [ -f "$p" ] && src="$p"
    cp "$src" "$DIR/updater.apk" 2>/dev/null || true
  fi
  chmod 0660 "$DIR/updater.apk" "$DIR/update.job.json" 2>/dev/null || true
  /system/bin/sh "$DIR/update.running" > "$DIR/update.out" 2>&1
  upd_rc=$?
  echo $upd_rc > "$DIR/update.rc.tmp"
  chmod 0660 "$DIR/update.out" "$DIR/update.rc.tmp" "$DIR/update.state" 2>/dev/null || true
  mv "$DIR/update.rc.tmp" "$DIR/update.rc"
  if [ $upd_rc -ne 0 ]; then
    log "update retry rc=$upd_rc"
    backoff=$(cat "$DIR/update.backoff" 2>/dev/null)
    case "$backoff" in ''|*[!0-9]*) backoff=30;; esac
    backoff=$((backoff * 2)); [ $backoff -le 900 ] || backoff=900
    if [ $upd_rc -eq 75 ]; then backoff=300; fi
    echo $backoff > "$DIR/update.backoff"
    echo $(($(date +%s) + backoff)) > "$DIR/update.retry-at"
    mv "$DIR/update.running" "$DIR/update.job" 2>/dev/null || true
  else
    rm -f "$DIR/update.running"
    rm -f "$DIR/update.retry-at" "$DIR/update.backoff"
  fi
}

log "start pid=$$ uptime=$(cat /proc/uptime)"
recover_heal() {
  [ -f "$DIR/heal.running" ] || return 0
  current=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || true)
  [ -n "$current" ] || return 0
  previous=$(cat "$DIR/heal.boot" 2>/dev/null || true)
  if [ -n "$previous" ]; then
    [ "$previous" != "$current" ] || return 0
  else
    [ "$(wc -l < "$DIR/heal.running")" -eq 1 ] || return 0
    grep -Eq '^set -e; test \$\(date \+%s\) -lt [0-9]+; sync; reboot$' "$DIR/heal.running" || return 0
    modified=$(stat -c %Y "$DIR/heal.running") || return 0
    read up rest < /proc/uptime || return 0
    boot_at=$(($(date +%s) - ${up%%.*}))
    [ "$modified" -lt $((boot_at - 2)) ] || return 0
    for process in /proc/[0-9]*/cmdline; do
      if tr '\000' '\n' < "$process" 2>/dev/null | grep -Fxq "$DIR/heal.running"; then return 0; fi
    done
  fi
  archive="$DIR/heal-archive/$(date +%s)-$$"
  mkdir -p "$archive" || return 1
  for item in heal.running heal.boot heal.rc heal.out; do
    [ ! -f "$DIR/$item" ] || cp -p "$DIR/$item" "$archive/$item" || return 1
  done
  cmp -s "$DIR/heal.running" "$archive/heal.running" || return 1
  rm -f "$DIR/heal.running" "$DIR/heal.boot"
}
recover_heal
if [ -f "$DIR/update.managed" ] && [ -f "$DIR/update.running" ] && [ ! -f "$DIR/update.job" ]; then
  mv "$DIR/update.running" "$DIR/update.job"
  log "resume managed update"
fi
loop=0
while true; do
  loop=$((loop + 1))
  if [ $((loop % SLEEP)) -eq 1 ]; then
    [ ! -f /data/local/elfremote/core/launch.sh ] || sh /data/local/elfremote/core/launch.sh
    pid=$(pkg_pid)
    if [ -z "$pid" ]; then
      log "missing; start service"
      start_app
    fi
  fi
  if [ "$(getprop sys.boot_completed)" = 1 ]; then run_heal; run_update; fi
  if [ $((loop % (STATS_EVERY * SLEEP))) -eq 0 ]; then
    pid=$(pkg_pid)
    echo "ts=$(date +%s) wd_rss_kb=$(rss_kb $$) app_rss_kb=$(rss_kb $pid) app_pid=$pid wd_pid=$$" > "$STATS"
  fi
  rmdir "$DIR/starting.d" 2>/dev/null
  sleep 1
done
