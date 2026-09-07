#!/bin/sh
set -eu
cd "$(dirname "$0")"
test "$(id -u)" = 0
test ! -e /etc/systemd/system/elfremote-mqtt-api.service
test -f /etc/elfremote-mqtt/credentials.json
python3 -c 'import os,secrets; p="/etc/elfremote-mqtt/api-token"; fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600); os.write(fd,secrets.token_urlsafe(48).encode()); os.close(fd)'
install -m 0755 api.py /usr/local/lib/elfremote-mqtt/api.py
install -m 0644 elfremote-mqtt-api.service /etc/systemd/system/elfremote-mqtt-api.service
systemctl daemon-reload
systemctl enable --now elfremote-mqtt-api
systemctl is-active elfremote-mqtt-api
