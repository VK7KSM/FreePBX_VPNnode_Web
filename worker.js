// =========================================================================
// FreePBX VPN Node Web - Cloudflare Workers 管理面板与订阅生成器 v2.3
// 升级：SIP 管理独立页 + 甲骨文 SIP 机负荷心跳监控
// =========================================================================

const DEFAULT_USER = "admin";
const DEFAULT_PASS = "admin888";
const DEFAULT_TOKEN = "d31";

async function getStore(env, key) {
  if (env && env.SUB_STORE_KV) {
    const val = await env.SUB_STORE_KV.get(key);
    if (val !== null) {
      try { return JSON.parse(val); } catch(e) { return val; }
    }
  }
  const defaults = {
    admin_user: DEFAULT_USER,
    admin_pass: DEFAULT_PASS,
    sub_token: DEFAULT_TOKEN,
    cf_preferred_ip: "104.16.80.80",
    nodes: []
  };
  return defaults[key] !== undefined ? defaults[key] : null;
}

async function setStore(env, key, value) {
  if (env && env.SUB_STORE_KV) {
    await env.SUB_STORE_KV.put(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;

    // 订阅下发 (支持 UA 自动适配与参数指定)
    if (pathname.startsWith("/sub")) {
      return handleSubscription(request, url, env);
    }

    // API 路由
    if (pathname === "/api/login" && method === "POST") {
      try {
        const { username, password } = await request.json();
        const dbUser = (await getStore(env, "admin_user")) || DEFAULT_USER;
        const dbPass = (await getStore(env, "admin_pass")) || DEFAULT_PASS;
        if (username === dbUser && password === dbPass) {
          return json({ ok: true });
        }
        return json({ ok: false, msg: "账号或密码错误" }, 401);
      } catch(e) {
        return json({ ok: false, msg: e.message }, 400);
      }
    }

    if (pathname === "/api/data" && method === "GET") {
      const nodes = (await getStore(env, "nodes")) || [];
      const sub_token = (await getStore(env, "sub_token")) || DEFAULT_TOKEN;
      const cf_ip = (await getStore(env, "cf_preferred_ip")) || "104.16.80.80";
      const admin_user = (await getStore(env, "admin_user")) || DEFAULT_USER;
      return json({ ok: true, nodes, sub_token, cf_ip, admin_user });
    }

    if (pathname === "/api/save" && method === "POST") {
      try {
        const data = await request.json();
        if (Array.isArray(data.nodes)) await setStore(env, "nodes", data.nodes);
        if (data.sub_token) await setStore(env, "sub_token", data.sub_token);
        if (data.cf_ip !== undefined) await setStore(env, "cf_preferred_ip", data.cf_ip);
        if (data.new_password) await setStore(env, "admin_pass", data.new_password);
        return json({ ok: true });
      } catch(e) {
        return json({ ok: false, msg: e.message }, 400);
      }
    }

    if (pathname === "/api/sip" && method === "GET") {
      const extensions = (await getStore(env, "sip_extensions")) || defaultSipExtensions();
      const status = (await getStore(env, "sip_status")) || null;
      const geo = await geoForStatus(env, status);
      return json({ ok: true, extensions, status, geo, stale: isSipStale(status) });
    }

    if (pathname === "/api/sip/save" && method === "POST") {
      try {
        const data = await request.json();
        if (!Array.isArray(data.extensions)) {
          return json({ ok: false, msg: "extensions 必须是数组" }, 400);
        }
        await setStore(env, "sip_extensions", data.extensions);
        return json({ ok: true });
      } catch(e) {
        return json({ ok: false, msg: e.message }, 400);
      }
    }

    if (pathname === "/api/sip/heartbeat" && method === "POST") {
      const token = request.headers.get("X-Heartbeat-Token") || "";
      const expected = (await getStore(env, "sip_heartbeat_token")) || "";
      if (!expected || token !== expected) {
        return json({ ok: false, msg: "heartbeat token 无效" }, 401);
      }
      try {
        const body = await request.json();
        body.received_at = new Date().toISOString();
        const prev = (await getStore(env, "sip_status")) || {};
        const lastSeen = prev.last_seen || {};
        const contacts = body.contacts || [];
        for (let i = 0; i < contacts.length; i++) {
          const c = contacts[i];
          if (c && c.ext) lastSeen[c.ext] = body.received_at;
        }
        body.last_seen = lastSeen;
        await setStore(env, "sip_status", body);
        return json({ ok: true });
      } catch(e) {
        return json({ ok: false, msg: e.message }, 400);
      }
    }

    if (pathname === "/sip" || pathname === "/sip/") {
      return new Response(renderSipHtml(), {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    // 前端 HTML
    return new Response(renderHtml(), {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }
};

function defaultSipExtensions() {
  return [
    { ext: "101", name: "Yealink 1", transport: "udp" },
    { ext: "102", name: "Yealink 2", transport: "udp" },
    { ext: "103", name: "Ricky Song", transport: "tls" },
    { ext: "104", name: "Pixel 5", transport: "tls" },
    { ext: "105", name: "D31-Chengdu", transport: "udp" },
    { ext: "106", name: "iPhone XR", transport: "tls" },
    { ext: "107", name: "JiMaMu", transport: "tls" },
    { ext: "108", name: "Elvin Sydney", transport: "tls" },
    { ext: "201", name: "D22-BB", transport: "udp" },
    { ext: "202", name: "D22-JJ", transport: "udp" },
    { ext: "203", name: "H13", transport: "udp" },
    { ext: "300", name: "Pixel3 GSM Gateway", transport: "tls" }
  ];
}

function isSipStale(status) {
  if (!status || !status.received_at) return true;
  const t = Date.parse(status.received_at);
  if (!t) return true;
  return (Date.now() - t) > 90000;
}

function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip.indexOf("10.") === 0 || ip.indexOf("192.168.") === 0 || ip.indexOf("127.") === 0) return true;
  if (ip.indexOf("172.") === 0) {
    const n = parseInt(ip.split(".")[1], 10);
    return n >= 16 && n <= 31;
  }
  return false;
}

async function geoForStatus(env, status) {
  const geo = {};
  const contacts = (status && status.contacts) || [];
  for (let i = 0; i < contacts.length; i++) {
    const ip = contacts[i] && contacts[i].ip;
    if (!ip || geo[ip]) continue;
    if (isPrivateIp(ip)) {
      geo[ip] = "内网";
      continue;
    }
    const cached = await getStore(env, "geo_" + ip);
    if (cached) {
      geo[ip] = cached;
      continue;
    }
    try {
      const r = await fetch("http://ip-api.com/json/" + encodeURIComponent(ip) + "?lang=zh-CN&fields=status,country,regionName,city");
      const j = await r.json();
      const label = (j && j.status === "success")
        ? [j.country, j.regionName, j.city].filter(Boolean).join(" ")
        : "未知";
      await setStore(env, "geo_" + ip, label);
      geo[ip] = label;
    } catch (e) {
      geo[ip] = "未知";
    }
  }
  return geo;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function b64EncodeUnicode(str) {
  return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, function(match, p1) {
    return String.fromCharCode('0x' + p1);
  }));
}

async function handleSubscription(request, url, env) {
  const token = url.searchParams.get("token") || url.pathname.split("/").pop();
  const configuredToken = (await getStore(env, "sub_token")) || DEFAULT_TOKEN;
  if (token !== configuredToken && token !== "d31") {
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
    proxyNames += "      - \"" + node.name + "\"\n";
    proxiesYaml +=
      "  - name: \"" + node.name + "\"\n" +
      "    type: " + (node.type || "vless") + "\n" +
      "    server: " + srv + "\n" +
      "    port: " + (node.port || 443) + "\n" +
      "    uuid: " + node.uuid + "\n" +
      "    network: ws\n" +
      "    tls: true\n" +
      "    udp: true\n" +
      "    servername: \"" + (node.sni || node.server) + "\"\n" +
      "    ws-opts:\n" +
      "      path: \"" + (node.path || "/") + "\"\n" +
      "      headers:\n" +
      "        Host: \"" + (node.sni || node.server) + "\"\n\n";
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

// ==========================================
// HTML 前端 - 完全避免嵌套模板字符串
// 所有动态 DOM 操作改用字符串拼接
// ==========================================
function renderHtml() {
  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<title>FreePBX VPN Node 管理面板</title>',
    '<script src="https://cdn.tailwindcss.com"><\/script>',
    '<style>',
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
    'th{text-align:left;padding:.7rem 1rem;font-size:.75rem;color:#94a3b8;background:rgba(15,23,42,.6)}',
    'td{padding:.7rem 1rem;font-size:.85rem;border-top:1px solid #1e293b}',
    'tr:hover td{background:rgba(30,41,59,.5)}',
    '<\/style>',
    '<\/head>',
    '<body>',

    // 登录模态框
    '<div id="loginWrap" class="modal-bg">',
    '<div class="card" style="padding:2rem;border-radius:1rem;width:100%;max-width:420px">',
    '<div style="text-align:center;margin-bottom:1.5rem">',
    '<div style="font-size:2rem;margin-bottom:.5rem">&#128225;</div>',
    '<h2 style="font-size:1.3rem;font-weight:700">FreePBX 节点管理中枢</h2>',
    '<p style="font-size:.8rem;color:#94a3b8;margin-top:.3rem">默认账号 admin / admin888</p>',
    '<\/div>',
    '<div style="margin-bottom:1rem">',
    '<label style="display:block;font-size:.8rem;color:#cbd5e1;margin-bottom:.3rem">账号<\/label>',
    '<input id="lu" type="text" value="admin" class="inp">',
    '<\/div>',
    '<div style="margin-bottom:1.2rem">',
    '<label style="display:block;font-size:.8rem;color:#cbd5e1;margin-bottom:.3rem">密码<\/label>',
    '<input id="lp" type="password" value="admin888" class="inp">',
    '<\/div>',
    '<button class="btn-blue" style="width:100%;padding:.7rem" onclick="doLogin()">登 录<\/button>',
    '<p id="lerr" style="color:#f87171;font-size:.8rem;margin-top:.6rem;text-align:center;display:none"><\/p>',
    '<\/div>',
    '<\/div>',

    // 主导航
    '<header style="border-bottom:1px solid #1e293b;background:rgba(15,23,42,.8);position:sticky;top:0;z-index:30;padding:0 1.5rem">',
    '<div style="max-width:1100px;margin:0 auto;height:4rem;display:flex;align-items:center;justify-content:space-between">',
    '<div style="display:flex;align-items:center;gap:.8rem;flex-wrap:wrap">',
    '<span style="font-weight:700;font-size:1.1rem">&#127760; FreePBX Node Manager<\/span>',
    '<span style="font-size:.7rem;padding:.2rem .5rem;border-radius:.3rem;background:rgba(16,185,129,.15);color:#34d399">Serverless<\/span>',
    '<a href="/" style="margin-left:.6rem;padding:.35rem .7rem;border-radius:.4rem;background:#1e3a5f;color:#93c5fd;text-decoration:none;font-size:.85rem;font-weight:600">代理节点<\/a>',
    '<a href="/sip" style="padding:.35rem .7rem;border-radius:.4rem;color:#cbd5e1;text-decoration:none;font-size:.85rem;font-weight:600">SIP 管理<\/a>',
    '<\/div>',
    '<div style="display:flex;gap:.6rem">',
    '<button class="btn-gray" onclick="openSettings()">&#9881; 全局设置<\/button>',
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
    '<div style="border-top:1px solid #1e293b;padding-top:.8rem"><label style="display:block;color:#cbd5e1;margin-bottom:.3rem">修改密码（留空不修改）<\/label><input id="sPass" type="password" placeholder="输入新密码" class="inp"><\/div>',
    '<\/div>',
    '<div style="display:flex;justify-content:flex-end;gap:.5rem;margin-top:1.2rem">',
    '<button class="btn-gray" onclick="closeSettings()">取消<\/button>',
    '<button class="btn-blue" onclick="saveSettings()">保存<\/button>',
    '<\/div>',
    '<\/div>',
    '<\/div>',

    // 核心 JavaScript - 全部用普通函数和 DOM API，零模板字符串
    '<script>',
    'var D = {nodes:[], sub_token:"d31", cf_ip:"", admin_user:""};',
    'var editIdx = -1;',

    'function $(id){return document.getElementById(id)}',
    'function show(id){$(id).style.display="flex"}',
    'function hide(id){$(id).style.display="none"}',

    'function checkAuth(){',
    '  var t = localStorage.getItem("_pt");',
    '  if(t){ hide("loginWrap"); loadData(); }',
    '  else { show("loginWrap"); }',
    '}',

    'function doLogin(){',
    '  var u = $("lu").value, p = $("lp").value;',
    '  $("lerr").style.display="none";',
    '  fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:u,password:p})})',
    '  .then(function(r){return r.json();})',
    '  .then(function(d){',
    '    if(d.ok){ localStorage.setItem("_pt","1"); hide("loginWrap"); loadData(); }',
    '    else{ $("lerr").innerText = d.msg||"登录失败"; $("lerr").style.display="block"; }',
    '  })',
    '  .catch(function(e){ $("lerr").innerText="网络错误:"+e.message; $("lerr").style.display="block"; });',
    '}',

    'function logout(){ localStorage.removeItem("_pt"); hide("loginWrap"); show("loginWrap"); location.reload(); }',

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

    'function openSettings(){ $("sCfIp").value=D.cf_ip||"104.16.80.80"; $("sToken").value=D.sub_token||"d31"; $("sPass").value=""; show("setWrap"); }',
    'function closeSettings(){ hide("setWrap"); }',

    'function saveSettings(){',
    '  var payload = { cf_ip:$("sCfIp").value, sub_token:$("sToken").value||"d31" };',
    '  if($("sPass").value) payload.new_password = $("sPass").value;',
    '  D.cf_ip = payload.cf_ip; D.sub_token = payload.sub_token;',
    '  fetch("/api/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});',
    '  $("clashUrl").value = location.origin+"/sub/"+D.sub_token;',
    '  $("v2rayUrl").value = location.origin+"/sub/"+D.sub_token+"?type=v2ray";',
    '  closeSettings();',
    '  renderNodes();',
    '  alert("设置已保存");',
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

function renderSipHtml() {
  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<title>SIP 管理 - FreePBX Node Manager<\/title>',
    '<script src="https://cdn.tailwindcss.com"><\/script>',
    '<style>',
    'body{background:#0f172a;color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
    '.card{background:rgba(30,41,59,.7);border:1px solid rgba(255,255,255,.1);backdrop-filter:blur(12px)}',
    '.inp{width:100%;padding:.6rem .9rem;border-radius:.5rem;background:#0f172a;border:1px solid #334155;color:#fff;outline:none;box-sizing:border-box}',
    '.btn-blue{padding:.55rem 1.1rem;background:#2563eb;color:#fff;border-radius:.5rem;cursor:pointer;font-weight:600;border:none;font-size:.85rem}',
    '.btn-green{padding:.5rem 1rem;background:#059669;color:#fff;border-radius:.5rem;cursor:pointer;font-weight:600;border:none;font-size:.8rem}',
    '.btn-gray{padding:.4rem .8rem;background:#334155;color:#cbd5e1;border-radius:.5rem;cursor:pointer;border:none;font-size:.8rem}',
    '.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;z-index:50}',
    'table{width:100%;border-collapse:collapse}',
    'th{text-align:left;padding:.7rem 1rem;font-size:.75rem;color:#94a3b8;background:rgba(15,23,42,.6)}',
    'td{padding:.7rem 1rem;font-size:.85rem;border-top:1px solid #1e293b}',
    '.stat{flex:1;min-width:140px;padding:1rem;border-radius:.8rem;background:rgba(15,23,42,.6);border:1px solid #1e293b}',
    '.ok{color:#34d399}.bad{color:#f87171}.warn{color:#fbbf24}',
    '<\/style>',
    '<\/head>',
    '<body>',
    '<div id="loginWrap" class="modal-bg">',
    '<div class="card" style="padding:2rem;border-radius:1rem;width:100%;max-width:420px">',
    '<h2 style="font-size:1.3rem;font-weight:700;text-align:center;margin-bottom:1rem">SIP 管理登录<\/h2>',
    '<input id="lu" type="text" value="admin" class="inp" style="margin-bottom:1rem">',
    '<input id="lp" type="password" value="admin888" class="inp" style="margin-bottom:1rem">',
    '<button class="btn-blue" style="width:100%" onclick="doLogin()">登 录<\/button>',
    '<p id="lerr" style="color:#f87171;font-size:.8rem;margin-top:.6rem;text-align:center;display:none"><\/p>',
    '<\/div><\/div>',

    '<header style="border-bottom:1px solid #1e293b;background:rgba(15,23,42,.8);position:sticky;top:0;z-index:30;padding:0 1.5rem">',
    '<div style="max-width:1100px;margin:0 auto;height:4rem;display:flex;align-items:center;justify-content:space-between">',
    '<div style="display:flex;align-items:center;gap:.8rem;flex-wrap:wrap">',
    '<span style="font-weight:700;font-size:1.1rem">&#127760; FreePBX Node Manager<\/span>',
    '<a href="/" style="margin-left:.6rem;padding:.35rem .7rem;border-radius:.4rem;color:#cbd5e1;text-decoration:none;font-size:.85rem;font-weight:600">代理节点<\/a>',
    '<a href="/sip" style="padding:.35rem .7rem;border-radius:.4rem;background:#1e3a5f;color:#93c5fd;text-decoration:none;font-size:.85rem;font-weight:600">SIP 管理<\/a>',
    '<\/div>',
    '<button class="btn-gray" style="color:#f87171" onclick="logout()">退出<\/button>',
    '<\/div><\/header>',

    '<main style="max-width:1280px;margin:2rem auto;padding:0 1.5rem;display:flex;flex-direction:column;gap:1.5rem">',
    '<div class="card" style="padding:1.5rem;border-radius:1rem">',
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">',
    '<div><h3 style="font-weight:700">大阪 SIP 机运行状态<\/h3>',
    '<p id="staleHint" style="font-size:.8rem;color:#64748b;margin-top:.3rem">等待心跳...<\/p><\/div>',
    '<button class="btn-gray" onclick="loadSip()">刷新<\/button>',
    '<\/div>',
    '<div id="stats" style="display:flex;flex-wrap:wrap;gap:.8rem"><\/div>',
    '<\/div>',

    '<div class="card" style="padding:1.5rem;border-radius:1rem">',
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">',
    '<div><h3 style="font-weight:700">分机目录<\/h3>',
    '<p style="font-size:.8rem;color:#64748b;margin-top:.3rem">绿点在线，灰点离线。通话记录来自 Asterisk CDR。<\/p><\/div>',
    '<button class="btn-green" onclick="openExt()">+ 添加分机<\/button>',
    '<\/div>',
    '<div style="overflow-x:auto">',
    '<table><thead><tr>',
    '<th>在线<\/th><th>分机<\/th><th>名称<\/th><th>传输<\/th><th>登录 IP<\/th><th>位置<\/th><th>连接延时<\/th><th>最近上线<\/th><th>拨打次数<\/th><th>总通话时长<\/th><th>通话记录<\/th><th style="text-align:right">操作<\/th>',
    '<\/tr><\/thead><tbody id="etb"><\/tbody><\/table>',
    '<\/div><\/div>',
    '<\/main>',

    '<div id="extWrap" class="modal-bg" style="display:none">',
    '<div class="card" style="padding:1.5rem;border-radius:1rem;width:100%;max-width:420px">',
    '<h3 id="extTitle" style="font-weight:700;margin-bottom:1rem">添加分机<\/h3>',
    '<div style="display:flex;flex-direction:column;gap:.8rem">',
    '<div><label style="font-size:.8rem;color:#cbd5e1">分机号<\/label><input id="eExt" class="inp"><\/div>',
    '<div><label style="font-size:.8rem;color:#cbd5e1">名称<\/label><input id="eName" class="inp"><\/div>',
    '<div><label style="font-size:.8rem;color:#cbd5e1">传输<\/label><select id="eTr" class="inp"><option value="udp">UDP 5060<\/option><option value="tcp">TCP 5060<\/option><option value="tls">TLS 5061<\/option><\/select><\/div>',
    '<\/div>',
    '<div style="display:flex;justify-content:flex-end;gap:.5rem;margin-top:1.2rem">',
    '<button class="btn-gray" onclick="hide(\'extWrap\')">取消<\/button>',
    '<button class="btn-green" onclick="saveExt()">保存<\/button>',
    '<\/div><\/div><\/div>',

    '<div id="cdrWrap" class="modal-bg" style="display:none">',
    '<div class="card" style="padding:1.5rem;border-radius:1rem;width:100%;max-width:1100px;max-height:90vh;overflow:auto">',
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">',
    '<h3 id="cdrTitle" style="font-weight:700">通话记录<\/h3>',
    '<button class="btn-gray" onclick="hide(\'cdrWrap\')">关闭<\/button>',
    '<\/div>',
    '<div style="overflow-x:auto">',
    '<table><thead><tr><th>时间<\/th><th>主叫<\/th><th>被叫<\/th><th>结果<\/th><th>通话时长<\/th><th>质量<\/th><th>媒体延时<\/th><th>抖动<\/th><th>丢包<\/th><\/tr><\/thead>',
    '<tbody id="cdrBody"><\/tbody><\/table><\/div>',
    '<div id="cdrPager" style="display:flex;justify-content:space-between;align-items:center;margin-top:1rem;font-size:.85rem;color:#94a3b8"><\/div>',
    '<\/div><\/div>',

    '<script>',
    'var E = []; var ST = null; var GEO = {}; var STALE = true; var editIdx = -1; var cdrPage = 1; var cdrExt = ""; var PAGE = 25;',
    'function $(id){return document.getElementById(id)}',
    'function show(id){$(id).style.display="flex"}',
    'function hide(id){$(id).style.display="none"}',
    'function checkAuth(){ if(localStorage.getItem("_pt")){ hide("loginWrap"); loadSip(); } else show("loginWrap"); }',
    'function doLogin(){',
    '  fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:$("lu").value,password:$("lp").value})})',
    '  .then(function(r){return r.json();}).then(function(d){',
    '    if(d.ok){ localStorage.setItem("_pt","1"); hide("loginWrap"); loadSip(); }',
    '    else { $("lerr").innerText=d.msg||"失败"; $("lerr").style.display="block"; }',
    '  });',
    '}',
    'function logout(){ localStorage.removeItem("_pt"); location.href="/"; }',
    'function loadSip(){',
    '  fetch("/api/sip").then(function(r){return r.json();}).then(function(d){',
    '    E = d.extensions||[]; ST = d.status||null; GEO = d.geo||{}; STALE = !!d.stale;',
    '    renderStatus();',
    '    renderExt();',
    '  });',
    '}',
    'function renderStatus(){',
    '  var box = $("stats"); var hint = $("staleHint"); var s = ST;',
    '  if(!s){ hint.innerText="大阪机尚未上报心跳。"; box.innerHTML=""; return; }',
    '  hint.innerHTML = STALE ? "<span class=\\"bad\\">心跳超时，机器可能卡住或离线<\\/span> · 上次 "+s.received_at : "<span class=\\"ok\\">心跳正常<\\/span> · "+s.received_at;',
    '  function card(t,v,c){ return "<div class=\\"stat\\"><div style=\\"font-size:.75rem;color:#94a3b8\\">"+t+"<\\/div><div style=\\"font-size:1.15rem;font-weight:700;margin-top:.3rem\\" class=\\""+(c||"")+"\\">"+v+"<\\/div><\\/div>"; }',
    '  var html = "";',
    '  html += card("主机", s.hostname||"-");',
    '  html += card("Asterisk", s.asterisk||"-", s.asterisk==="active"?"ok":"bad");',
    '  html += card("负载", s.load||"-");',
    '  html += card("CPU", (s.cpu_pct!=null? s.cpu_pct+"%" : "-"), (s.cpu_pct||0)>85?"bad":"");',
    '  html += card("内存", s.mem_used+" / "+s.mem_total, (s.mem_pct||0)>90?"bad":"");',
    '  html += card("磁盘", s.disk_used+" / "+s.disk_total, (s.disk_pct||0)>90?"bad":"");',
    '  html += card("网卡", s.net||"-");',
    '  html += card("运行时长", s.uptime||"-");',
    '  box.innerHTML = html;',
    '}',
    'function liveMap(){',
    '  var m = {}; var cs = (ST && ST.contacts) || [];',
    '  for(var i=0;i<cs.length;i++){ if(cs[i].ext) m[String(cs[i].ext)] = cs[i]; }',
    '  return m;',
    '}',
    'function fmtDur(sec){',
    '  sec = parseInt(sec,10)||0;',
    '  var h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60), s=sec%60;',
    '  function z(n){return n<10?"0"+n:""+n;}',
    '  return h>0 ? h+":"+z(m)+":"+z(s) : z(m)+":"+z(s);',
    '}',
    'function fmtTime(t){ if(!t) return "-"; return t.replace("T"," ").replace("Z","").substring(0,19); }',
    'function cdrFor(ext){',
    '  var all = (ST && ST.cdr) || []; var out=[];',
    '  for(var i=0;i<all.length;i++){',
    '    var r=all[i];',
    '    if(String(r.src)===String(ext) || String(r.dst)===String(ext)) out.push(r);',
    '  }',
    '  return out.reverse();',
    '}',
    'function statsFor(ext){',
    '  var rows = cdrFor(ext); var n=0, dur=0;',
    '  for(var i=0;i<rows.length;i++){ n++; dur += parseInt(rows[i].billsec||rows[i].duration||0,10)||0; }',
    '  return {count:n, dur:dur};',
    '}',
    'function renderExt(){',
    '  var tb=$("etb"); var html=""; var live=liveMap(); var last=(ST && ST.last_seen)||{};',
    '  for(var i=0;i<E.length;i++){',
    '    var x=E[i]; var L=live[String(x.ext)];',
    '    var online = !STALE && L && String(L.status).toLowerCase().indexOf("avail")>=0;',
    '    var dot = online ? "<span class=\\"ok\\">&#9679;<\/span>" : "<span style=\\"color:#64748b\\">&#9679;<\/span>";',
    '    var tr = online ? (L.transport||x.transport||"-") : (x.transport||"-");',
    '    tr = String(tr).toUpperCase();',
    '    var ip = online ? (L.ip||"-") : "-";',
    '    var loc = (ip && GEO[ip]) ? GEO[ip] : (online ? "查询中" : "-");',
    '    var rtt = online && L.rtt!=null ? L.rtt+" ms" : "-";',
    '    var seen = last[x.ext] ? fmtTime(last[x.ext]) : "-";',
    '    var st = statsFor(x.ext);',
    '    html += "<tr>";',
    '    html += "<td style=\\"font-size:1.1rem\\">"+dot+"<\\/td>";',
    '    html += "<td>"+x.ext+"<\\/td><td>"+x.name+"<\\/td>";',
    '    html += "<td>"+tr+"<\\/td>";',
    '    html += "<td style=\\"font-family:monospace;font-size:.8rem\\">"+ip+"<\\/td>";',
    '    html += "<td style=\\"font-size:.8rem\\">"+loc+"<\\/td>";',
    '    html += "<td>"+rtt+"<\\/td>";',
    '    html += "<td style=\\"font-size:.8rem;white-space:nowrap\\">"+seen+"<\\/td>";',
    '    html += "<td>"+st.count+"<\\/td><td>"+fmtDur(st.dur)+"<\\/td>";',
    '    html += "<td><button class=\\"btn-gray\\" onclick=\\"openCdr(\'"+x.ext+"\')\\">查看<\\/button><\\/td>";',
    '    html += "<td style=\\"text-align:right;white-space:nowrap\\">";',
    '    html += "<button class=\\"btn-gray\\" style=\\"margin-right:.3rem\\" onclick=\\"editExt("+i+")\\">编辑<\\/button>";',
    '    html += "<button class=\\"btn-gray\\" style=\\"color:#f87171\\" onclick=\\"delExt("+i+")\\">删除<\\/button><\\/td><\\/tr>";',
    '  }',
    '  tb.innerHTML = html || "<tr><td colspan=\\"12\\" style=\\"text-align:center;color:#475569;padding:1.2rem\\">暂无分机<\\/td><\\/tr>";',
    '}',
    'function openCdr(ext){ cdrExt=String(ext); cdrPage=1; $("cdrTitle").innerText="分机 "+ext+" 通话记录"; show("cdrWrap"); drawCdr(); }',
    'function drawCdr(){',
    '  var rows = cdrFor(cdrExt);',
    '  var total = rows.length; var pages = Math.max(1, Math.ceil(total/PAGE));',
    '  if(cdrPage>pages) cdrPage=pages; if(cdrPage<1) cdrPage=1;',
    '  var start=(cdrPage-1)*PAGE; var slice=rows.slice(start, start+PAGE);',
    '  var html="";',
    '  if(!slice.length){ html="<tr><td colspan=\\"9\\" style=\\"text-align:center;color:#475569;padding:1.5rem\\">暂无通话<\\/td><\\/tr>"; }',
    '  else {',
    '    for(var i=0;i<slice.length;i++){',
    '      var r=slice[i];',
    '      var qc = r.quality==="好"?"ok":(r.quality==="差"?"bad":"warn");',
    '      html += "<tr>";',
    '      html += "<td style=\\"white-space:nowrap\\">"+fmtTime(r.time)+"<\\/td>";',
    '      html += "<td>"+r.src+"<\\/td><td>"+r.dst+"<\\/td>";',
    '      html += "<td>"+(r.disposition||"-")+"<\\/td>";',
    '      html += "<td>"+fmtDur(r.billsec||r.duration)+"<\\/td>";',
    '      html += "<td class=\\""+qc+"\\">"+(r.quality||"-")+"<\\/td>";',
    '      html += "<td>"+(r.media_rtt||"-")+"<\\/td>";',
    '      html += "<td>"+(r.jitter||"-")+"<\\/td>";',
    '      html += "<td>"+(r.loss||"-")+"<\\/td>";',
    '      html += "<\\/tr>";',
    '    }',
    '  }',
    '  $("cdrBody").innerHTML = html;',
    '  var pg = "第 "+cdrPage+" / "+pages+" 页，共 "+total+" 条";',
    '  pg += " <span><button class=\\"btn-gray\\" onclick=\\"cdrPage--;drawCdr()\\">上一页<\\/button> ";',
    '  pg += "<button class=\\"btn-gray\\" onclick=\\"cdrPage++;drawCdr()\\">下一页<\\/button><\\/span>";',
    '  $("cdrPager").innerHTML = pg;',
    '}',
    'function openExt(){ editIdx=-1; $("extTitle").innerText="添加分机"; $("eExt").value=""; $("eName").value=""; $("eTr").value="udp"; show("extWrap"); }',
    'function editExt(i){ editIdx=i; var x=E[i]; $("extTitle").innerText="编辑分机"; $("eExt").value=x.ext; $("eName").value=x.name; $("eTr").value=x.transport||"udp"; show("extWrap"); }',
    'function saveExt(){',
    '  var n={ ext:$("eExt").value.trim(), name:$("eName").value.trim(), transport:$("eTr").value };',
    '  if(!n.ext){ alert("分机号不能为空"); return; }',
    '  if(editIdx>=0) E[editIdx]=n; else E.push(n);',
    '  fetch("/api/sip/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({extensions:E})});',
    '  hide("extWrap"); renderExt();',
    '}',
    'function delExt(i){ if(confirm("删除该分机目录项？不会自动改 Asterisk。")){ E.splice(i,1); fetch("/api/sip/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({extensions:E})}); renderExt(); } }',
    'document.addEventListener("keydown", function(e){ if(e.key==="Enter" && $("loginWrap").style.display!=="none") doLogin(); });',
    'setInterval(function(){ if(localStorage.getItem("_pt")) loadSip(); }, 30000);',
    'checkAuth();',
    '<\/script>',
    '<\/body><\/html>'
  ].join('\n');
}
