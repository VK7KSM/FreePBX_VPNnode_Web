// =========================================================================
// elfRadio SIP/VPN Manage - Cloudflare Workers 管理面板与订阅生成器 v2.4.0
// 升级：SIP 管理独立页 + 甲骨文 SIP 机负荷心跳监控
// =========================================================================

import { LOGO_PNG_B64 } from "./logo.js";

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

function contactFingerprint(contacts) {
  const cs = contacts || [];
  const parts = [];
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    if (!c || !c.ext) continue;
    const on = String(c.status || "").toLowerCase().indexOf("avail") >= 0 ? "1" : "0";
    parts.push(String(c.ext) + ":" + on);
  }
  parts.sort();
  return parts.join(",");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;

    if (pathname === "/logo.png" || pathname === "/favicon.ico") {
      return logoResponse();
    }

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
      const raw = (await getStore(env, "sip_extensions")) || defaultSipExtensions();
      const secrets = (await getStore(env, "sip_secrets")) || {};
      const extensions = raw.map(function (x) { return publicExtension(x, secrets); });
      const osaka = await fetchOsakaStatus(env);
      const status = osaka.status;
      const geo = await geoForStatus(env, status);
      const config_rev = (await getStore(env, "sip_config_rev")) || 0;
      const applied_rev = (status && status.applied_rev) || 0;
      return json({
        ok: true,
        extensions,
        status,
        geo,
        stale: isSipStale(status) || !!osaka.err,
        sync: {
          config_rev,
          applied_rev,
          pending: Number(config_rev) !== Number(applied_rev),
          error: (status && status.apply_error) || osaka.err || ""
        }
      });
    }

    if (pathname === "/api/sip/pull" && method === "GET") {
      const token = request.headers.get("X-Heartbeat-Token") || "";
      const expected = (await getStore(env, "sip_heartbeat_token")) || "";
      if (!expected || token !== expected) {
        return json({ ok: false, msg: "heartbeat token 无效" }, 401);
      }
      const raw = (await getStore(env, "sip_extensions")) || defaultSipExtensions();
      const secrets = (await getStore(env, "sip_secrets")) || {};
      const config_rev = (await getStore(env, "sip_config_rev")) || 0;
      const applied = parseInt(url.searchParams.get("applied") || "0", 10) || 0;
      const pending = Number(config_rev) !== Number(applied);
      const resp = { ok: true, config_rev, applied_rev: applied, pending };
      if (pending) {
        resp.extensions = raw.map(function (x) {
          const item = publicExtension(x, secrets);
          const pw = secrets[item.ext];
          if (pw) item.password = pw;
          delete item.has_password;
          return item;
        });
      }
      return json(resp);
    }

    if (pathname === "/api/sip/save" && method === "POST") {
      try {
        const data = await request.json();
        if (!Array.isArray(data.extensions)) {
          return json({ ok: false, msg: "extensions 必须是数组" }, 400);
        }
        const secrets = Object.assign({}, (await getStore(env, "sip_secrets")) || {});
        const cleaned = [];
        for (let i = 0; i < data.extensions.length; i++) {
          const src = data.extensions[i] || {};
          const ext = String(src.ext || "").trim();
          if (!/^[0-9]{3,6}$/.test(ext)) {
            return json({ ok: false, msg: "分机号必须是 3 到 6 位数字" }, 400);
          }
          const item = publicExtension(src, secrets);
          if (src.password) {
            secrets[ext] = String(src.password);
            item.has_password = true;
          }
          if (src.clear_password) {
            delete secrets[ext];
            item.has_password = false;
          }
          delete item.has_password;
          cleaned.push(item);
        }
        const keep = {};
        for (let i = 0; i < cleaned.length; i++) keep[cleaned[i].ext] = true;
        Object.keys(secrets).forEach(function (k) { if (!keep[k]) delete secrets[k]; });
        const prevRev = (await getStore(env, "sip_config_rev")) || 0;
        await setStore(env, "sip_extensions", cleaned);
        await setStore(env, "sip_secrets", secrets);
        await setStore(env, "sip_config_rev", prevRev + 1);
        return json({ ok: true, config_rev: prevRev + 1 });
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
      return json({ ok: true, stored: "osaka-local" });
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
  const rows = [
    ["101", "Yealink 1", true, true],
    ["102", "Yealink 2", true, false],
    ["103", "Ricky Song", true, false],
    ["104", "Pixel 5", true, false],
    ["105", "D31-Chengdu", true, false],
    ["106", "iPhone XR", true, false],
    ["107", "JiMaMu", true, false],
    ["108", "Elvin Sydney", true, false],
    ["201", "D22-BB", true, false],
    ["202", "D22-JJ", true, false],
    ["203", "H13", true, false],
    ["300", "Pixel3 GSM Gateway", false, true]
  ];
  return rows.map(function (r) {
    return publicExtension({
      ext: r[0],
      name: r[1],
      outbound: r[2],
      sms: r[3],
      gateway: r[0] === "300" ? "none" : "pixel"
    }, {});
  });
}

function publicExtension(x, secrets) {
  const ext = String((x && x.ext) || "").trim();
  const isGw = ext === "300";
  const ring = parseInt(x && x.ringtimer, 10);
  return {
    ext: ext,
    name: String((x && x.name) || "").trim(),
    outbound: isGw ? false : (x && x.outbound) !== false,
    sms: (x && x.sms) != null ? !!x.sms : (ext === "101" || ext === "300"),
    gateway: isGw ? "none" : ((x && x.gateway) || "pixel"),
    cf: String((x && x.cf) || "").trim(),
    cf_busy: String((x && x.cf_busy) || "").trim(),
    cf_noreply: String((x && x.cf_noreply) || "").trim(),
    ringtimer: ring > 0 ? ring : 60,
    has_password: !!(secrets && secrets[ext])
  };
}

async function fetchOsakaStatus(env) {
  const token = (await getStore(env, "sip_heartbeat_token")) || "";
  try {
    const r = await fetch("https://api.elfradio.net/status", {
      headers: {
        "X-Heartbeat-Token": token,
        "User-Agent": "sip-panel/1.0"
      }
    });
    if (!r.ok) return { status: null, err: "大阪接口 HTTP " + r.status };
    const txt = await r.text();
    const safe = txt.replace(/:\s*-?Infinity\b/g, ":null").replace(/:\s*NaN\b/g, ":null");
    const st = JSON.parse(safe);
    if (!st || st.ok === false) return { status: null, err: (st && st.msg) || "大阪接口返回失败" };
    return { status: st, err: "" };
  } catch (e) {
    return { status: null, err: "无法连接大阪隧道: " + (e && e.message ? e.message : e) };
  }
}

function isSipStale(status) {
  if (!status || !status.received_at) return true;
  const t = Date.parse(status.received_at);
  if (!t) return true;
  return (Date.now() - t) > 45000;
}

function countOnlineContacts(contacts) {
  let n = 0;
  const cs = contacts || [];
  for (let i = 0; i < cs.length; i++) {
    if (cs[i] && String(cs[i].status || "").toLowerCase().indexOf("avail") >= 0) n++;
  }
  return n;
}

function attachHistory(prev, body) {
  const hist = Array.isArray(prev.history) ? prev.history.slice() : [];
  const t0 = Date.parse(prev.received_at || "") || 0;
  const t1 = Date.parse(body.received_at || "") || Date.now();
  const dt = (t1 - t0) / 1000;
  let rxBps = 0;
  let txBps = 0;
  if (dt > 0.5 && prev.rx_bytes != null && body.rx_bytes != null) {
    rxBps = Math.max(0, (Number(body.rx_bytes) - Number(prev.rx_bytes)) / dt);
    txBps = Math.max(0, (Number(body.tx_bytes) - Number(prev.tx_bytes)) / dt);
  } else if (prev.rx_bps != null) {
    rxBps = Number(prev.rx_bps) || 0;
    txBps = Number(prev.tx_bps) || 0;
  }
  const online = countOnlineContacts(body.contacts);
  hist.push({
    t: body.received_at,
    cpu: Number(body.cpu_pct) || 0,
    mem: Number(body.mem_pct) || 0,
    disk: Number(body.disk_pct) || 0,
    rx: rxBps,
    tx: txBps,
    online: online,
    calls: Number(body.active_calls) || 0
  });
  body.history = hist.length > 120 ? hist.slice(hist.length - 120) : hist;
  body.rx_bps = rxBps;
  body.tx_bps = txBps;
  body.online_count = online;
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
      try { await setStore(env, "geo_" + ip, label); } catch (e) {}
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
function logoResponse() {
  const bin = Uint8Array.from(atob(LOGO_PNG_B64), function (c) { return c.charCodeAt(0); });
  return new Response(bin, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400"
    }
  });
}

