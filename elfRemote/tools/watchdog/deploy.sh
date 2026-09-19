#!/system/bin/sh
export PATH=/system/bin:/system/xbin:/sbin:/vendor/bin:$PATH
set -e
mount -o remount,rw /system
mkdir -p /system/app/ElfRemote /data/local/elfremote /data/local/tmp
cp /data/local/tmp/ElfRemote.apk /system/app/ElfRemote/ElfRemote.apk
chmod 0644 /system/app/ElfRemote/ElfRemote.apk
chown root:root /system/app/ElfRemote/ElfRemote.apk
cp /data/local/tmp/elfremote_watchdog.sh /data/local/elfremote/watchdog.sh
chmod 0755 /data/local/elfremote/watchdog.sh
if [ -d /data/adb/service.d ]; then
  cp /data/local/tmp/elfremote_magisk.sh /data/adb/service.d/elfremote_watchdog.sh
  chmod 0755 /data/adb/service.d/elfremote_watchdog.sh
fi
cp /data/local/tmp/elfremote.rc /system/etc/init/elfremote.rc
chmod 0644 /system/etc/init/elfremote.rc
restorecon /system/etc/init/elfremote.rc /system/app/ElfRemote/ElfRemote.apk 2>/dev/null || true
mount -o remount,ro /system
echo HASH
sha256sum /system/app/ElfRemote/ElfRemote.apk /data/local/elfremote/watchdog.sh
sha256sum /data/adb/service.d/elfremote_watchdog.sh /system/etc/init/elfremote.rc 2>/dev/null || true
echo CODEX_UNCHANGED
sha256sum /system/etc/init/codex_d22.rc /system/etc/codex/codex_zello_kiosk_d22.sh
old=$(cat /data/local/elfremote/watchdog.pid 2>/dev/null)
if [ -n "$old" ]; then kill "$old" 2>/dev/null || true; sleep 1; fi
stop elfremote_wd 2>/dev/null || true
sleep 1
rm -rf /data/local/elfremote/lock.d /data/local/elfremote/starting.d
start elfremote_wd 2>/dev/null || /system/bin/sh /data/local/elfremote/watchdog.sh
sleep 1
echo wd_pid=$(cat /data/local/elfremote/watchdog.pid 2>/dev/null)
am start-foreground-service --user 0 -n net.elfradio.elfremote/.ReportService >/dev/null 2>&1 || true
echo deploy_ok
