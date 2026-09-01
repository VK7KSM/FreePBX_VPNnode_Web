// =========================================================================
// FreePBX VPN Node Web - Cloudflare Workers 管理面板与订阅生成器 v2.2
// 升级：订阅中心分别独立展示 Mihomo/Clash 与 v2rayNG 两个专属输入框及复制按钮
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

    // 前端 HTML
    return new Response(renderHtml(), {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }
};

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
    '<div style="display:flex;align-items:center;gap:.8rem">',
    '<span style="font-weight:700;font-size:1.1rem">&#127760; FreePBX Node Manager<\/span>',
    '<span style="font-size:.7rem;padding:.2rem .5rem;border-radius:.3rem;background:rgba(16,185,129,.15);color:#34d399">Serverless<\/span>',
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
    '    $("clashUrl").value = location.origin+"/sub/"+d.sub_token+"?type=clash";',
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
    '  $("clashUrl").value = location.origin+"/sub/"+D.sub_token+"?type=clash";',
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
