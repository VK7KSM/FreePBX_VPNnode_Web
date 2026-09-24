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

`sip-statusd` 负责拉配置和给面板提供状态，是本机唯一需要常驻的服务。

`/etc/sip-heartbeat.token` 名字里虽带 heartbeat，**实际是 `sip-statusd` 拉 `/api/sip/pull` 的认证凭据**（请求头 `X-Heartbeat-Token`）。不能照名字当成废弃物删掉或吊销，否则本机拉不到配置，分机密码与通话组变更都下发不下去。

## 不进 Git 的东西

分机密码、心跳 token、TLS 私钥、Cloudflare Tunnel token 都不在这里，由 `sip-server/.gitignore` 挡住。`pjsip.auth.conf` 里是占位密码 `CHANGE_ME`，真实密码只存在面板 KV，首次同步后由本机脚本写入。

`pjsip.endpoint.conf` 的 `callerid` 显示名在本备份中统一写成 `Ext <分机号>` 占位。这是公开仓库，不放真实使用者姓名；面板首次下发配置时会按面板里的设备名覆盖，不影响部署。

## 这份备份已经包含的行为

- 只改通话组、外呼开关、呼入转发时，只改 Asterisk 路由库，**不执行 `pjsip reload`**，不会把 101 和网关 300 一起踢下线。
- 只有加/删分机、改密码、改 SIP 账号文件时才重载 PJSIP。
- 网关 300 不跑 OPTIONS；面板按是否有注册联系人判断网关在线。
- 只放行 TCP 22、TCP 80（证书续签）、TLS 5061 与 RTP 10000–20000；明文 5060 不对公网开放（Asterisk 仍监听，但被防火墙挡住）。
- Fail2Ban 看守 5060/5061 的连接尝试；`IGNOREIP` 里的地址永不封。封禁状态由 `sip_bans.py` 汇总给面板，面板可手动解封；SIP 页「防火墙」卡片显示运行状态、规则、SIP 端口、白名单和每个被封 IP，并可按 IP 解封（`POST /api/sip/firewall`），细节见 `封禁管理交接.md`。
- 短信在目标分机离线时写入本机 SQLite 队列（`sms-queue.py`），目标上线后自动补投。
- Asterisk 使用 `openssl-compat.cnf`（允许 TLS 1.0），D31 才能注册。
- 拨号：内网分机互打看通话组；公网外呼看「组有出口 + 分机允许外呼」。网关呼入电话走 `SIP/gwin`，入站短信走 `SIP/gwsms`，两者必须指向同一通话组。

## TLS 证书自动续签

`sip.elfradio.net` 的证书由 Let's Encrypt 签发，`pjsip.transports.conf` 的 `transport-tls`（0.0.0.0:5061）直接引用它。证书一过期，**所有终端的 TLS 注册立刻全断**。

续签走 **certbot standalone（HTTP-01）**，与 MQTT 机 oracle1 同一套。没有选 DNS-01 是因为影响范围：这台机对公网暴露 5061 且跑 Asterisk，一旦被攻破，落在它上面的 Cloudflare DNS 令牌意味着整个 `elfradio.net` 的 DNS 编辑权（可给任意子域签证书、把面板指走）；HTTP-01 最坏只是多一个开放的 80 端口，平时没有任何程序监听它，只有 certbot 在签发/续签的那几十秒临时占用。

| 组件 | 位置 |
|---|---|
| 证书本体 | `/etc/letsencrypt/live/sip.elfradio.net/` |
| 部署钩子 | `/etc/letsencrypt/renewal-hooks/deploy/elfremote-sip` |
| 定时续签 | `certbot.timer`（apt 装 certbot 时自动启用） |
| Asterisk 实际读取 | `/etc/asterisk/keys/sip.elfradio.net-fullchain.crt` 与 `sip.elfradio.net.key` |

**钩子有两处不能照抄 oracle1，抄错会静默失败：**

一是文件名。oracle1 直接用 certbot 的 `fullchain.pem` / `privkey.pem`，这台机不行——`pjsip.transports.conf` 引用的是上表那两个名字。照抄的话续签会「成功」、certbot 一切正常，但 PJSIP 仍读旧文件，到期照样断，**全程没有任何报错**。

二是属主与权限。oracle1 是 `root:mosquitto 0640`；这台机的 Asterisk 以 `asterisk` 身份运行，所以装成 `asterisk:asterisk`，证书 0600、私钥 0640，与原有文件一致。

钩子先写 `.new` 再 `mv`，避免 Asterisk 读到写了一半的文件；最后 `asterisk -rx "module reload res_pjsip.so"`。重载后 5061 对**新连接**发出新证书，已建立的 TLS 连接不会被断开，终端下次重连时自然换上新证书（2026-09-23 实测：6 个注册全程在线，外部新握手拿到的已是新序列号）。

**`certonly` 不执行目录里的部署钩子，只有 `renew` 执行。** 这一点容易想当然：2026-09-23 首次 `certonly` 成功后，`/etc/asterisk/keys/` 的文件时间与序列号都没变，证书只落在 certbot 自己的目录里，Asterisk 仍读旧证书。certbot 源码中目录钩子只在续签路径 `hooks.py` 的 `renew_hook` 里调用。所以首次签发后要走一次真实续签路径把证书装进去，这同时也验证了将来定时续签能否装上：

