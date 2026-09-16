#!/system/bin/sh

MODDIR=${0%/*}
ROOT=/data/adb/elfremote-gateway
CONFIG="$ROOT/companion.conf"
STATE="$ROOT/companion-state"
mkdir -p "$STATE"
[ -f "$CONFIG" ] || cp "$MODDIR/default.conf" "$CONFIG"
. "$CONFIG"

if [ "$(getprop ro.product.device)" != crosshatch ] ||
   [ "$(getprop ro.build.fingerprint)" != "google/crosshatch/crosshatch:12/SP1A.210812.016.B2/8602260:user/release-keys" ]; then
    printf '%s\n' incompatible-device > "$STATE/error"
    exit 1
fi

run_unit() {
    NAME=$1
    "$MODDIR/units/$NAME.sh" "$MODDIR" "$CONFIG" "$STATE" >> "$STATE/$NAME.log" 2>&1 &
    printf '%s\n' "$!" > "$STATE/$NAME.pid"
}

[ "$AUDIO_ENABLED" = 1 ] && run_unit audio
[ "$ADB_TCP_ENABLED" = 1 ] && run_unit adb
[ "$CHARGE_ENABLED" = 1 ] && run_unit charge
date +%s > "$STATE/started_at"
