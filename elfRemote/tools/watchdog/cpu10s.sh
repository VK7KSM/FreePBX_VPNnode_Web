#!/system/bin/sh
export PATH=/system/bin:/system/xbin:/sbin:/vendor/bin:$PATH
wp=$(cat /data/local/elfremote/watchdog.pid 2>/dev/null)
ap=$(pidof net.elfradio.elfremote 2>/dev/null)
set -- $ap
ap=$1
hz=$(getconf CLK_TCK 2>/dev/null || echo 100)
read_t() {
  set -- $(cat /proc/$1/stat 2>/dev/null)
  echo $(($14 + $15))
}
rss_of() {
  while IFS= read line; do
    case "$line" in
      VmRSS:*) set -- $line; echo "$2"; return ;;
    esac
  done < /proc/$1/status
  echo 0
}
wt1=$(read_t $wp)
at1=$(read_t $ap)
sleep 10
wt2=$(read_t $wp)
at2=$(read_t $ap)
echo hz=$hz wd_pid=$wp app_pid=$ap wd_dt=$((wt2-wt1)) app_dt=$((at2-at1))
echo wd_VmRSS_kb=$(rss_of $wp)
echo app_VmRSS_kb=$(rss_of $ap)
echo LOADAVG
cat /proc/loadavg