**密钥类型必须是 RSA 4096，不能用 certbot 的默认值。** certbot 2.x 默认签 ECDSA，而现有证书是 RSA 4096，接入的终端里有靠 `openssl-compat.cnf` 放行 TLS 1.0 才能注册的老设备（D31），未必支持 ECDHE-ECDSA 套件。按默认签发、换上 ECDSA 证书，这类设备会 TLS 握手失败、注册掉线。要注意的是 `--dry-run` **发现不了这个问题**：它只验证 Let's Encrypt 能否从公网连进来，不验证客户端兼容性，用 ECDSA 演练照样显示成功。`--key-type` 会写进 `renewal/sip.elfradio.net.conf`，之后续签沿用 RSA。

不填账号邮箱：Let's Encrypt 自 2025 年 6 月起不再发到期提醒邮件，填了没有作用。续签失败可以从面板 SIP 页的 5061 状态看到。

首次签发（云安全组必须先放行 TCP 80，**源端口留空、目的端口 80**，两栏填反的话规则无效）：

```bash
certbot certonly --standalone -d sip.elfradio.net --key-type rsa --rsa-key-size 4096   --agree-tos --register-unsafely-without-email -n
# certonly 不跑部署钩子，用真实续签路径装进 Asterisk（会重载 PJSIP）：
certbot renew --cert-name sip.elfradio.net --force-renewal -n
certbot renew --dry-run
```

`renew` 在没有终端的环境下（ssh 不带 `-t`、systemd 定时器）会先**随机等待 1～480 秒**再续签，日志里是 `Non-interactive renewal: random delay of N seconds`。这是 certbot 为分散服务器负载的正常行为，不是卡住；手工执行时用 `ssh -t` 分配终端即可跳过。

验收不要只看文件：要从外部新建一次握手，确认 5061 实际发出的序列号与 `/etc/letsencrypt/live/` 一致：

```bash
echo | openssl s_client -connect sip.elfradio.net:5061 -servername sip.elfradio.net 2>/dev/null   | openssl x509 -noout -serial -enddate
```

`--dry-run` 不能只看它说没说成功，要确认钩子真的跑了、`/etc/asterisk/keys/` 里的文件时间变了、`pjsip show transports` 仍有 `transport-tls`。

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
| `files/usr/local/sbin/sip-heartbeat.py` | 把面板配置写成 Asterisk 配置（含只改组不重载）。**只作为库被 `sip-statusd` 导入**（`apply_config` / `write_rev` / `write_err`），直接运行会报错退出 |
| `files/usr/local/sbin/sip-statusd.py` | 每 30 秒拉面板配置、在 `127.0.0.1:8080` 提供本机状态 |
| `files/usr/local/sbin/sip_bans.py` | 汇总 Fail2Ban 封禁状态供面板显示与解封 |
| `files/usr/local/sbin/sip_parse.py` | 解析 `pjsip show contacts`（用注册库完整 URI 判定传输方式）、Fail2Ban 封禁时间与白名单、iptables SIP 端口 |
| `files/usr/local/sbin/sms-queue.py` | 离线短信队列（SQLite），上线后补投 |
| `files/etc/asterisk/` | PJSIP、拨号方案、RTP、日志、CDR 配置 |
| `files/etc/asterisk/pjsip.auth.conf` | 仅占位密码 `CHANGE_ME`，以面板同步为准 |
| `files/etc/fail2ban/`、`files/etc/iptables/` | 防护规则。`rules.v4` 是按生产机同步的基线，已去掉 fail2ban 的自建链、跳转规则和历史封禁条目，这些由 fail2ban 启动时自行重建，不应带到新机 |
| `files/etc/sysctl.d/99-bbr.conf` | 开启 BBR |
| `files/etc/systemd/system/` | 只有 `sip-statusd` 服务与 Asterisk 的 drop-in。2026-09-23 删除了 `sip-heartbeat.timer` 与 `sip-heartbeat.service`：它们触发的 `POST /api/sip/heartbeat` 最后一次运行在 2026-09-02，面板那个接口只验令牌、不写任何状态（面板在线状态来自 `/api/sip/live`，由 Worker 经隧道读本机），服务端已标为废弃 |
| `files/etc/letsencrypt/renewal-hooks/deploy/elfremote-sip` | 证书续签后装进 Asterisk 并重载 PJSIP 的钩子 |
| `test_sip_bans.py`、`test_sms_queue.py` | 封禁汇总与短信队列的单元测试 |
| `封禁管理交接.md` | 封禁管理的设计与交接说明 |

## 和 Web 面板的关系

推送 `sip-server/` **不会**重载 Cloudflare Worker，面板代码在仓库根目录（`worker.js`、`sip-client.js` 等）。分机密码只存在 KV，不在这份备份里。改动本目录前后都应与生产机逐字节核对，不要把未上线的试验值提交进来。
