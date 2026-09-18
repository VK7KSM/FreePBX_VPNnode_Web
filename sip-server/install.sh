#!/bin/bash
# 在新的 Ubuntu 24.04 SIP 机上以 root 运行：
#   cd sip-server && cp secrets.example secrets.env && $EDITOR secrets.env && bash install.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
FILES="$HERE/files"
SECRETS="$HERE/secrets.env"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "请用 root 运行：sudo bash install.sh"
  exit 1
fi
if [[ ! -f "$SECRETS" ]]; then
  echo "请先复制 secrets.example 为 secrets.env 并填好"
  exit 1
fi
# shellcheck disable=SC1090
source "$SECRETS"
: "${SIP_DOMAIN:?}" "${PUBLIC_IP:?}" "${HEARTBEAT_TOKEN:?}" "${IGNOREIP:?}"
: "${CERT_FULLCHAIN:?}" "${CERT_KEY:?}"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y asterisk asterisk-modules fail2ban python3 \
  iptables-persistent netfilter-persistent curl ca-certificates

install -d -m 755 /usr/local/sbin /etc/asterisk/keys \
  /etc/systemd/system/asterisk.service.d /var/lib/sip-panel \
  /etc/fail2ban/jail.d /etc/sysctl.d

install -m 755 "$FILES/usr/local/sbin/sip-heartbeat.py" /usr/local/sbin/sip-heartbeat.py
install -m 755 "$FILES/usr/local/sbin/sip-statusd.py" /usr/local/sbin/sip-statusd.py
install -m 755 "$FILES/usr/local/sbin/sms-queue.py" /usr/local/sbin/sms-queue.py
install -d -m 755 /usr/share/asterisk/agi-bin /var/lib/asterisk/agi-bin
ln -sfn /usr/local/sbin/sms-queue.py /usr/share/asterisk/agi-bin/sms-queue.agi
ln -sfn /usr/local/sbin/sms-queue.py /var/lib/asterisk/agi-bin/sms-queue.agi
touch /var/lib/sip-panel/sms_queue.sqlite
chown asterisk:asterisk /var/lib/sip-panel/sms_queue.sqlite
chmod 660 /var/lib/sip-panel/sms_queue.sqlite
chgrp asterisk /var/lib/sip-panel 2>/dev/null || true
chmod 775 /var/lib/sip-panel 2>/dev/null || true
install -m 644 "$FILES/etc/systemd/system/sip-statusd.service" /etc/systemd/system/sip-statusd.service
install -m 644 "$FILES/etc/systemd/system/sip-heartbeat.service" /etc/systemd/system/sip-heartbeat.service
install -m 644 "$FILES/etc/systemd/system/sip-heartbeat.timer" /etc/systemd/system/sip-heartbeat.timer
install -m 644 "$FILES/etc/systemd/system/asterisk.service.d/openssl-compat.conf" \
  /etc/systemd/system/asterisk.service.d/openssl-compat.conf
install -m 644 "$FILES/etc/fail2ban/jail.d/asterisk.local" /etc/fail2ban/jail.d/asterisk.local
install -m 644 "$FILES/etc/sysctl.d/99-bbr.conf" /etc/sysctl.d/99-bbr.conf

printf '%s\n' '[DEFAULT]' "ignoreip = ${IGNOREIP}" > /etc/fail2ban/jail.d/99-ignoreip.local
printf '%s' "$HEARTBEAT_TOKEN" > /etc/sip-heartbeat.token
chmod 600 /etc/sip-heartbeat.token

for f in pjsip.conf pjsip.aor.conf pjsip.auth.conf pjsip.endpoint.conf \
  pjsip.transports.conf extensions.conf freepbx-pixel-sms.conf \
  freepbx-pixel-callerid.conf modules.conf rtp.conf logger.conf http.conf \
  openssl-compat.cnf pjproject.conf cdr.conf cdr_custom.conf; do
  src="$FILES/etc/asterisk/$f"
  if [[ -f "$src" ]]; then
    install -m 640 -o asterisk -g asterisk "$src" "/etc/asterisk/$f"
  fi
done

sed -i "s/217.142.229.125/${PUBLIC_IP}/g" /etc/asterisk/pjsip.transports.conf
sed -i "s/sip.elfradio.net/${SIP_DOMAIN}/g" /etc/asterisk/pjsip.transports.conf
sed -i "s#/etc/asterisk/keys/sip.elfradio.net-fullchain.crt#${CERT_FULLCHAIN}#g" /etc/asterisk/pjsip.transports.conf
sed -i "s#/etc/asterisk/keys/sip.elfradio.net.key#${CERT_KEY}#g" /etc/asterisk/pjsip.transports.conf

if [[ -f "$CERT_FULLCHAIN" && -f "$CERT_KEY" ]]; then
  install -m 640 -o asterisk -g asterisk "$CERT_FULLCHAIN" /etc/asterisk/keys/sip.elfradio.net-fullchain.crt
  install -m 640 -o asterisk -g asterisk "$CERT_KEY" /etc/asterisk/keys/sip.elfradio.net.key
  echo "已安装 TLS 证书到 /etc/asterisk/keys/"
else
  echo "警告：证书文件还不存在。把 ${SIP_DOMAIN} 的 fullchain 和 key 放到："
  echo "  $CERT_FULLCHAIN"
  echo "  $CERT_KEY"
  echo "然后再执行：systemctl restart asterisk"
fi

ensure_rule() {
  iptables -C INPUT "$@" 2>/dev/null || iptables -I INPUT 1 "$@"
}
ensure_rule -p tcp -m state --state NEW --dport 22 -j ACCEPT
ensure_rule -p udp --dport 5060 -j ACCEPT
ensure_rule -p tcp -m state --state NEW --dport 5060 -j ACCEPT
ensure_rule -p tcp -m state --state NEW --dport 5061 -j ACCEPT
ensure_rule -p udp --dport 10000:20000 -j ACCEPT
netfilter-persistent save || true

sysctl --system >/dev/null || true
chown -R asterisk:asterisk /etc/asterisk
chmod 750 /etc/asterisk/keys
touch /var/lib/sip-panel/applied_rev /var/lib/sip-panel/apply_error
echo 0 > /var/lib/sip-panel/applied_rev

systemctl daemon-reload
systemctl enable --now asterisk fail2ban sip-statusd.service
systemctl disable sip-heartbeat.timer >/dev/null 2>&1 || true
systemctl restart asterisk fail2ban sip-statusd.service

echo
echo "安装完成。"
echo "1. 云厂商安全组放行：TCP 22、TCP/UDP 5060、TCP 5061、UDP 10000-20000"
echo "2. DNS：${SIP_DOMAIN} A 记录指向 ${PUBLIC_IP}"
echo "3. 面板保存一次 SIP 配置，大阪会在 30 秒内拉取密码和通话组（只改组不会重载整机 SIP）"
echo "4. Cloudflare Tunnel（api.elfradio.net -> 127.0.0.1:8080）请单独放入 /etc/cloudflared/token，本脚本不写隧道密钥"
echo "5. 当前 pjsip.auth.conf 里是占位密码，必须等面板同步后分机才能注册"
