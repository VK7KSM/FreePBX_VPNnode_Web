# elfRadio SIP/VPN Manage（Cloudflare Worker）

这是 `https://v.elfradio.net` 正在运行的管理面板源码。Worker 名称：`freepbx-vpnnode-web`。

原先仓库里的 Sub-Store 已停用并整仓替换为本面板。

## 功能

- 代理节点管理、Mihomo / v2rayNG 订阅
- SIP 管理：分机在线状态、登录 IP、归属地、延时、通话记录
- 大阪 SIP 机 CPU / 内存 / 磁盘 / 网络心跳监控
- Pixel3 GSM-SIP 网关：公网手机经 SIM 转入内部分机，内部分机经通话组出口打出公网

节点列表、分机目录和密码存在 Cloudflare KV（`SUB_STORE_KV`），不在 Git 里。改代码再推送不会丢掉 KV 数据。

面板保存分机后，大阪机心跳约 5 秒会拉取配置并写入 Asterisk（密码、外呼/短信、网关、呼叫转移）。传输方式以话机当前注册为准，不能在面板里指定。

## GSM-SIP 网关

源码在 [`gsm-sip-gateway/`](gsm-sip-gateway/)。安装包在 [Releases](https://github.com/VK7KSM/FreePBX_VPNnode_Web/releases)，当前为 **1.4.1**（`GSM-SIP-Gateway-1.4.1.apk`）。

当前生产机是 Pixel 3 XL，以账号 **300**、TLS `sip.elfradio.net:5061` 注册。外呼是否允许、走哪台网关，只看面板里的通话组和分机「外呼」开关；网关不再单独维护一份分机白名单。GSM 呼入转到哪个分机，以面板网关账户的「呼入/短信转发」为准。

从 1.4.1 起，104 等组内允许外呼的分机可以直接拨公网号码，经 300 打出。详细安装、编译和回退见 [网关说明](gsm-sip-gateway/README.md)。

## 自动部署

向 `master` 推送后，GitHub Actions 会执行 `wrangler deploy`，更新线上 Worker。

需要仓库 Secrets：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

## 本地发布

```bash
npx wrangler deploy
```
