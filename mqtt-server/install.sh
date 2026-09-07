#!/bin/sh
set -eu
cd "$(dirname "$0")"
test "$(id -u)" = 0
test -f /etc/letsencrypt/live/mqtt.elfradio.net/fullchain.pem
test ! -e /etc/mosquitto/conf.d/elfremote.conf
install -d -o root -g mosquitto -m 0750 /etc/mosquitto/elfremote
install -d -o root -g root -m 0755 /usr/local/lib/elfremote-mqtt
install -m 0755 provision.py /usr/local/lib/elfremote-mqtt/provision.py
install -o root -g mosquitto -m 0640 acl /etc/mosquitto/elfremote/acl
python3 /usr/local/lib/elfremote-mqtt/provision.py control-plane
install -m 0755 renew-certificate.sh /etc/letsencrypt/renewal-hooks/deploy/elfremote-mqtt
/etc/letsencrypt/renewal-hooks/deploy/elfremote-mqtt
install -m 0644 mosquitto.conf /etc/mosquitto/conf.d/elfremote.conf
if ! systemctl restart mosquitto; then
    mv /etc/mosquitto/conf.d/elfremote.conf /etc/mosquitto/elfremote/rejected.conf
    systemctl restart mosquitto
    exit 1
fi
systemctl enable mosquitto certbot.timer
systemctl is-active mosquitto
