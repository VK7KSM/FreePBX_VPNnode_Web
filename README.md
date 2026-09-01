# elfRadio SIP/VPN Manage（Cloudflare Worker）

这是 `https://v.elfradio.net` 正在运行的管理面板源码。Worker 名称：`freepbx-vpnnode-web`。

原先仓库里的 Sub-Store 已停用并整仓替换为本面板。

## 功能

- 代理节点管理、Mihomo / v2rayNG 订阅
- SIP 管理：分机在线状态、登录 IP、归属地、延时、通话记录
- 大阪 SIP 机 CPU / 内存 / 磁盘 / 网络心跳监控

节点列表、分机目录和密码存在 Cloudflare KV（`SUB_STORE_KV`），不在 Git 里。改代码再推送不会丢掉 KV 数据。

面板上的添加、编辑、删除分机只改 KV 里的目录显示，不会写入大阪 SIP 机上的 Asterisk。要让话机真正注册，仍需在 Asterisk 里配置对应分机。

## 自动部署

向 `master` 推送后，GitHub Actions 会执行 `wrangler deploy`，更新线上 Worker。

需要仓库 Secrets：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

## 本地发布

```bash
npx wrangler deploy
```
