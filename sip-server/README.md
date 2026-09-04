# SIP 服务器（大阪 Asterisk）

这是当前生产机的可部署备份。新机器按下面做完，面板里的通话组、外呼开关、网关 300、以及「只改组不重载整机 SIP」都会生效。

**不进 Git 的东西：** 分机密码、心跳 token、TLS 私钥、Cloudflare Tunnel token。密码在面板 KV 里，第一次保存后由本机脚本写入 Asterisk。

## 一键部署

目标系统：Ubuntu 24.04，公网 IPv4，安全组放行 TCP 22、TCP/UDP 5060、TCP 5061、UDP 10000–20000。

```bash
git clone git@github.com:VK7KSM/FreePBX_VPNnode_Web.git
cd FreePBX_VPNnode_Web/sip-server
cp secrets.example secrets.env
# 填 SIP_DOMAIN、PUBLIC_IP、HEARTBEAT_TOKEN、证书路径
sudo bash install.sh
```

然后：

1. 把 `${SIP_DOMAIN}` 的 A 记录指到这台机器的公网 IP。
2. 证书放到 `secrets.env` 里写的路径（Let's Encrypt 或已有 pem）。
3. 若面板状态要从本机读：Cloudflare Tunnel 指到 `127.0.0.1:8080`，token 放 `/etc/cloudflared/token`（本脚本不写这个文件）。
4. 打开 https://v.elfradio.net/sip 保存一次配置。最多约 30 秒，本机会拉到分机密码和通话组。

`sip-statusd` 负责拉配置和给面板提供状态。`sip-heartbeat.timer` 默认关掉，不必开。

## 这次备份已经包含的行为

- 只改通话组、外呼开关、呼入转发时，只改 Asterisk 路由库，**不执行 `pjsip reload`**，不会把 101 和网关 300 一起踢下线。
- 只有加/删分机、改密码、改 SIP 账号文件时才重载 PJSIP。
- 网关 300 不跑 OPTIONS；面板按是否有注册联系人判断网关在线。
- Fail2Ban 看守 5060/5061；`IGNOREIP` 里的地址永不封。
- Asterisk 使用 `openssl-compat.cnf`（允许 TLS 1.0），D31 才能注册。
- 拨号：内网分机互打看通话组；公网外呼看「组有出口 + 分机允许外呼」。网关呼入电话走 `SIP/gwin`，入站短信走 `SIP/gwsms`，两者必须指向同一通话组。

## 目录

| 路径 | 作用 |
|---|---|
| `install.sh` | 一键安装 |
| `secrets.example` | 复制为 `secrets.env` |
| `files/usr/local/sbin/sip-heartbeat.py` | 写 Asterisk 配置（含只改组不重载） |
| `files/usr/local/sbin/sip-statusd.py` | 每 30 秒拉面板、提供本机状态 |
| `files/etc/asterisk/` | PJSIP / 拨号 / RTP / 日志 |
| `files/etc/asterisk/pjsip.auth.conf` | 仅占位密码 `CHANGE_ME`，以面板同步为准 |

## 和 Web 面板的关系

推送 `sip-server/` **不会**重载 Cloudflare Worker。面板代码仍在仓库根目录的 `worker.js`。分机密码只存在 KV，不在这份备份里。
