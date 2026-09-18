# SIP 服务器（大阪 Asterisk）可部署备份

这个目录是 **elfRadio 电话系统服务端**的完整可部署备份。它不是文档示例，而是当前生产机上正在运行的那份配置和脚本，按下面的步骤可以在一台空白 Ubuntu 上还原出一台等效的 SIP 服务器。

## 它在整个系统里是什么角色

```
D31 座机 / D22 对讲机 / 手机 Linphone / Pixel3 网关
        │  SIP over TLS 5061，RTP 10000–20000
        ▼
   大阪 Asterisk（本目录）  ←──拉配置/报状态──→  https://v.elfradio.net/sip 管理面板
        │                                          （Cloudflare Worker + KV，代码在仓库根目录）
        └── 经 Pixel3 网关 300 进出 GSM 电话与短信
```

- **分机之间**打电话、发短信、视频，全部由这台 Asterisk 中继（`direct_media=no`），不走点对点。
- **面板是唯一的配置来源**。分机、密码、通话组、外呼开关、呼入/短信转发都存在 Cloudflare KV 里；本机的 `sip-statusd` 每 30 秒拉一次，变化时由 `sip-heartbeat.py` 写进 Asterisk 配置文件。
- **面板上的运行状态**（CPU、内存、磁盘、网卡、在线分机、通话记录、封禁列表）也由本机 `sip-statusd` 通过 Cloudflare Tunnel 提供给面板，面板本身不登录这台机器。

## 一键部署

目标系统：Ubuntu 24.04，公网 IPv4，安全组放行 TCP 22、TCP 5061、UDP 10000–20000。2026-09-17 起明文 5060 不再对公网放行，全部终端走 TLS 5061。

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

## 不进 Git 的东西

分机密码、心跳 token、TLS 私钥、Cloudflare Tunnel token 都不在这里，由 `sip-server/.gitignore` 挡住。`pjsip.auth.conf` 里是占位密码 `CHANGE_ME`，真实密码只存在面板 KV，首次同步后由本机脚本写入。

`pjsip.endpoint.conf` 的 `callerid` 显示名在本备份中统一写成 `Ext <分机号>` 占位。这是公开仓库，不放真实使用者姓名；面板首次下发配置时会按面板里的设备名覆盖，不影响部署。

## 这份备份已经包含的行为

- 只改通话组、外呼开关、呼入转发时，只改 Asterisk 路由库，**不执行 `pjsip reload`**，不会把 101 和网关 300 一起踢下线。
- 只有加/删分机、改密码、改 SIP 账号文件时才重载 PJSIP。
- 网关 300 不跑 OPTIONS；面板按是否有注册联系人判断网关在线。
- 只放行 TCP 22、TLS 5061 与 RTP 10000–20000；明文 5060 不对公网开放（Asterisk 仍监听，但被防火墙挡住）。
- Fail2Ban 看守 5060/5061 的连接尝试；`IGNOREIP` 里的地址永不封。封禁状态由 `sip_bans.py` 汇总给面板，面板可手动解封，细节见 `封禁管理交接.md`。
- 短信在目标分机离线时写入本机 SQLite 队列（`sms-queue.py`），目标上线后自动补投。
- Asterisk 使用 `openssl-compat.cnf`（允许 TLS 1.0），D31 才能注册。
- 拨号：内网分机互打看通话组；公网外呼看「组有出口 + 分机允许外呼」。网关呼入电话走 `SIP/gwin`，入站短信走 `SIP/gwsms`，两者必须指向同一通话组。

## 分机模板的既定取值（2026-09-18 确认）

`sip-heartbeat.py` 里 `template_endpoint` 生成新分机时使用的取值，以 101–109、201–203 这批已实测可用的分机为准：

| 项 | 取值 | 说明 |
|---|---|---|
| `allow` | `ulaw,alaw,gsm,g726,g722,h264,vp8` | 网关 300 例外，只有 `ulaw,alaw,g722` |
| `max_video_streams` | `1` | |
| `rtp_keepalive` | `0` | |
| `direct_media` | `no` | 媒体必须经服务器中继 |
| `rtp_symmetric` / `rewrite_contact` / `force_rport` | `yes` | NAT 环境必需 |
| `use_avpf` | `no` | 开启会拒绝 D31 的 `RTP/AVP` 提议，导致 D31 打不出电话 |

2026-09-17 曾有一次未经验证的模板改动（去 vp8、`max_video_streams=4`、`rtp_keepalive=2`），已于 2026-09-18 全部回退，并把当时按新模板创建的分机 204、205 拉回上表取值。D31 视频画面冻结的真因是 D31 客户端不发关键帧请求，在设备侧解决，与这些服务端取值无关。

## 目录

| 路径 | 作用 |
|---|---|
| `install.sh` | 一键安装 |
| `secrets.example` | 复制为 `secrets.env` |
| `files/usr/local/sbin/sip-heartbeat.py` | 把面板配置写成 Asterisk 配置（含只改组不重载） |
| `files/usr/local/sbin/sip-statusd.py` | 每 30 秒拉面板配置、在 `127.0.0.1:8080` 提供本机状态 |
| `files/usr/local/sbin/sip_bans.py` | 汇总 Fail2Ban 封禁状态供面板显示与解封 |
| `files/usr/local/sbin/sms-queue.py` | 离线短信队列（SQLite），上线后补投 |
| `files/etc/asterisk/` | PJSIP、拨号方案、RTP、日志、CDR 配置 |
| `files/etc/asterisk/pjsip.auth.conf` | 仅占位密码 `CHANGE_ME`，以面板同步为准 |
| `files/etc/fail2ban/`、`files/etc/iptables/` | 防护规则。`rules.v4` 是按生产机同步的基线，已去掉 fail2ban 的自建链、跳转规则和历史封禁条目，这些由 fail2ban 启动时自行重建，不应带到新机 |
| `files/etc/sysctl.d/99-bbr.conf` | 开启 BBR |
| `files/etc/systemd/system/` | `sip-statusd`、`sip-heartbeat` 服务与定时器 |
| `test_sip_bans.py`、`test_sms_queue.py` | 封禁汇总与短信队列的单元测试 |
| `封禁管理交接.md` | 封禁管理的设计与交接说明 |

## 和 Web 面板的关系

推送 `sip-server/` **不会**重载 Cloudflare Worker，面板代码在仓库根目录（`worker.js`、`sip-client.js` 等）。分机密码只存在 KV，不在这份备份里。改动本目录前后都应与生产机逐字节核对，不要把未上线的试验值提交进来。
