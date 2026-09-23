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
  iptables-persistent netfilter-persistent curl ca-certificates certbot

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
# certbot standalone 用 HTTP-01 续签，签发与续签的那几十秒需要 80 可达；平时没有程序监听它。
ensure_rule -p tcp -m state --state NEW --dport 80 -j ACCEPT
ensure_rule -p udp --dport 10000:20000 -j ACCEPT
netfilter-persistent save || true

sysctl --system >/dev/null || true
chown -R asterisk:asterisk /etc/asterisk
chmod 750 /etc/asterisk/keys
touch /var/lib/sip-panel/applied_rev /var/lib/sip-panel/apply_error
echo 0 > /var/lib/sip-panel/applied_rev

# 证书自动续签。部署钩子必须把证书装成 pjsip.transports.conf 实际引用的文件名，
# 不能照搬 certbot 的 fullchain.pem / privkey.pem——那样续签会「成功」但 pjsip 仍读旧文件，
# 到期照样断线，而且全程没有任何报错。
install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
install -m 755 -o root -g root "$FILES/etc/letsencrypt/renewal-hooks/deploy/elfremote-sip" \n  /etc/letsencrypt/renewal-hooks/deploy/elfremote-sip
sed -i "s/sip.elfradio.net/${SIP_DOMAIN}/g" /etc/letsencrypt/renewal-hooks/deploy/elfremote-sip

systemctl daemon-reload
systemctl enable --now asterisk fail2ban sip-statusd.service certbot.timer
# sip-heartbeat.timer 是死单元：sip-statusd.py 直接 import 心跳模块自带节拍，
# 这个 timer 从未启用过，留着只会让人以为心跳靠它。
systemctl disable --now sip-heartbeat.timer >/dev/null 2>&1 || true
rm -f /etc/systemd/system/sip-heartbeat.timer   # 旧机器上残留的也一并清掉
systemctl restart asterisk fail2ban sip-statusd.service

echo
echo "安装完成。"
echo "1. 云厂商安全组放行：TCP 22、TCP 80（证书续签用）、TCP/UDP 5060、TCP 5061、UDP 10000-20000"
echo "2. DNS：${SIP_DOMAIN} A 记录指向 ${PUBLIC_IP}"
echo "3. 面板保存一次 SIP 配置，大阪会在 30 秒内拉取密码和通话组（只改组不会重载整机 SIP）"
echo "4. Cloudflare Tunnel（api.elfradio.net -> 127.0.0.1:8080）请单独放入 /etc/cloudflared/token，本脚本不写隧道密钥"
echo "5. 当前 pjsip.auth.conf 里是占位密码，必须等面板同步后分机才能注册"
echo "6. 首次签发证书（要先完成第 1 条的 TCP 80 放行）："
echo "     certbot certonly --standalone -d ${SIP_DOMAIN} --key-type rsa --rsa-key-size 4096 \\"
echo "       --agree-tos --register-unsafely-without-email -n"
echo "   必须用 RSA：certbot 默认的 ECDSA 会让只支持 RSA 套件的老终端（D31）握手失败掉线，而 --dry-run 发现不了。"
echo "   注意 certonly 不执行部署钩子，证书只落在 /etc/letsencrypt，Asterisk 仍读旧文件。"
echo "   再执行一次真实续签把它装进 /etc/asterisk/keys/ 并重载 PJSIP："
echo "     certbot renew --cert-name ${SIP_DOMAIN} --force-renewal -n"
echo "   无终端时 renew 会先随机等待 1～480 秒，属正常。"
echo "   之后用 certbot renew --dry-run 确认续签路径；certbot.timer 负责到期前自动续签。"
