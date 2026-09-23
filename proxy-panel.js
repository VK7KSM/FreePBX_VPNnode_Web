// 代理面板：订阅生成与节点池页面。
// 2026-09-20 从 worker.js 整体搬出来单独成模块，只有 worker-proxy.js（s.elfradio.net 的入口）
// 会 import 它。管理面板 v.elfradio.net 的入口是 worker.js 本身，打包时根本不会走到这个文件，
// 所以 v 的产物里一个代理协议字段都不会出现——靠运行时判断做不到这一点，代码仍然留在包里。
import { getStore, setStore, json, registerProxyPanel, changeAdminPassword } from './worker.js';
import { cfUsageStyle, cfUsageMarkup } from './cf-usage-client.js';
import { adminRpc } from './admin-auth.js';
import { panelEnabled, panelWrite, kvJson } from './panel-kv.js';
// 节点字段白名单。以前 nodes 原样存、原样拼进 YAML：名字里一个双引号或换行就让整份订阅
// 解析失败，所有客户端同时断线——自己手滑的后果。现在只收这几个字段、每个都有形状。
const NODE_FIELDS = ['name', 'type', 'server', 'port', 'uuid', 'sni', 'path', 'custom_ip'];
const HOST_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateNodes(value) {
  if (!Array.isArray(value)) throw Error('节点列表格式无效');
  if (value.length > 64) throw Error('节点数量超出上限');
  const out = [], names = new Set();
  for (const node of value) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw Error('节点条目格式无效');
    for (const key of Object.keys(node)) if (!NODE_FIELDS.includes(key)) throw Error('节点字段不认识：' + key);
    const name = String(node.name || '').trim();
    if (!name || name.length > 48 || /[\r\n"'\\]/.test(name)) throw Error('节点名称无效（1–48 字，不能含引号、反斜杠或换行）');
    if (names.has(name)) throw Error('节点名称重复：' + name);
    names.add(name);
    const server = String(node.server || '').trim().toLowerCase();
    if (!HOST_RE.test(server) && !IP_RE.test(server)) throw Error('节点服务器地址无效：' + name);
    const port = node.port === undefined || node.port === '' ? 443 : Number(node.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('节点端口无效：' + name);
    const uuid = String(node.uuid || '').trim();
    if (!UUID_RE.test(uuid)) throw Error('节点 UUID 无效：' + name);
    const sni = node.sni === undefined || node.sni === '' ? '' : String(node.sni).trim().toLowerCase();
    if (sni && !HOST_RE.test(sni)) throw Error('节点 SNI 无效：' + name);
    const path = node.path === undefined || node.path === '' ? '/' : String(node.path).trim();
    if (!/^\/[!-~]{0,255}$/.test(path) || /["'\\]/.test(path)) throw Error('节点路径无效：' + name);
    const customIp = node.custom_ip === undefined || node.custom_ip === '' ? '' : String(node.custom_ip).trim();
    if (customIp && !IP_RE.test(customIp)) throw Error('节点自定义 IP 无效：' + name);
    const type = node.type === undefined || node.type === '' ? 'vless' : String(node.type);
    if (type !== 'vless') throw Error('节点类型只支持 vless：' + name);
    out.push({ name, type, server, port, uuid, ...(sni ? { sni } : {}), path, ...(customIp ? { custom_ip: customIp } : {}) });
  }
  return out;
}
// YAML 里的字符串一律用 JSON 引号：JSON 字符串是合法的 YAML 双引号标量，
// 该转义的都转义了，不靠「名字里没有引号」这种假设。
const y = v => JSON.stringify(String(v));

const DEFAULT_USER = "admin";
const DEFAULT_TOKEN = "d31";

// 管理面板的 brandHtml() 留在 worker.js，这边自带一份，省得为了一行标题再引一次。
function proxyBrandHtml() {
  return [
    '<a href="/" style="display:flex;align-items:center;gap:.55rem;text-decoration:none;color:inherit">',
    '<img src="/logo.png" alt="elfRemote" width="36" height="36" style="width:36px;height:36px;border-radius:.55rem;object-fit:cover;flex-shrink:0">',
    '<span style="font-weight:700;font-size:1.05rem;white-space:nowrap">elfRemote Manager</span>',
    '</a>'
  ].join("");
}

function b64EncodeUnicode(str) {
  return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, function(match, p1) {
    return String.fromCharCode('0x' + p1);
  }));
}

export async function handleSubscription(request, url, env) {
  const token = url.searchParams.get("token") || url.pathname.split("/").pop();
  const configuredToken = (await getStore(env, "sub_token")) || DEFAULT_TOKEN;
  if (token !== configuredToken) {
    return new Response("Unauthorized", { status: 401 });
  }

  const nodes = (await getStore(env, "nodes")) || [];
  const globalCfIp = (await getStore(env, "cf_preferred_ip")) || "104.16.80.80";

  // 格式识别：支持 ?type=v2ray 或 ?type=clash，或通过 User-Agent 智能自适应
  const reqType = (url.searchParams.get("type") || url.searchParams.get("format") || "").toLowerCase();
  const ua = (request.headers.get("User-Agent") || "").toLowerCase();

  let isV2ray = false;
  if (reqType === "v2ray" || reqType === "base64") {
    isV2ray = true;
  } else if (reqType === "clash" || reqType === "mihomo") {
    isV2ray = false;
  } else if (ua.includes("v2rayng") || ua.includes("v2rayn") || ua.includes("nekobox") || ua.includes("shadowrocket")) {
    isV2ray = true;
  }

  // 1. v2rayNG / 通用 Base64 格式
  if (isV2ray) {
    let links = [];
    for (const node of nodes) {
      const srv = node.custom_ip || globalCfIp || node.server;
      const sni = node.sni || node.server;
      const path = node.path || "/";
      const port = node.port || 443;
      const link = "vless://" + node.uuid + "@" + srv + ":" + port +
        "?encryption=none&security=tls&type=ws" +
        "&host=" + encodeURIComponent(sni) +
        "&sni=" + encodeURIComponent(sni) +
        "&path=" + encodeURIComponent(path) +
        "#" + encodeURIComponent(node.name);
      links.push(link);
    }
    const rawText = links.join("\n");
    const base64Content = b64EncodeUnicode(rawText);
    return new Response(base64Content, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache",
        "Profile-Update-Interval": "1"
      }
    });
  }

  // 2. Clash / Mihomo YAML 格式 (默认给 D31 座机)
  let proxiesYaml = "";
  let proxyNames = "";

  for (const node of nodes) {
    const srv = node.custom_ip || globalCfIp || node.server;
    proxyNames += "      - " + y(node.name) + "\n";
    proxiesYaml +=
      "  - name: " + y(node.name) + "\n" +
      "    type: " + y(node.type || "vless") + "\n" +
      "    server: " + y(srv) + "\n" +
      "    port: " + (Number(node.port) || 443) + "\n" +
      "    uuid: " + y(node.uuid) + "\n" +
      "    network: ws\n" +
      "    tls: true\n" +
      "    udp: true\n" +
      "    servername: " + y(node.sni || node.server) + "\n" +
      "    ws-opts:\n" +
      "      path: " + y(node.path || "/") + "\n" +
      "      headers:\n" +
      "        Host: " + y(node.sni || node.server) + "\n\n";
  }

  const yaml =
    "# D31 FreePBX 代理订阅 - " + new Date().toISOString() + "\n" +
    "mixed-port: 7890\nallow-lan: true\nmode: rule\nlog-level: warning\nipv6: false\n\n" +
    "tun:\n  enable: true\n  stack: gvisor\n  dns-hijack:\n    - \"any:53\"\n  auto-route: true\n  auto-detect-interface: true\n\n" +
    "proxies:\n" + (proxiesYaml || "  []\n") +
    "proxy-groups:\n" +
    "  - name: \"PROXY-MODE\"\n    type: select\n    proxies:\n      - \"AUTO-FASTEST\"\n      - \"DIRECT\"\n" + proxyNames +
    "  - name: \"AUTO-FASTEST\"\n    type: url-test\n    proxies:\n      - \"DIRECT\"\n" + proxyNames +
    "    url: 'http://cp.cloudflare.com/generate_204'\n    interval: 60\n    tolerance: 15\n\n" +
    "rules:\n" +
    "  - DOMAIN-SUFFIX,telegram.org,PROXY-MODE\n" +
    "  - DOMAIN-SUFFIX,t.me,PROXY-MODE\n" +
    "  - IP-CIDR,91.108.4.0/22,PROXY-MODE\n" +
    "  - IP-CIDR,149.154.160.0/20,PROXY-MODE\n" +
    "  - GEOIP,lan,DIRECT\n" +
    "  - IP-CIDR,192.168.0.0/16,DIRECT\n" +
    "  - IP-CIDR,10.0.0.0/8,DIRECT\n" +
    "  - MATCH,PROXY-MODE\n";

  return new Response(yaml, {
    headers: {
      "Content-Type": "text/yaml; charset=utf-8",
      "Content-Disposition": "attachment; filename=\"d31_sub.yaml\"",
      "Cache-Control": "no-cache",
      "Profile-Update-Interval": "1"
    }
  });
}

