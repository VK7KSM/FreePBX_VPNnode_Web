#!/system/bin/sh

MODDIR=${0%/*}
LOG=/data/adb/pixel-charge-bypass.log
CONFIG=/data/adb/pixel-charge-bypass.conf

BAT=/sys/class/power_supply/battery
USB=/sys/class/power_supply/usb
PC=/sys/class/power_supply/pc_port
FG=/sys/class/power_supply/maxfg

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"
}

read_config() {
  HIGH=70
  LOW=65
  if [ -f "$CONFIG" ]; then
    . "$CONFIG"
  fi

  case "$HIGH" in ''|*[!0-9]*) HIGH=70 ;; esac
  case "$LOW" in ''|*[!0-9]*) LOW=65 ;; esac
  if [ "$HIGH" -le "$LOW" ] || [ "$HIGH" -gt 100 ]; then
    HIGH=70
    LOW=65
  fi
}

power_online() {
  [ "$(cat "$USB/online" 2>/dev/null)" = 1 ] ||
    [ "$(cat "$PC/online" 2>/dev/null)" = 1 ]
}

recover_charger() {
  log "recover: resetting input_suspend and rerunning AICL"
  echo 0 > "$BAT/charge_disable"
  echo 1 > "$BAT/input_suspend"
  sleep 2
  echo 0 > "$BAT/input_suspend"
  sleep 1
  echo 1 > "$BAT/rerun_aicl"
  sleep 5

  if power_online; then
    log "recover: external power online restored"
    return 0
  fi

  log "ERROR: USB remains offline after recovery"
  return 1
}

enable_adb_tcp() {
  # ADB remains RSA-authenticated (ro.adb.secure=1); this only restores the
  # legacy LAN listener after a reboot, on a predictable port.
  resetprop persist.adb.tcp.port 5555
  resetprop service.adb.tcp.port 5555
  stop adbd
  start adbd
  log "ADB TCP listener requested on port 5555"
}

# Android and the power-supply driver are not ready when Magisk first starts modules.
until [ -r "$FG/capacity" ] && [ -w "$BAT/charge_disable" ] && [ -r "$USB/present" ]; do
  sleep 5
done

sleep 10
enable_adb_tcp
echo 0 > "$BAT/charge_disable"
STATE=charging
BYPASS_BLOCKED=0
RECOVERY_BLOCKED=0
log "service started"

while true; do
  read_config
  # Pixel's Health HAL and status bar use the Maxim MAXFG gauge. The separate
  # Qualcomm battery/bms capacity can differ by more than 10 percentage points.
  CAPACITY=$(cat "$FG/capacity")
  PRESENT=$(cat "$USB/present")
  power_online && ONLINE=1 || ONLINE=0
  DISABLED=$(cat "$BAT/charge_disable")

  if [ "$PRESENT" != 1 ]; then
    if [ "$DISABLED" != 0 ]; then
      echo 0 > "$BAT/charge_disable"
      log "charger removed: bypass cleared"
    fi
    STATE=charging
    BYPASS_BLOCKED=0
    RECOVERY_BLOCKED=0
    sleep 15
    continue
  fi

  if [ "$ONLINE" != 1 ]; then
    [ "$STATE" = bypass ] && BYPASS_BLOCKED=1
    if [ "$RECOVERY_BLOCKED" = 0 ]; then
      recover_charger || RECOVERY_BLOCKED=1
    fi
    STATE=charging
    CAPACITY=$(cat "$FG/capacity")
    DISABLED=$(cat "$BAT/charge_disable")
    power_online && ONLINE=1 || ONLINE=0
    if [ "$ONLINE" != 1 ]; then
      sleep 30
      continue
    fi
  fi
  RECOVERY_BLOCKED=0

  if [ "$STATE" = bypass ] && [ "$DISABLED" != 1 ]; then
    STATE=charging
  fi

  if [ "$CAPACITY" -le "$LOW" ]; then
    BYPASS_BLOCKED=0
  fi

  if [ "$CAPACITY" -ge "$HIGH" ] && [ "$STATE" != bypass ] && [ "$BYPASS_BLOCKED" = 0 ]; then
    echo 1 > "$BAT/charge_disable"
    sleep 3
    if power_online && [ "$(cat "$BAT/charge_disable")" = 1 ]; then
      STATE=bypass
      log "bypass enabled at ${CAPACITY}%"
    else
      log "bypass verification failed at ${CAPACITY}%"
      recover_charger
      STATE=charging
      BYPASS_BLOCKED=1
    fi
  elif [ "$CAPACITY" -le "$LOW" ] && { [ "$STATE" = bypass ] || [ "$DISABLED" != 0 ]; }; then
    echo 0 > "$BAT/charge_disable"
    sleep 3
    if ! power_online; then
      recover_charger
    fi
    STATE=charging
    log "charging enabled at ${CAPACITY}%"
  fi

  sleep 15
done
