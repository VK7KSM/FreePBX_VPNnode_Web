#!/system/bin/sh
export PATH=/system/bin:/system/xbin:/sbin:/vendor/bin:$PATH
echo MEMINFO
while IFS= read line; do
  case "$line" in
    MemTotal:*|MemFree:*|MemAvailable:*|Buffers:*|Cached:*) echo "$line" ;;
  esac
done < /proc/meminfo
echo LOADAVG
cat /proc/loadavg
echo PROCS
echo elfremote_pid=$(pidof net.elfradio.elfremote 2>/dev/null)
echo loudtalks_pid=$(pidof com.loudtalks 2>/dev/null)
lp=$(pidof org.linphone.debug 2>/dev/null)
[ -n "$lp" ] || lp=$(pidof org.linphone 2>/dev/null)
echo linphone_pid=$lp
echo wd_pid=$(cat /data/local/elfremote/watchdog.pid 2>/dev/null)
echo INIT
echo codex_zello_kiosk=$(getprop init.svc.codex_zello_kiosk)
echo codex_call_ui_guard=$(getprop init.svc.codex_call_ui_guard)
echo codex_wake_keys=$(getprop init.svc.codex_wake_keys)
echo elfremote_wd=$(getprop init.svc.elfremote_wd)
echo PKG
dumpsys package net.elfradio.elfremote 2>/dev/null | grep -e versionName= -e versionCode= -e codePath=
echo RSS
for p in $(pidof net.elfradio.elfremote 2>/dev/null) $(cat /data/local/elfremote/watchdog.pid 2>/dev/null); do
  if [ -d /proc/$p ]; then
    rss=0
    while IFS= read line; do
      case "$line" in
        VmRSS:*) set -- $line; rss=$2 ;;
      esac
    done < /proc/$p/status
    echo pid=$p comm=$(cat /proc/$p/comm 2>/dev/null) VmRSS_kb=$rss
  fi
done
echo FILES
ls -l /data/local/elfremote 2>/dev/null
ls -l /data/adb/service.d/elfremote_watchdog.sh 2>/dev/null
ls -l /system/etc/init/elfremote.rc 2>/dev/null
echo CODEX_HASH
sha256sum /system/etc/init/codex_d22.rc /system/etc/codex/codex_zello_kiosk_d22.sh /system/etc/codex/codex_call_ui_guard_d22.sh /system/etc/codex/codex_d22_wake_keys.sh 2>/dev/null
echo STATS
cat /data/local/elfremote/watchdog.stats 2>/dev/null
echo LOG_TAIL
tail -n 20 /data/local/elfremote/watchdog.log 2>/dev/null
echo FOCUS
dumpsys window windows 2>/dev/null | grep mCurrentFocus | head -n 1
