#!/system/bin/sh
# Independent keeper for elfRemote only.
export PATH=/system/bin:/system/xbin:/sbin:/vendor/bin:$PATH
SCRIPT=/data/local/elfremote/watchdog.sh
PKG=net.elfradio.elfremote
COMP=net.elfradio.elfremote/.ReportService
DIR=/data/local/elfremote
LOCK=/data/local/elfremote/lock.d
PIDF=/data/local/elfremote/watchdog.pid
LOG=/data/local/tmp/elfremote_wd.log
STATS=/data/local/tmp/elfremote_wd.stats
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

mkdir -p "$DIR"
chmod 0777 "$DIR" 2>/dev/null || true
if ! mkdir "$LOCK" 2>/dev/null; then
  old=$(cat "$PIDF" 2>/dev/null)
  if [ -n "$old" ] && [ -d /proc/$old ]; then
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
trap cleanup EXIT INT TERM
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
  mv "$cmdf" "$DIR/heal.running" 2>/dev/null || return
  log "heal run"
  /system/bin/sh "$DIR/heal.running" > "$DIR/heal.out" 2>&1
  echo $? > "$DIR/heal.rc.tmp"
  chmod 0666 "$DIR/heal.out" "$DIR/heal.rc.tmp" 2>/dev/null || true
  mv "$DIR/heal.rc.tmp" "$DIR/heal.rc"
  rm -f "$DIR/heal.running"
}

run_update() {
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
  chmod 0666 "$DIR/updater.apk" "$DIR/update.job.json" 2>/dev/null || true
  /system/bin/sh "$DIR/update.running" > "$DIR/update.out" 2>&1
  upd_rc=$?
  echo $upd_rc > "$DIR/update.rc.tmp"
  chmod 0666 "$DIR/update.out" "$DIR/update.rc.tmp" "$DIR/update.state" 2>/dev/null || true
  mv "$DIR/update.rc.tmp" "$DIR/update.rc"
  if [ $upd_rc -ne 0 ]; then
    log "update retry rc=$upd_rc"
    mv "$DIR/update.running" "$DIR/update.job" 2>/dev/null || true
  else
    rm -f "$DIR/update.running"
  fi
}

log "start pid=$$"
loop=0
while true; do
  run_heal
  run_update
  loop=$((loop + 1))
  if [ $((loop % SLEEP)) -eq 1 ]; then
    pid=$(pkg_pid)
    if [ -z "$pid" ]; then
      log "missing; start service"
      start_app
    fi
  fi
  if [ $((loop % (STATS_EVERY * SLEEP))) -eq 0 ]; then
    pid=$(pkg_pid)
    echo "ts=$(date +%s) wd_rss_kb=$(rss_kb $$) app_rss_kb=$(rss_kb $pid) app_pid=$pid wd_pid=$$" > "$STATS"
  fi
  rmdir "$DIR/starting.d" 2>/dev/null
  sleep 1
done