export function renderHtml() {
  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta name="elf-panel-version" content="__ELF_PANEL_VERSION__"><script src="/panel-lifecycle.js" defer><\/script><script src="/cf-usage.js" defer><\/script>',
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<title>elfRemote Manager</title>',
    '<link rel="icon" type="image/png" href="/logo.png">',
    '<script src="https://cdn.tailwindcss.com"><\/script>',
    '<style>',
    cfUsageStyle,
    'body{background:#0f172a;color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
    '.card{background:rgba(30,41,59,.7);border:1px solid rgba(255,255,255,.1);backdrop-filter:blur(12px)}',
    '.inp{width:100%;padding:.6rem .9rem;border-radius:.5rem;background:#0f172a;border:1px solid #334155;color:#fff;outline:none;box-sizing:border-box}',
    '.inp:focus{border-color:#3b82f6}',
    '.btn-blue{padding:.55rem 1.1rem;background:#2563eb;color:#fff;border-radius:.5rem;cursor:pointer;font-weight:600;border:none;font-size:.85rem;white-space:nowrap}',
    '.btn-blue:hover{background:#1d4ed8}',
    '.btn-purple{padding:.55rem 1.1rem;background:#7c3aed;color:#fff;border-radius:.5rem;cursor:pointer;font-weight:600;border:none;font-size:.85rem;white-space:nowrap}',
    '.btn-purple:hover{background:#6d28d9}',
    '.btn-green{padding:.5rem 1rem;background:#059669;color:#fff;border-radius:.5rem;cursor:pointer;font-weight:600;border:none;font-size:.8rem}',
    '.btn-green:hover{background:#047857}',
    '.btn-gray{padding:.4rem .8rem;background:#334155;color:#cbd5e1;border-radius:.5rem;cursor:pointer;border:none;font-size:.8rem}',
    '.btn-gray:hover{background:#475569}',
    '.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;z-index:50}',
    'table{width:100%;border-collapse:collapse}',
    'th{text-align:left;padding:.7rem 1rem;font-size:.75rem;color:#94a3b8;background:rgba(15,23,42,.6);white-space:nowrap}',
    'td{padding:.7rem 1rem;font-size:.85rem;border-top:1px solid #1e293b}',
    'tr:hover td{background:rgba(30,41,59,.5)}',
    '<\/style>',
    '<\/head>',
    '<body>',

    // 登录模态框
    '<div id="loginWrap" class="modal-bg">',
    '<div class="card" style="padding:2rem;border-radius:1rem;width:100%;max-width:420px">',
    '<div style="text-align:center;margin-bottom:1.5rem">',
    '<img src="/logo.png" alt="elfRemote" width="64" height="64" style="width:64px;height:64px;border-radius:.8rem;object-fit:cover;margin-bottom:.6rem">',
    '<h2 style="font-size:1.3rem;font-weight:700">elfRemote Manager</h2>',
    '<p style="font-size:.8rem;color:#94a3b8;margin-top:.3rem">代理面板<\/p>',
    '<\/div>',
    '<div style="margin-bottom:1rem">',
    '<label style="display:block;font-size:.8rem;color:#cbd5e1;margin-bottom:.3rem">账号<\/label>',
    '<input id="lu" type="text" autocomplete="username" class="inp">',
    '<\/div>',
    '<div style="margin-bottom:1.2rem">',
    '<label style="display:block;font-size:.8rem;color:#cbd5e1;margin-bottom:.3rem">密码<\/label>',
    '<input id="lp" type="password" autocomplete="current-password" class="inp">',
    '<\/div>',
    '<button class="btn-blue" style="width:100%;padding:.7rem" onclick="doLogin()">登 录<\/button>',
    '<p id="lerr" style="color:#f87171;font-size:.8rem;margin-top:.6rem;text-align:center;display:none"><\/p>',
    '<\/div>',
    '<\/div>',

    // 主导航
    '<header style="border-bottom:1px solid #1e293b;background:rgba(15,23,42,.8);position:sticky;top:0;z-index:30;padding:0 1.5rem">',
    '<div style="max-width:1100px;margin:0 auto;height:4rem;display:flex;align-items:center;justify-content:space-between">',
    '<div style="display:flex;align-items:center;gap:.8rem;flex-wrap:wrap">',
    proxyBrandHtml(),
    '<span style="font-size:.7rem;padding:.2rem .5rem;border-radius:.3rem;background:rgba(16,185,129,.15);color:#34d399">Serverless<\/span>',
    '<a href="/" style="margin-left:.6rem;padding:.35rem .7rem;border-radius:.4rem;background:#1e3a5f;color:#93c5fd;text-decoration:none;font-size:.85rem;font-weight:600">代理节点<\/a>',
    // 代理面板独立部署在 s.elfradio.net，这两个后台不在那个域名上（那边只放行代理面板与订阅），
    // 所以用绝对地址指回 v.elfradio.net。同一份 HTML 在 v 上也是这两个链接，同源跳转照常。
    '<a href="https://v.elfradio.net/sip" style="padding:.35rem .7rem;border-radius:.4rem;color:#cbd5e1;text-decoration:none;font-size:.85rem;font-weight:600">电话管理<\/a>',
    '<a href="https://v.elfradio.net/devices" style="padding:.35rem .7rem;border-radius:.4rem;color:#cbd5e1;text-decoration:none;font-size:.85rem;font-weight:600">设备管理<\/a>',
    '<\/div>',
    '<div style="display:flex;gap:.6rem">',
    '<button class="btn-gray" onclick="openSettings()">&#9881; 全局设置<\/button>',
    cfUsageMarkup,
    '<button class="btn-gray" style="color:#f87171" onclick="logout()">退出<\/button>',
    '<\/div>',
    '<\/div>',
    '<\/header>',

    // 订阅卡片 (分别独立显示两个格式的输入框和专属复制按钮)
    '<main style="max-width:1100px;margin:2rem auto;padding:0 1.5rem;display:flex;flex-direction:column;gap:1.5rem">',
    '<div class="card" style="padding:1.5rem;border-radius:1rem">',
    '<div style="display:flex;flex-direction:column;gap:1.2rem">',
    '<div>',
    '<h3 style="font-weight:700;font-size:1.1rem;margin-bottom:.3rem">&#128225; 订阅中心 (分格式专属链接)<\/h3>',
    '<p style="font-size:.8rem;color:#64748b">根据不同设备与客户端类型，直接复制对应的专用订阅链接<\/p>',
    '<\/div>',

    // 1. Mihomo / Clash 专属卡片
    '<div style="background:rgba(15,23,42,.6);padding:1rem 1.2rem;border-radius:.8rem;border:1px solid rgba(59,130,246,.25)">',
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.6rem;flex-wrap:wrap;gap:.4rem">',
    '<div style="display:flex;align-items:center;gap:.5rem">',
    '<span style="font-size:.9rem;font-weight:600;color:#60a5fa">&#128752; Mihomo / Clash 订阅源<\/span>',
    '<span style="font-size:.75rem;color:#94a3b8">（专供 D31 智能座机 / TUN 全局透明代理）<\/span>',
    '<\/div>',
    '<span style="font-size:.7rem;padding:.15rem .5rem;border-radius:.3rem;background:rgba(59,130,246,.15);color:#93c5fd;font-weight:600">YAML 格式<\/span>',
    '<\/div>',
    '<div style="display:flex;gap:.6rem;align-items:center">',
    '<input id="clashUrl" type="text" readonly class="inp" style="flex:1;font-size:.8rem;font-family:monospace;color:#93c5fd">',
    '<button class="btn-blue" onclick="copyMihomo()">复制 Mihomo 订阅<\/button>',
    '<\/div>',
    '<\/div>',

    // 2. v2rayNG 专属卡片
    '<div style="background:rgba(15,23,42,.6);padding:1rem 1.2rem;border-radius:.8rem;border:1px solid rgba(124,58,237,.25)">',
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.6rem;flex-wrap:wrap;gap:.4rem">',
    '<div style="display:flex;align-items:center;gap:.5rem">',
    '<span style="font-size:.9rem;font-weight:600;color:#c084fc">&#128640; v2rayNG / 通用 订阅源<\/span>',
    '<span style="font-size:.75rem;color:#94a3b8">（专供 手机 Android / 电脑 v2rayN 客户端）<\/span>',
    '<\/div>',
    '<span style="font-size:.7rem;padding:.15rem .5rem;border-radius:.3rem;background:rgba(124,58,237,.15);color:#d8b4fe;font-weight:600">Base64 VLESS<\/span>',
    '<\/div>',
    '<div style="display:flex;gap:.6rem;align-items:center">',
    '<input id="v2rayUrl" type="text" readonly class="inp" style="flex:1;font-size:.8rem;font-family:monospace;color:#d8b4fe">',
    '<button class="btn-purple" onclick="copyV2ray()">复制 v2rayNG 订阅<\/button>',
    '<\/div>',
    '<\/div>',

    '<\/div>',
    '<\/div>',

    // 节点管理卡片
    '<div class="card" style="padding:1.5rem;border-radius:1rem">',
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.2rem;padding-bottom:1rem;border-bottom:1px solid #1e293b">',
    '<div>',
    '<h3 style="font-weight:700;margin-bottom:.3rem">&#128257; 代理服务器节点池<\/h3>',
    '<p style="font-size:.8rem;color:#64748b">管理甲骨文 VPS 节点及 3 个月轮换的 GCP 节点<\/p>',
    '<\/div>',
    '<button class="btn-green" onclick="openAdd()">+ 添加新节点<\/button>',
    '<\/div>',
    '<div style="overflow-x:auto">',
    '<table>',
    '<thead><tr>',
    '<th>节点名称<\/th><th>协议/端口<\/th><th>服务器域名 (SNI)<\/th><th>WS 路径<\/th><th>优选 IP<\/th><th style="text-align:right">操作<\/th>',
    '<\/tr><\/thead>',
    '<tbody id="ntb"><tr><td colspan="6" style="text-align:center;color:#475569;padding:2rem">暂无节点，点击右上角添加<\/td><\/tr><\/tbody>',
    '<\/table>',
    '<\/div>',
    '<\/div>',
    '<\/main>',

    // 节点编辑模态框
    '<div id="nodeWrap" class="modal-bg" style="display:none">',
    '<div class="card" style="padding:1.5rem;border-radius:1rem;width:100%;max-width:500px;max-height:90vh;overflow-y:auto">',
    '<h3 id="nodeTitle" style="font-weight:700;margin-bottom:1rem">添加节点<\/h3>',
    '<div style="display:flex;flex-direction:column;gap:.8rem;font-size:.85rem">',
    '<div><label style="display:block;color:#cbd5e1;margin-bottom:.3rem">节点名称<\/label><input id="nName" type="text" placeholder="如: Oracle-Osaka-Tunnel" class="inp"><\/div>',
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:.6rem">',
    '<div><label style="display:block;color:#cbd5e1;margin-bottom:.3rem">服务器域名<\/label><input id="nServer" type="text" placeholder="stream.elfradio.net" class="inp"><\/div>',
    '<div><label style="display:block;color:#cbd5e1;margin-bottom:.3rem">端口<\/label><input id="nPort" type="number" value="443" class="inp"><\/div>',
    '<\/div>',
    '<div><label style="display:block;color:#cbd5e1;margin-bottom:.3rem">UUID<\/label><input id="nUuid" type="text" placeholder="11111111-2222-3333-4444-555555555555" class="inp" style="font-family:monospace"><\/div>',
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:.6rem">',
    '<div><label style="display:block;color:#cbd5e1;margin-bottom:.3rem">WebSocket 路径<\/label><input id="nPath" type="text" value="/stream-proxy" class="inp"><\/div>',
    '<div><label style="display:block;color:#cbd5e1;margin-bottom:.3rem">SNI 域名<\/label><input id="nSni" type="text" placeholder="stream.elfradio.net" class="inp"><\/div>',
    '<\/div>',
    '<div><label style="display:block;color:#cbd5e1;margin-bottom:.3rem">独立 CF 优选 IP（留空则继承全局）<\/label><input id="nIp" type="text" placeholder="172.64.32.1" class="inp"><\/div>',
    '<\/div>',
    '<div style="display:flex;justify-content:flex-end;gap:.5rem;margin-top:1.2rem">',
    '<button class="btn-gray" onclick="closeNode()">取消<\/button>',
    '<button class="btn-green" onclick="saveNode()">保存节点<\/button>',
    '<\/div>',
    '<\/div>',
    '<\/div>',

    // 设置模态框
    '<div id="setWrap" class="modal-bg" style="display:none">',
    '<div class="card" style="padding:1.5rem;border-radius:1rem;width:100%;max-width:420px">',
    '<h3 style="font-weight:700;margin-bottom:1rem">全局设置<\/h3>',
    '<div style="display:flex;flex-direction:column;gap:.8rem;font-size:.85rem">',
    '<div><label style="display:block;color:#cbd5e1;margin-bottom:.3rem">全局 CF 优选 IP<\/label><input id="sCfIp" type="text" class="inp"><\/div>',
    '<div><label style="display:block;color:#cbd5e1;margin-bottom:.3rem">订阅 Token<\/label><input id="sToken" type="text" class="inp" style="font-family:monospace"><\/div>',
    '<div style="border-top:1px solid #1e293b;padding-top:.8rem"><label style="display:block;color:#cbd5e1;margin-bottom:.3rem">修改管理密码（留空不修改；代理、电话、设备三个面板共用这一个账号）<\/label>',
    '<input id="sCur" type="password" placeholder="当前密码" autocomplete="current-password" class="inp" style="margin-bottom:.4rem">',
    '<input id="sPass" type="password" placeholder="新密码（至少 12 位）" autocomplete="new-password" class="inp" style="margin-bottom:.4rem">',
    '<input id="sPass2" type="password" placeholder="再输一次新密码" autocomplete="new-password" class="inp"><\/div>',
    '<\/div>',
    '<div style="display:flex;justify-content:flex-end;gap:.5rem;margin-top:1.2rem">',
    '<button class="btn-gray" onclick="closeSettings()">取消<\/button>',
    '<button class="btn-blue" onclick="saveSettings()">保存<\/button>',
    '<\/div>',
    '<\/div>',
    '<\/div>',

    // 核心 JavaScript - 全部用普通函数和 DOM API，零模板字符串
    '<script src="/admin-session.js"><\/script>',
    '<script>',
    'var D = {nodes:[], sub_token:"d31", cf_ip:"", admin_user:""};',
    'var editIdx = -1;',

    'function $(id){return document.getElementById(id)}',
    'function show(id){$(id).style.display="flex"}',
    'function hide(id){$(id).style.display="none"}',

    'function checkAuth(){',
    '  adminSession.check(loadData);',
    '}',

    'function doLogin(){',
    '  var u = $("lu").value, p = $("lp").value;',
    '  $("lerr").style.display="none";',
    '  fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:u,password:p})})',
    '  .then(function(r){return r.json();})',
    '  .then(function(d){',
    '    if(d.ok){ adminSession.accept(); hide("loginWrap"); loadData(); }',
    '    else{ $("lerr").innerText = d.msg||"登录失败"; $("lerr").style.display="block"; }',
    '  })',
    '  .catch(function(e){ $("lerr").innerText="网络错误:"+e.message; $("lerr").style.display="block"; });',
    '}',

    'function logout(){ return adminSession.logout(); }',

    'function loadData(){',
    '  fetch("/api/data").then(function(r){return r.json();}).then(function(d){',
    '    D = d;',
    '    $("clashUrl").value = location.origin+"/sub/"+d.sub_token;',
    '    $("v2rayUrl").value = location.origin+"/sub/"+d.sub_token+"?type=v2ray";',
    '    renderNodes();',
    '  });',
    '}',

    'function renderNodes(){',
    '  var tb = $("ntb");',
    '  if(!D.nodes || D.nodes.length===0){',
    '    tb.innerHTML = "<tr><td colspan=\\"6\\" style=\\"text-align:center;color:#475569;padding:2rem\\">暂无节点，点击右上角添加<\\/td><\\/tr>";',
    '    return;',
    '  }',
    '  var html = "";',
    '  for(var i=0;i<D.nodes.length;i++){',
    '    var n = D.nodes[i];',
    '    var ip = n.custom_ip || D.cf_ip || "全局默认";',
    '    html += "<tr>";',
    '    html += "<td><span style=\\"color:#34d399\\">&#9679;<\\/span> "+n.name+"<\\/td>";',
    '    html += "<td><span style=\\"background:rgba(59,130,246,.2);color:#60a5fa;padding:.1rem .4rem;border-radius:.3rem;font-family:monospace\\">VLESS<\\/span>:"+n.port+"<\\/td>";',
    '    html += "<td style=\\"font-family:monospace;font-size:.8rem\\">"+(n.sni||n.server)+"<\\/td>";',
    '    html += "<td style=\\"font-family:monospace;color:#94a3b8;font-size:.8rem\\">"+n.path+"<\\/td>";',
    '    html += "<td style=\\"color:#fbbf24;font-size:.8rem\\">"+ip+"<\\/td>";',
    '    html += "<td style=\\"text-align:right;white-space:nowrap\\">";',
    '    html += "<button class=\\"btn-purple\\" style=\\"padding:.2rem .5rem;margin-right:.3rem\\" onclick=\\"copySingleLink("+i+")\\">复制单链<\\/button>";',
    '    html += "<button class=\\"btn-gray\\" style=\\"padding:.2rem .5rem;margin-right:.3rem\\" onclick=\\"editNode("+i+")\\">编辑<\\/button>";',
    '    html += "<button class=\\"btn-gray\\" style=\\"padding:.2rem .5rem;color:#f87171\\" onclick=\\"delNode("+i+")\\">删除<\\/button>";',
    '    html += "<\\/td>";',
    '    html += "<\\/tr>";',
    '  }',
    '  tb.innerHTML = html;',
    '}',

    'function openAdd(){ editIdx=-1; $("nodeTitle").innerText="添加新节点"; $("nName").value=""; $("nServer").value=""; $("nPort").value=443; $("nUuid").value=""; $("nPath").value="/stream-proxy"; $("nSni").value=""; $("nIp").value=""; show("nodeWrap"); }',

    'function editNode(i){ editIdx=i; var n=D.nodes[i]; $("nodeTitle").innerText="编辑节点"; $("nName").value=n.name||""; $("nServer").value=n.server||""; $("nPort").value=n.port||443; $("nUuid").value=n.uuid||""; $("nPath").value=n.path||"/stream-proxy"; $("nSni").value=n.sni||""; $("nIp").value=n.custom_ip||""; show("nodeWrap"); }',

    'function closeNode(){ hide("nodeWrap"); }',

    'function saveNode(){',
    '  var n = { name:$("nName").value||"Node-"+(D.nodes.length+1), server:$("nServer").value.trim(), port:parseInt($("nPort").value)||443, uuid:$("nUuid").value.trim(), path:$("nPath").value.trim()||"/stream-proxy", sni:$("nSni").value.trim(), custom_ip:$("nIp").value.trim(), type:"vless", tls:true };',
    '  if(!n.server||!n.uuid){ alert("服务器域名和 UUID 不能为空"); return; }',
    '  if(editIdx>=0){ D.nodes[editIdx]=n; } else { D.nodes.push(n); }',
    '  fetch("/api/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({nodes:D.nodes})});',
    '  closeNode(); renderNodes();',
    '}',

    'function delNode(i){ if(confirm("确认删除该节点？")){ D.nodes.splice(i,1); fetch("/api/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({nodes:D.nodes})}); renderNodes(); } }',

    'function openSettings(){ $("sCfIp").value=D.cf_ip||"104.16.80.80"; $("sToken").value=D.sub_token||"d31"; $("sCur").value=""; $("sPass").value=""; $("sPass2").value=""; show("setWrap"); }',
    'function closeSettings(){ hide("setWrap"); }',

    'function saveSettings(){',
    '  var payload = { cf_ip:$("sCfIp").value, sub_token:$("sToken").value||"d31" };',
    '  var np=$("sPass").value;',
    '  if(np){',
    '    if(!$("sCur").value){ alert("修改密码要先输入当前密码"); return; }',
    '    if(np.length<12){ alert("新密码至少 12 位"); return; }',
    '    if(np!==$("sPass2").value){ alert("两次输入的新密码不一致"); return; }',
    '    payload.current_password=$("sCur").value; payload.new_password=np;',
    '  }',
    // 服务端确认成功后才改本地显示：以前先改 D 再发请求，保存失败时页面显示的订阅地址与服务端不一致。
    '  fetch("/api/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)}).then(function(r){return r.json();}).then(function(d){',
    '    if(!d.ok) throw new Error(d.msg||"保存失败");',
    '    D.cf_ip = payload.cf_ip; D.sub_token = payload.sub_token;',
    '    $("clashUrl").value = location.origin+"/sub/"+D.sub_token;',
    '    $("v2rayUrl").value = location.origin+"/sub/"+D.sub_token+"?type=v2ray";',
    '    closeSettings(); renderNodes();',
    '    if(d.credentials_changed){ alert("密码已修改，三个面板都要用新密码重新登录"); adminSession.expire(); } else alert("设置已保存");',
    '  }).catch(function(e){ alert(e.message); });',
    '}',

    'function copyMihomo(){ var u=$("clashUrl").value; navigator.clipboard.writeText(u).then(function(){ alert("Mihomo / Clash 订阅链接已复制:\\n"+u); }); }',
    'function copyV2ray(){ var u=$("v2rayUrl").value; navigator.clipboard.writeText(u).then(function(){ alert("v2rayNG / 通用 订阅链接已复制:\\n"+u); }); }',

    'function copySingleLink(i){',
    '  var n=D.nodes[i];',
    '  var srv = n.custom_ip || D.cf_ip || n.server;',
    '  var sni = n.sni || n.server;',
    '  var path = n.path || "/";',
    '  var link = "vless://" + n.uuid + "@" + srv + ":" + (n.port||443) + "?encryption=none&security=tls&type=ws&host=" + encodeURIComponent(sni) + "&sni=" + encodeURIComponent(sni) + "&path=" + encodeURIComponent(path) + "#" + encodeURIComponent(n.name);',
    '  navigator.clipboard.writeText(link).then(function(){ alert("VLESS 节点单链已复制，可在 v2rayNG 中点击「+」->「从剪贴板导入」:\\n" + link); });',
    '}',

    // 监听回车键登录
    'document.addEventListener("keydown", function(e){ if(e.key==="Enter" && $("loginWrap").style.display!=="none"){ doLogin(); } });',

    'checkAuth();',
    '<\/script>',
    '<\/body>',
    '<\/html>'
  ].join('\n');
}