function brandHtml() {
  return [
    '<a href="/" style="display:flex;align-items:center;gap:.55rem;text-decoration:none;color:inherit">',
    '<img src="/logo.png" alt="elfRadio" width="36" height="36" style="width:36px;height:36px;border-radius:.55rem;object-fit:cover;flex-shrink:0">',
    '<span style="font-weight:700;font-size:1.05rem;white-space:nowrap">elfRadio SIP/VPN Manage</span>',
    '</a>'
  ].join("");
}

function renderHtml() {
  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<title>elfRadio SIP/VPN Manage</title>',
    '<link rel="icon" type="image/png" href="/logo.png">',
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
    '<img src="/logo.png" alt="elfRadio" width="64" height="64" style="width:64px;height:64px;border-radius:.8rem;object-fit:cover;margin-bottom:.6rem">',
    '<h2 style="font-size:1.3rem;font-weight:700">elfRadio SIP/VPN Manage</h2>',
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
    brandHtml(),
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
    '<title>elfRadio SIP/VPN Manage</title>',
    '<link rel="icon" type="image/png" href="/logo.png">',
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
    'th{text-align:left;padding:.65rem .7rem;font-size:.8rem;color:#94a3b8;background:rgba(15,23,42,.6);white-space:nowrap}',
    'td{padding:.65rem .7rem;font-size:.85rem;border-top:1px solid #1e293b;vertical-align:middle}',
    'tr.sel td{background:rgba(30,58,95,.55)}',
    '.rowchk{width:16px;height:16px;accent-color:#3b82f6;cursor:pointer}',
    '.stat{flex:1;min-width:120px;padding:.85rem 1rem;border-radius:.8rem;background:rgba(15,23,42,.6);border:1px solid #1e293b}',
    '.mon-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.8rem;width:100%}',
    '.mon-card{background:rgba(15,23,42,.75);border:1px solid #1e293b;border-radius:.8rem;padding:.85rem 1rem;min-width:0}',
    '@media(max-width:800px){.mon-grid{grid-template-columns:1fr}}',
    '.ok{color:#34d399}.bad{color:#f87171}.warn{color:#fbbf24}',
    '.dot{display:inline-block;width:14px;height:14px;border-radius:50%;vertical-align:middle;box-shadow:0 0 0 3px rgba(255,255,255,.08)}',
    '.dot-on{background:#22c55e}.dot-off{background:#ef4444}',
    'a.extlink{color:#93c5fd;text-decoration:none;font-weight:600;cursor:pointer}',
    'a.namelink{color:#e2e8f0;text-decoration:none;cursor:pointer}',
    'a.extlink:hover,a.namelink:hover{text-decoration:underline}',
    '<\/style>',
    '<\/head>',
    '<body>',
    '<div id="loginWrap" class="modal-bg">',
    '<div class="card" style="padding:2rem;border-radius:1rem;width:100%;max-width:420px">',
    '<div style="text-align:center;margin-bottom:1rem">',
    '<img src="/logo.png" alt="elfRadio" width="56" height="56" style="width:56px;height:56px;border-radius:.7rem;object-fit:cover;margin-bottom:.5rem">',
    '<h2 style="font-size:1.3rem;font-weight:700">elfRadio SIP/VPN Manage<\/h2>',
    '<p style="font-size:.8rem;color:#94a3b8;margin-top:.3rem">SIP 管理登录<\/p>',
    '<\/div>',
    '<input id="lu" type="text" value="admin" class="inp" style="margin-bottom:1rem">',
    '<input id="lp" type="password" value="admin888" class="inp" style="margin-bottom:1rem">',
    '<button class="btn-blue" style="width:100%" onclick="doLogin()">登 录<\/button>',
    '<p id="lerr" style="color:#f87171;font-size:.8rem;margin-top:.6rem;text-align:center;display:none"><\/p>',
    '<\/div><\/div>',

    '<header style="border-bottom:1px solid #1e293b;background:rgba(15,23,42,.8);position:sticky;top:0;z-index:30;padding:0 1.5rem">',
    '<div style="max-width:1280px;margin:0 auto;height:4rem;display:flex;align-items:center;justify-content:space-between">',
    '<div style="display:flex;align-items:center;gap:.8rem;flex-wrap:nowrap">',
    brandHtml(),
    '<a href="/" style="margin-left:.6rem;padding:.35rem .7rem;border-radius:.4rem;color:#cbd5e1;text-decoration:none;font-size:.85rem;font-weight:600;white-space:nowrap">代理节点<\/a>',
    '<a href="/sip" style="padding:.35rem .7rem;border-radius:.4rem;background:#1e3a5f;color:#93c5fd;text-decoration:none;font-size:.85rem;font-weight:600;white-space:nowrap">SIP 管理<\/a>',
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
    '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:1rem;gap:1rem">',
    '<h3 style="font-weight:700;line-height:2.2rem;margin:0">分机目录<\/h3>',
    '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:.4rem;flex-shrink:0">',
    '<div style="display:flex;gap:.5rem;align-items:center">',
    '<button class="btn-green" onclick="openExt()">+ 添加分机<\/button>',
    '<button class="btn-gray" onclick="editSelected()">编辑<\/button>',
    '<button class="btn-gray" style="color:#f87171" onclick="delSelected()">删除<\/button>',
    '<\/div>',
    '<p id="syncHint" style="font-size:.8rem;color:#94a3b8;margin:0">等待同步状态...<\/p>',
    '<\/div>',
    '<\/div>',
    '<div style="overflow-x:auto">',
    '<table><thead><tr>',
    '<th><\/th><th>在线<\/th><th>分机号<\/th><th>名称<\/th><th>传输<\/th><th>IP<\/th><th>延时<\/th><th>最近上线<\/th><th>拨打次数<\/th><th>总通话时长<\/th>',
    '<\/tr><\/thead><tbody id="etb"><\/tbody><\/table>',
    '<\/div><\/div>',
    '<\/main>',

    '<div id="extWrap" class="modal-bg" style="display:none">',
    '<div class="card" style="padding:1.5rem;border-radius:1rem;width:100%;max-width:520px;max-height:90vh;overflow:auto">',
    '<h3 id="extTitle" style="font-weight:700;margin-bottom:1rem">添加分机<\/h3>',
    '<div style="display:flex;flex-direction:column;gap:.8rem">',
    '<div><label style="font-size:.8rem;color:#cbd5e1">分机号<\/label><input id="eExt" class="inp"><\/div>',
    '<div><label style="font-size:.8rem;color:#cbd5e1">名称<\/label><input id="eName" class="inp"><\/div>',
    '<div><label style="font-size:.8rem;color:#cbd5e1">密码<\/label><input id="ePw" type="password" class="inp" placeholder="留空则不修改现有密码"><\/div>',
    '<div><label style="font-size:.8rem;color:#cbd5e1">网关路由<\/label><select id="eGw" class="inp"><option value="pixel">Pixel GSM 网关 (300)<\/option><option value="none">仅内部分机<\/option><\/select><\/div>',
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:.6rem">',
    '<div><label style="font-size:.8rem;color:#cbd5e1">外呼权限<\/label><select id="eOut" class="inp"><option value="1">允许<\/option><option value="0">禁止<\/option><\/select><\/div>',
    '<div><label style="font-size:.8rem;color:#cbd5e1">短信权限<\/label><select id="eSms" class="inp"><option value="0">禁止<\/option><option value="1">允许<\/option><\/select><\/div>',
    '<\/div>',
    '<div><label style="font-size:.8rem;color:#cbd5e1">无条件呼叫转移<\/label><input id="eCf" class="inp" placeholder="空=不转移"><\/div>',
    '<div><label style="font-size:.8rem;color:#cbd5e1">遇忙转移<\/label><input id="eCfb" class="inp" placeholder="空=不转移"><\/div>',
    '<div><label style="font-size:.8rem;color:#cbd5e1">无应答转移<\/label><input id="eCfu" class="inp" placeholder="空=不转移"><\/div>',
    '<div><label style="font-size:.8rem;color:#cbd5e1">振铃超时（秒）<\/label><input id="eRing" type="number" class="inp" value="60"><\/div>',
    '<\/div>',
    '<p style="font-size:.75rem;color:#94a3b8;margin-top:.8rem">保存后会自动同步到大阪 SIP 机，通常几秒内生效。传输方式由话机实际注册决定，不能在这里指定。<\/p>',
    '<div style="display:flex;justify-content:flex-end;gap:.5rem;margin-top:1.2rem">',
    '<button class="btn-gray" onclick="hide(\'extWrap\')">取消<\/button>',
    '<button class="btn-green" onclick="saveExt()">保存并同步<\/button>',
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
    'var E = []; var ST = null; var GEO = {}; var STALE = true; var SYNC = null; var editIdx = -1; var selIdx = -1; var cdrPage = 1; var cdrExt = ""; var PAGE = 25; var HOLD = {};',
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
    '    if(d.extensions) E = d.extensions;',
    '    if(d.status){ ST = d.status; if(d.geo) GEO = d.geo; }',
    '    STALE = !!d.stale || !d.status;',
    '    SYNC = d.sync||null;',
    '    renderStatus();',
    '    renderExt();',
    '    renderSync();',
    '  }).catch(function(){ STALE=true; renderStatus(); });',
    '}',
    'function renderStatus(){',
    '  var box = $("stats"); var hint = $("staleHint"); var s = ST;',
    '  if(!s){ hint.innerText="暂时读不到新数据，图表保持上次。"; return; }',
    '  hint.innerHTML = STALE ? "<span class=\\"bad\\">心跳超时，机器可能卡住或离线<\\/span> · 上次 "+fmtSydney(s.received_at) : "<span class=\\"ok\\">心跳正常<\\/span> · "+fmtSydney(s.received_at);',
    '  function kpi(t,v,c){ return "<div class=\\"stat\\"><div style=\\"font-size:.75rem;color:#94a3b8\\">"+t+"<\\/div><div style=\\"font-size:1.15rem;font-weight:700;margin-top:.25rem\\" class=\\""+(c||"")+"\\">"+v+"<\\/div><\\/div>"; }',
    '  function series(hist,key){ var o=[]; for(var i=0;i<hist.length;i++) o.push(Number(hist[i][key])||0); return o; }',
    '  function svgArea(vals,color,yMax){',
    '    var w=100,h=38,n=vals.length;',
    '    if(!n) return "<div style=\\"height:72px\\"><\\/div>";',
    '    var mx=yMax||0; for(var i=0;i<n;i++) if(vals[i]>mx) mx=vals[i]; if(mx<=0) mx=1;',
    '    function pt(i,v){ var x=n===1?50:(i/(n-1)*w); var y=h-(v/mx)*h*0.9; return x.toFixed(2)+","+y.toFixed(2); }',
    '    var line=[], fill=["0,"+h];',
    '    for(var j=0;j<n;j++){ var p=pt(j,vals[j]); line.push(p); fill.push(p); }',
    '    fill.push(w+","+h);',
    '    return "<svg viewBox=\\"0 0 "+w+" "+h+"\\" preserveAspectRatio=\\"none\\" style=\\"width:100%;height:72px;display:block\\"><polygon fill=\\""+color+"22\\" points=\\""+fill.join(" ")+"\\"/><polyline fill=\\"none\\" stroke=\\""+color+"\\" stroke-width=\\"1.2\\" stroke-linejoin=\\"round\\" vector-effect=\\"non-scaling-stroke\\" points=\\""+line.join(" ")+"\\"/><\\/svg>";',
    '  }',
    '  function svgDual(a,b,ca,cb,yMax){',
    '    var w=100,h=38,n=Math.max(a.length,b.length);',
    '    if(!n) return "<div style=\\"height:72px\\"><\\/div>";',
    '    var mx=yMax||0; for(var i=0;i<n;i++){ if((a[i]||0)>mx) mx=a[i]; if((b[i]||0)>mx) mx=b[i]; } if(mx<=0) mx=1;',
    '    function poly(vals,col){ var pts=[]; for(var i=0;i<n;i++){ var x=n===1?50:(i/(n-1)*w); var y=h-((vals[i]||0)/mx)*h*0.9; pts.push(x.toFixed(2)+","+y.toFixed(2)); } return "<polyline fill=\\"none\\" stroke=\\""+col+"\\" stroke-width=\\"1\\" stroke-linejoin=\\"miter\\" stroke-linecap=\\"butt\\" vector-effect=\\"non-scaling-stroke\\" points=\\""+pts.join(" ")+"\\"/>"; }',
    '    return "<svg viewBox=\\"0 0 "+w+" "+h+"\\" preserveAspectRatio=\\"none\\" style=\\"width:100%;height:72px;display:block\\">"+poly(a,ca)+poly(b,cb)+"<\\/svg>";',
    '  }',
    '  function fmtRate(bps){ bps=Number(bps)||0; if(bps<1024) return Math.round(bps)+" B/s"; if(bps<1048576) return (bps/1024).toFixed(1)+" KB/s"; return (bps/1048576).toFixed(2)+" MB/s"; }',
    '  function todayCalls(st){',
    '    var rows=(st&&st.cdr)||[]; var day=sydneyDay(parseTime(st.received_at)); var n=0;',
    '    for(var i=0;i<rows.length;i++){ var d=sydneyDay(parseTime(rows[i].time)); if(!day || d===day) n++; }',
    '    return n;',
    '  }',
    '  var hist=s.history||[];',
    '  var live=liveMap(); var online=0; for(var k in live){ if(live[k] && String(live[k].status||"").toLowerCase().indexOf("avail")>=0) online++; }',
    '  var callsNow=s.active_calls!=null?s.active_calls:0;',
    '  var html="<div style=\\"display:flex;flex-wrap:wrap;gap:.7rem;width:100%;margin-bottom:.9rem\\">";',
    '  html += kpi("主机", s.hostname||"-");',
    '  html += kpi("Asterisk", s.asterisk||"-", s.asterisk==="active"?"ok":"bad");',
    '  html += kpi("运行时长", s.uptime||"-");',
    '  html += kpi("在线分机", online+" / "+(E.length||0), online?"ok":"");',
    '  html += kpi("当前呼叫", String(callsNow), callsNow?"ok":"");',
    '  html += kpi("今日通话", String(todayCalls(s)));',
    '  html += "</div><div class=\\"mon-grid\\">";',
    '  html += "<div class=\\"mon-card\\"><div style=\\"display:flex;justify-content:space-between;align-items:baseline\\"><span style=\\"font-size:.8rem;color:#94a3b8\\">CPU<\\/span><span style=\\"font-size:1.25rem;font-weight:700\\" class=\\""+((s.cpu_pct||0)>85?"bad":"")+"\\">"+(s.cpu_pct!=null?s.cpu_pct+"%":"-")+"<\\/span><\\/div><div style=\\"font-size:.75rem;color:#64748b;margin:.2rem 0 .35rem\\">负载 "+(s.load||"-")+"<\\/div>"+svgArea(series(hist,"cpu"),"#4ade80",100)+"<\\/div>";',
    '  html += "<div class=\\"mon-card\\"><div style=\\"display:flex;justify-content:space-between;align-items:baseline\\"><span style=\\"font-size:.8rem;color:#94a3b8\\">内存<\\/span><span style=\\"font-size:1.25rem;font-weight:700\\" class=\\""+((s.mem_pct||0)>90?"bad":"")+"\\">"+(s.mem_pct!=null?s.mem_pct+"%":"-")+"<\\/span><\\/div><div style=\\"font-size:.75rem;color:#64748b;margin:.2rem 0 .35rem\\">"+(s.mem_used||"-")+" / "+(s.mem_total||"-")+"<\\/div>"+svgArea(series(hist,"mem"),"#a78bfa",100)+"<\\/div>";',
    '  html += "<div class=\\"mon-card\\"><div style=\\"display:flex;justify-content:space-between;align-items:baseline\\"><span style=\\"font-size:.8rem;color:#94a3b8\\">磁盘<\\/span><span style=\\"font-size:1.25rem;font-weight:700\\" class=\\""+((s.disk_pct||0)>90?"bad":"")+"\\">"+(s.disk_pct!=null?s.disk_pct+"%":"-")+"<\\/span><\\/div><div style=\\"font-size:.75rem;color:#64748b;margin:.2rem 0 .35rem\\">"+(s.disk_used||"-")+" / "+(s.disk_total||"-")+"<\\/div>"+svgArea(series(hist,"disk"),"#fbbf24",100)+"<\\/div>";',
    '  html += "<div class=\\"mon-card\\"><div style=\\"display:flex;justify-content:space-between;align-items:baseline\\"><span style=\\"font-size:.8rem;color:#94a3b8\\">网卡<\\/span><span style=\\"font-size:1.05rem;font-weight:700\\">↓ "+fmtRate(s.rx_bps)+" · ↑ "+fmtRate(s.tx_bps)+"<\\/span><\\/div><div style=\\"font-size:.75rem;color:#64748b;margin:.2rem 0 .35rem\\"><span style=\\"color:#38bdf8\\">接收<\\/span> / <span style=\\"color:#fb7185\\">发送<\\/span> · 累计 "+(s.net||"-")+"<\\/div>"+svgDual(series(hist,"rx"),series(hist,"tx"),"#38bdf8","#fb7185")+"<\\/div>";',
    '  html += "</div>";',
    '  box.innerHTML = html;',
    '}',
    'function liveMap(){',
    '  var m = {}; var cs = (ST && ST.contacts) || []; var now = Date.now();',
    '  for(var i=0;i<cs.length;i++){',
    '    if(!cs[i].ext) continue;',
    '    var id=String(cs[i].ext);',
    '    m[id]=cs[i];',
    '    if(String(cs[i].status||"").toLowerCase().indexOf("avail")>=0) HOLD[id]={c:cs[i], until:now+30000};',
    '  }',
    '  for(var k in HOLD){ if(!m[k] && HOLD[k] && now<HOLD[k].until) m[k]=HOLD[k].c; }',
    '  return m;',
    '}',
    'function fmtDur(sec){',
    '  sec = parseInt(sec,10)||0;',
    '  var h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60), s=sec%60;',
    '  function z(n){return n<10?"0"+n:""+n;}',
    '  return h>0 ? h+":"+z(m)+":"+z(s) : z(m)+":"+z(s);',
    '}',
    'function parseTime(t){',
    '  if(!t) return null;',
    '  var s=String(t).trim();',
    '  if(/^\\d{4}-\\d{2}-\\d{2} /.test(s) && s.indexOf("Z")<0 && s.indexOf("+")<0) s=s.replace(" ","T")+"Z";',
    '  var d=new Date(s);',
    '  return isNaN(d.getTime())?null:d;',
    '}',
    'function sydneyDay(d){',
    '  if(!d) return "";',
    '  var p=new Intl.DateTimeFormat("en-CA",{timeZone:"Australia/Sydney",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(d);',
    '  function g(tp){ for(var i=0;i<p.length;i++) if(p[i].type===tp) return p[i].value; return ""; }',
    '  return g("year")+"-"+g("month")+"-"+g("day");',
    '}',
    'function fmtSydney(t){',
    '  var d=parseTime(t); if(!d) return "-";',
    '  var p=new Intl.DateTimeFormat("en-CA",{timeZone:"Australia/Sydney",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).formatToParts(d);',
    '  function g(tp){ for(var i=0;i<p.length;i++) if(p[i].type===tp) return p[i].value; return ""; }',
    '  return g("year")+"-"+g("month")+"-"+g("day")+" "+g("hour")+":"+g("minute")+":"+g("second");',
    '}',
    'function fmtTime(t){ return fmtSydney(t); }',
    'function fmtSeen(t){',
    '  var s = fmtSydney(t);',
    '  if(!s || s==="-") return "-";',
    '  var p = s.split(" ");',
    '  if(p.length<2) return s;',
    '  return "<div style=\\"line-height:1.25;white-space:nowrap\\">"+p[0]+"<\\/div><div style=\\"font-size:.75rem;color:#94a3b8;margin-top:.15rem;white-space:nowrap\\">"+p[1]+"<\\/div>";',
    '}',
    'function pickRow(i,on){ selIdx = on ? i : (selIdx===i ? -1 : selIdx); renderExt(); }',
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
    '  if(selIdx>=E.length) selIdx=-1;',
    '  for(var i=0;i<E.length;i++){',
    '    var x=E[i]; var L=live[String(x.ext)];',
    '    var online = L && String(L.status).toLowerCase().indexOf("avail")>=0;',
    '    var dot = online ? "<span class=\\"dot dot-on\\" title=\\"在线\\"><\\/span>" : "<span class=\\"dot dot-off\\" title=\\"离线\\"><\\/span>";',
    '    var tr = online && L.transport ? String(L.transport).toUpperCase() : "-";',
    '    var ip = online ? (L.ip||"") : "";',
    '    var loc = ip ? (GEO[ip] || "查询中") : "-";',
    '    var ipCell = ip ? "<div style=\\"font-family:monospace;font-size:.8rem;line-height:1.25;white-space:nowrap\\">"+ip+"<\\/div><div style=\\"font-size:.75rem;color:#94a3b8;margin-top:.15rem\\">"+loc+"<\\/div>" : "-";',
    '    var rtt = online && L.rtt!=null ? L.rtt+" ms" : "-";',
    '    var seen = last[x.ext] ? fmtSeen(last[x.ext]) : "-";',
    '    var st = statsFor(x.ext);',
    '    html += "<tr"+(selIdx===i?" class=\\"sel\\"":"")+">";',
    '    html += "<td><input class=\\"rowchk\\" type=\\"checkbox\\" "+(selIdx===i?"checked":"")+" onchange=\\"pickRow("+i+",this.checked)\\"><\\/td>";',
    '    html += "<td style=\\"text-align:center\\">"+dot+"<\\/td>";',
    '    html += "<td><a class=\\"extlink\\" href=\\"#\\" onclick=\\"openCdr(\'"+x.ext+"\');return false;\\">"+x.ext+"<\\/a><\\/td>";',
    '    html += "<td><a class=\\"namelink\\" href=\\"#\\" onclick=\\"openCdr(\'"+x.ext+"\');return false;\\">"+x.name+"<\\/a><\\/td>";',
    '    html += "<td>"+tr+"<\\/td>";',
    '    html += "<td>"+ipCell+"<\\/td>";',
    '    html += "<td style=\\"white-space:nowrap\\">"+rtt+"<\\/td>";',
    '    html += "<td>"+seen+"<\\/td>";',
    '    html += "<td>"+st.count+"<\\/td><td style=\\"white-space:nowrap\\">"+fmtDur(st.dur)+"<\\/td>";',
    '    html += "<\\/tr>";',
    '  }',
    '  tb.innerHTML = html || "<tr><td colspan=\\"10\\" style=\\"text-align:center;color:#475569;padding:1.2rem\\">暂无分机<\\/td><\\/tr>";',
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
    'function renderSync(){',
    '  var el=$("syncHint"); if(!el) return;',
    '  el.style.display="block";',
    '  if(SYNC && SYNC.error){ el.innerHTML="<span class=\\"bad\\">保存到交换机失败：<\\/span>"+SYNC.error; return; }',
    '  if(SYNC && SYNC.pending && window._sipSaved){ el.innerHTML="<span class=\\"warn\\">正在保存到 SIP 服务器…<\\/span>"; return; }',
    '  window._sipSaved=false;',
    '  el.innerHTML="<span class=\\"ok\\">已同步到 SIP 服务器<\\/span>";',
    '}',
    'function fillExtForm(x){',
    '  $("eExt").value=x.ext||""; $("eName").value=x.name||""; $("ePw").value="";',
    '  $("eGw").value=x.gateway||"pixel"; $("eOut").value=x.outbound===false?"0":"1";',
    '  $("eSms").value=x.sms?"1":"0"; $("eCf").value=x.cf||""; $("eCfb").value=x.cf_busy||""; $("eCfu").value=x.cf_noreply||"";',
    '  $("eRing").value=x.ringtimer||60;',
    '}',
    'function openExt(){ editIdx=-1; $("extTitle").innerText="添加分机"; $("eExt").readOnly=false; fillExtForm({outbound:true,sms:false,gateway:"pixel",ringtimer:60}); $("ePw").placeholder="新分机必须填写密码"; show("extWrap"); }',
    'function editExt(i){ editIdx=i; var x=E[i]; $("extTitle").innerText="编辑分机 "+x.ext; $("eExt").readOnly=true; fillExtForm(x); $("ePw").placeholder=x.has_password?"已有密码，留空则不修改":"请设置密码"; show("extWrap"); }',
    'function editSelected(){',
    '  if(selIdx<0 || selIdx>=E.length){ alert("请先勾选一个分机"); return; }',
    '  editExt(selIdx);',
    '}',
    'function saveExt(){',
    '  var n={ ext:$("eExt").value.trim(), name:$("eName").value.trim(), gateway:$("eGw").value, outbound:$("eOut").value==="1", sms:$("eSms").value==="1", cf:$("eCf").value.trim(), cf_busy:$("eCfb").value.trim(), cf_noreply:$("eCfu").value.trim(), ringtimer:parseInt($("eRing").value,10)||60 };',
    '  var pw=$("ePw").value;',
    '  if(!n.ext){ alert("分机号不能为空"); return; }',
    '  if(!/^[0-9]{3,6}$/.test(n.ext)){ alert("分机号必须是 3 到 6 位数字"); return; }',
    '  if(editIdx<0 && !pw){ alert("新分机必须设置密码"); return; }',
    '  if(n.ext==="300"){ n.outbound=false; n.gateway="none"; }',
    '  if(pw) n.password=pw;',
    '  if(editIdx>=0){ n.has_password = !!(pw || E[editIdx].has_password); E[editIdx]=n; } else { n.has_password=!!pw; E.push(n); selIdx=E.length-1; }',
    '  window._sipSaved=true;',
    '  fetch("/api/sip/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({extensions:E})}).then(function(r){return r.json();}).then(function(d){',
    '    if(!d.ok){ alert(d.msg||"保存失败"); window._sipSaved=false; return; }',
    '    hide("extWrap"); loadSip();',
    '  }).catch(function(){ alert("保存失败"); });',
    '}',
    'function delSelected(){',
    '  if(selIdx<0 || selIdx>=E.length){ alert("请先勾选一个分机"); return; }',
    '  var x=E[selIdx];',
    '  if(String(x.ext)==="300"){ alert("Pixel 网关 300 不能从面板删除。"); return; }',
    '  if(!confirm("确定删除分机 "+x.ext+"（"+(x.name||"")+"）？\\n将同步删除 SIP 机上的 Asterisk 分机账号。")) return;',
    '  E.splice(selIdx,1); selIdx=-1;',
    '  window._sipSaved=true;',
    '  fetch("/api/sip/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({extensions:E})}).then(function(){ loadSip(); });',
    '}',
    'document.addEventListener("keydown", function(e){ if(e.key==="Enter" && $("loginWrap").style.display!=="none") doLogin(); });',
    'setInterval(function(){ if(localStorage.getItem("_pt")) loadSip(); }, 2000);',
    'checkAuth();',
    '<\/script>',
    '<\/body><\/html>'
  ].join('\n');
}
