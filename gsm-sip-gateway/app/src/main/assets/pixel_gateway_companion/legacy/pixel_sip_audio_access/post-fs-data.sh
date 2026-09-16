#!/system/bin/sh

MODDIR=${0%/*}
MAGISKPOLICY=/data/adb/magisk/magiskpolicy

if [ ! -x "$MAGISKPOLICY" ]; then
    MAGISKPOLICY=$(command -v magiskpolicy)
fi

if [ -n "$MAGISKPOLICY" ] && [ -f "$MODDIR/sepolicy.rule" ]; then
    "$MAGISKPOLICY" --live --apply "$MODDIR/sepolicy.rule"
fi

