# elfRadio SIP/VPN Manage（Cloudflare Worker）

这是 `https://v.elfradio.net` 正在运行的管理面板源码。Worker 名称：`freepbx-vpnnode-web`。

原先仓库里的 Sub-Store 已停用并整仓替换为本面板。

## 功能

- 代理节点管理、Mihomo / v2rayNG 订阅
- SIP 管理：分机在线状态、登录 IP、归属地、延时、通话记录
- 大阪 SIP 机 CPU / 内存 / 磁盘 / 网络心跳监控
- Pixel3 GSM-SIP 网关：公网手机经 SIM 转入内部分机，内部分机经通话组出口打出公网

节点列表、分机目录和密码存在 Cloudflare KV（`SUB_STORE_KV`），不在 Git 里。改代码再推送不会丢掉 KV 数据。

面板保存后，大阪机最多约 30 秒拉取配置并写入 Asterisk（密码、外呼/短信、网关、呼叫转移、通话组）。只改通话组时不会重载整机 SIP。传输方式以话机当前注册为准，不能在面板里指定。

## GSM-SIP 网关

源码在 [`gsm-sip-gateway/`](gsm-sip-gateway/)。安装包在 [Releases](https://github.com/VK7KSM/FreePBX_VPNnode_Web/releases)，当前为 **1.4.2**（`GSM-SIP-Gateway-1.4.2.apk`）。

当前生产机是 Pixel 3 XL，以账号 **300**、TLS `sip.elfradio.net:5061` 注册。外呼是否允许、走哪台网关，只看面板里的通话组和分机「外呼」开关；网关不再单独维护一份分机白名单。GSM 呼入电话和短信可以转到同一通话组里的不同分机；以面板网关账户的「呼入转发」「短信转发」为准。

从 1.4.2 起，有短信权限的分机经大阪改写后都可以发 GSM 短信，网关不再要求 From 等于 SIM 目的分机。详细安装、编译和回退见 [网关说明](gsm-sip-gateway/README.md)。

## 设备管理

顶栏第三项。页面：`/devices`。左侧选设备，右侧地图（GPS 准点 / 无 GPS 则 IP 粗圈），下方操作当前选中设备。型号可自行增改删。

远程配置客户端 **elfRemote** 源码在 [`elfRemote/`](elfRemote/)。第一刀在 D22-XX 上做六码配对和心跳；网页绿点表示控制面在线，不是 ADB 已连接。说明见 [elfRemote README](elfRemote/README.md)。

## SIP 服务器

生产 Asterisk 的可部署备份在 [`sip-server/`](sip-server/)。新机器上复制 `secrets.example` 为 `secrets.env`，执行 `sudo bash install.sh`。分机密码、TLS 私钥和 Tunnel token 不进 Git，第一次在面板保存后由机器拉取。说明见 [服务器部署](sip-server/README.md)。

## 自动部署

只有改了面板源码（`worker.js`、`sip-client.js`、`wrangler.toml` 等）推到 `master`，GitHub Actions 才会 `wrangler deploy` 更新线上 Worker。

推送 `sip-server/`、`gsm-sip-gateway/`、`README.md` **不会**重载 Web 面板。

需要仓库 Secrets：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

## 本地发布

```bash
npx wrangler deploy
```
