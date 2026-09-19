#!/system/bin/sh
# Independent Magisk late-start launcher for elfRemote only.
export PATH=/system/bin:/system/xbin:/sbin:/vendor/bin:$PATH
export ELFREMOTE_WD_DAEMON=1
exec /system/bin/sh /data/local/elfremote/watchdog.sh --foreground
