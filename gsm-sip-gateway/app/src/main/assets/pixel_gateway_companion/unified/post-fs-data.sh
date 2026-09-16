#!/system/bin/sh

MODDIR=${0%/*}
CONFIG=/data/adb/elfremote-gateway/companion.conf
[ -f "$CONFIG" ] || CONFIG="$MODDIR/default.conf"
. "$CONFIG"

[ "$AUDIO_ENABLED" = 1 ] || exit 0
[ "$(getprop ro.product.device)" = crosshatch ] || exit 1
[ "$(getprop ro.build.fingerprint)" = "google/crosshatch/crosshatch:12/SP1A.210812.016.B2/8602260:user/release-keys" ] || exit 1

MAGISKPOLICY=/data/adb/magisk/magiskpolicy
[ -x "$MAGISKPOLICY" ] || MAGISKPOLICY=$(command -v magiskpolicy)
if [ -n "$MAGISKPOLICY" ] && [ -f "$MODDIR/sepolicy.rule" ]; then
    "$MAGISKPOLICY" --live --apply "$MODDIR/sepolicy.rule"
fi
