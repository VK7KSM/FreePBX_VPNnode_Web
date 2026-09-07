#!/bin/sh
set -eu
source_dir=/etc/letsencrypt/live/mqtt.elfradio.net
target=/etc/mosquitto/elfremote
[ "${RENEWED_LINEAGE:-$source_dir}" = "$source_dir" ] || exit 0
install -o root -g mosquitto -m 0640 "$source_dir/fullchain.pem" "$target/fullchain.pem.new"
install -o root -g mosquitto -m 0640 "$source_dir/privkey.pem" "$target/privkey.pem.new"
mv "$target/fullchain.pem.new" "$target/fullchain.pem"
mv "$target/privkey.pem.new" "$target/privkey.pem"
if systemctl is-active --quiet mosquitto; then
    systemctl reload mosquitto
fi
