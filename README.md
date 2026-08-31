# FreePBX VPN Node Web

Cloudflare Workers & Pages 纯净单文件管理面板与智能订阅生成器。

## 特性
- 纯单文件运行（`_worker.js`），支持 Cloudflare Workers 与 Cloudflare Pages
- 内置账号密码登录认证（默认 `admin` / `admin888`，可在网页端随时一键修改）
- 零环境变量依赖，开箱即用
- 可视化代理节点增删改查（支持 VLESS-WS-TLS）
- Cloudflare 优选 IP 智能注入（支持国内 <100ms / 澳洲 <10ms 加速）
- 专为星网锐捷 D31 (SVP3390) 自动生成 Mihomo (Clash.Meta) YAML 订阅
