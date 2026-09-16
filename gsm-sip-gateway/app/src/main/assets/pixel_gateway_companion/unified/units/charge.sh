#!/system/bin/sh

CONFIG=$2
STATE_DIR=$3
LOG="$STATE_DIR/charge.log"
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
  [ -f "$CONFIG" ] && . "$CONFIG"
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
  power_online
}

until [ -r "$FG/capacity" ] && [ -w "$BAT/charge_disable" ] && [ -r "$USB/present" ]; do
  sleep 5
done

sleep 10
echo 0 > "$BAT/charge_disable"
STATE=charging
BYPASS_BLOCKED=0
RECOVERY_BLOCKED=0
log "service started"

while true; do
  read_config
  [ "$CHARGE_ENABLED" = 1 ] || { echo 0 > "$BAT/charge_disable"; exit 0; }
  CAPACITY=$(cat "$FG/capacity")
  PRESENT=$(cat "$USB/present")
  power_online && ONLINE=1 || ONLINE=0
  DISABLED=$(cat "$BAT/charge_disable")

  if [ "$PRESENT" != 1 ]; then
    [ "$DISABLED" = 0 ] || echo 0 > "$BAT/charge_disable"
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
    power_online && ONLINE=1 || ONLINE=0
    [ "$ONLINE" = 1 ] || { sleep 30; continue; }
  fi
  RECOVERY_BLOCKED=0
  [ "$STATE" != bypass ] || [ "$DISABLED" = 1 ] || STATE=charging
  [ "$CAPACITY" -gt "$LOW" ] || BYPASS_BLOCKED=0

  if [ "$CAPACITY" -ge "$HIGH" ] && [ "$STATE" != bypass ] && [ "$BYPASS_BLOCKED" = 0 ]; then
    echo 1 > "$BAT/charge_disable"
    sleep 3
    if power_online && [ "$(cat "$BAT/charge_disable")" = 1 ]; then
      STATE=bypass
      log "bypass enabled at ${CAPACITY}%"
    else
      recover_charger
      STATE=charging
      BYPASS_BLOCKED=1
    fi
  elif [ "$CAPACITY" -le "$LOW" ] && { [ "$STATE" = bypass ] || [ "$DISABLED" != 0 ]; }; then
    echo 0 > "$BAT/charge_disable"
    sleep 3
    power_online || recover_charger
    STATE=charging
    log "charging enabled at ${CAPACITY}%"
  fi
  date +%s > "$STATE_DIR/charge_ok"
  sleep 15
done
