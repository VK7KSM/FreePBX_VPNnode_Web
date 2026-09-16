#!/system/bin/sh

STATE=$3
until [ "$(getprop sys.boot_completed)" = 1 ]; do sleep 5; done

# The listener remains protected by Android RSA authentication.
resetprop persist.adb.tcp.port 5555
resetprop service.adb.tcp.port 5555
stop adbd
start adbd
date +%s > "$STATE/adb_ok"