// 原先直接写在 worker.js 路由里的 /api/data 与 /api/save，跟着页面一起搬过来。
export async function readSettings(env) {
  const nodes = (await getStore(env, "nodes")) || [];
  const sub_token = (await getStore(env, "sub_token")) || DEFAULT_TOKEN;
  const cf_ip = (await getStore(env, "cf_preferred_ip")) || "104.16.80.80";
  const admin_user = (await getStore(env, "admin_user")) || DEFAULT_USER;
  return json({ ok: true, nodes, sub_token, cf_ip, admin_user });
}

export async function saveSettings(env, request) {
  try {
    const data = await request.json();
    let passwordResult;
    if (data.new_password) {
      // 改密码要先证明知道现在的密码：会话被拿到不等于能把主人锁在外面。
      passwordResult = await changeAdminPassword(env, request, data);
      if (!passwordResult.ok) return passwordResult;
    }
    const patch={};if(Array.isArray(data.nodes))patch.nodes=validateNodes(data.nodes);
    if(data.sub_token)patch.sub_token=data.sub_token;
    if(data.cf_ip!==undefined)patch.cf_preferred_ip=data.cf_ip;
    if(Object.keys(patch).length){if(panelEnabled(env))await panelWrite(env,patch);else for(const [key,value] of Object.entries(patch))await setStore(env,key,value);}
    return passwordResult || json({ ok: true });
  } catch(e) {
    return json({ ok: false, msg: e.message }, 400);
  }
}

// 模块一被加载就把自己挂到 worker.js 的路由上；管理面板不加载它，那些路由就是空的。
registerProxyPanel({ handleSubscription, readSettings, saveSettings, renderHtml });
