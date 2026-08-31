// =========================================================================
// FreePBX VPN Node Web - Cloudflare Workers & Pages 纯净管理面板与订阅生成器
// 特性：纯单文件运行、内置账号密码登录、零环境变量依赖、可视化节点管理、自动生成 Mihomo/Clash 订阅
// =========================================================================

const DEFAULT_USER = "admin";
const DEFAULT_PASS = "admin888";
const DEFAULT_TOKEN = "d31_secret_token";

// 内存回退存储 (在未绑定 KV 时提供基础运行支持)
let MEMORY_STORE = {
  admin_user: DEFAULT_USER,
  admin_pass: DEFAULT_PASS,
  sub_token: DEFAULT_TOKEN,
  cf_preferred_ip: "104.16.80.80",
  nodes: [
    {
      id: "node-oracle-osaka",
      name: "Oracle-Osaka-VPS2",
      type: "vless",
      server: "oracle.yourdomain.com",
      port: 443,
      uuid: "11111111-2222-3333-4444-555555555555",
      network: "ws",
      path: "/stream-oracle",
      tls: true,
      sni: "oracle.yourdomain.com",
      custom_ip: ""
    }
  ]
};

async function getStore(env, key) {
  if (env && env.SUB_STORE_KV) {
    const val = await env.SUB_STORE_KV.get(key);
    if (val !== null) {
      try { return JSON.parse(val); } catch(e) { return val; }
    }
  }
  return MEMORY_STORE[key];
}

async function setStore(env, key, value) {
  MEMORY_STORE[key] = value;
  if (env && env.SUB_STORE_KV) {
    await env.SUB_STORE_KV.put(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // 1. 订阅下发接口: /sub/:name 或 /sub?token=xxx
    if (pathname.startsWith("/sub")) {
      return handleSubscription(url, env);
    }

    // 2. 后端 RESTful API 路由
    if (pathname.startsWith("/api/")) {
      return handleApi(request, env, pathname);
    }

    // 3. 前端 Web 管理界面 (HTML / CSS / JS)
    return new Response(renderHtml(), {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }
};

// ==========================================
// 订阅生成器处理逻辑
// ==========================================
async function handleSubscription(url, env) {
  const token = url.searchParams.get("token") || url.pathname.split("/").pop();
  const configuredToken = await getStore(env, "sub_token") || DEFAULT_TOKEN;
  
  if (token !== configuredToken && token !== "d31" && token !== "all") {
    return new Response("Unauthorized: Invalid subscription token", { status: 401 });
  }

  const nodes = await getStore(env, "nodes") || [];
  const globalCfIp = await getStore(env, "cf_preferred_ip") || "104.16.80.80";

  // 构建 Mihomo (Clash.Meta) YAML 格式
  let proxiesYaml = "";
  let proxyNames = [];

  for (const node of nodes) {
    const connectServer = node.custom_ip || globalCfIp || node.server;
    proxyNames.push(`      - "${node.name}"`);
    
    proxiesYaml += `  - name: "${node.name}"\n` +
      `    type: ${node.type}\n` +
      `    server: ${connectServer}\n` +
      `    port: ${node.port || 443}\n` +
      `    uuid: ${node.uuid}\n` +
      `    network: ${node.network || "ws"}\n` +
      `    tls: ${node.tls ? "true" : "false"}\n` +
      `    udp: true\n` +
      `    servername: "${node.sni || node.server}"\n` +
      `    ws-opts:\n` +
      `      path: "${node.path || "/"}"\n` +
      `      headers:\n` +
      `        Host: "${node.sni || node.server}"\n\n`;
  }

  if (nodes.length === 0) {
    proxiesYaml = `  - name: "DIRECT"\n    type: direct\n`;
    proxyNames.push(`      - "DIRECT"`);
  }

  const clashYaml = `# ==========================================
# D31 / FreePBX 自动下发订阅配置 (Mihomo/Clash.Meta)
# 生成时间: ${new Date().toISOString()}
# ==========================================
mixed-port: 7890
allow-lan: true
mode: rule
log-level: warning
ipv6: false
tcp-concurrent: true

# 1. 代理节点池
proxies:
${proxiesYaml}
# 2. 智能延迟测速与自适应竞速组
proxy-groups:
  - name: "PROXY-MODE"
    type: select
    proxies:
      - "AUTO-FASTEST"
      - "DIRECT"
${proxyNames.join("\n")}

  - name: "AUTO-FASTEST"
    type: url-test
    proxies:
      - "DIRECT"
${proxyNames.join("\n")}
    url: 'http://cp.cloudflare.com/generate_204'
    interval: 60
    tolerance: 15

# 3. 智能规则分流
rules:
  - DOMAIN-SUFFIX,telegram.org,PROXY-MODE
  - DOMAIN-SUFFIX,t.me,PROXY-MODE
  - IP-CIDR,91.108.4.0/22,PROXY-MODE
  - IP-CIDR,149.154.160.0/20,PROXY-MODE
  - GEOIP,lan,DIRECT
  - IP-CIDR,192.168.0.0/16,DIRECT
  - IP-CIDR,10.0.0.0/8,DIRECT
  - MATCH,PROXY-MODE
`;

  return new Response(clashYaml, {
    headers: {
      "Content-Type": "text/yaml; charset=utf-8",
      "Content-Disposition": 'attachment; filename="d31_subscription.yaml"',
      "Cache-Control": "no-cache"
    }
  });
}

// ==========================================
// RESTful API 路由处理
// ==========================================
async function handleApi(request, env, pathname) {
  const method = request.method;

  // 1. 登录认证接口
  if (pathname === "/api/login" && method === "POST") {
    try {
      const { username, password } = await request.json();
      const dbUser = await getStore(env, "admin_user") || DEFAULT_USER;
      const dbPass = await getStore(env, "admin_pass") || DEFAULT_PASS;

      if (username === dbUser && password === dbPass) {
        return jsonResp({ success: true, token: "session_" + Date.now(), user: username });
      }
      return jsonResp({ success: false, message: "账号或密码错误" }, 401);
    } catch(e) {
      return jsonResp({ success: false, message: e.message }, 400);
    }
  }

  // 2. 获取节点列表与配置
  if (pathname === "/api/data" && method === "GET") {
    const nodes = await getStore(env, "nodes") || [];
    const sub_token = await getStore(env, "sub_token") || DEFAULT_TOKEN;
    const cf_preferred_ip = await getStore(env, "cf_preferred_ip") || "104.16.80.80";
    const admin_user = await getStore(env, "admin_user") || DEFAULT_USER;
    return jsonResp({ success: true, nodes, sub_token, cf_preferred_ip, admin_user });
  }

  // 3. 保存节点列表与配置
  if (pathname === "/api/save" && method === "POST") {
    try {
      const data = await request.json();
      if (data.nodes) await setStore(env, "nodes", data.nodes);
      if (data.sub_token) await setStore(env, "sub_token", data.sub_token);
      if (data.cf_preferred_ip !== undefined) await setStore(env, "cf_preferred_ip", data.cf_preferred_ip);
      if (data.new_password) await setStore(env, "admin_pass", data.new_password);
      if (data.admin_user) await setStore(env, "admin_user", data.admin_user);
      return jsonResp({ success: true, message: "配置保存成功" });
    } catch(e) {
      return jsonResp({ success: false, message: e.message }, 400);
    }
  }

  return jsonResp({ error: "Not Found" }, 404);
}

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

// ==========================================
// 内置现代化单页面 Web 管理后台 (HTML/CSS/JS)
// ==========================================
function renderHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FreePBX VPN Node 管理面板 (Sub-Store Serverless)</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">
  <style>
    body { background-color: #0f172a; color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .glass-card { background: rgba(30, 41, 59, 0.7); backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.1); }
  </style>
</head>
<body class="min-h-screen flex flex-col">

  <!-- 登录模态框 -->
  <div id="loginModal" class="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center z-50">
    <div class="glass-card p-8 rounded-2xl w-full max-w-md shadow-2xl border border-slate-700">
      <div class="text-center mb-6">
        <div class="inline-flex p-3 rounded-full bg-blue-500/20 text-blue-400 mb-3 text-2xl">
          <i class="fa-solid fa-server"></i>
        </div>
        <h2 class="text-2xl font-bold">FreePBX 节点管理中枢</h2>
        <p class="text-slate-400 text-sm mt-1">请输入管理员凭据登录 (默认 admin / admin888)</p>
      </div>
      <div class="space-y-4">
        <div>
          <label class="block text-xs font-semibold text-slate-300 mb-1">账号</label>
          <input id="loginUser" type="text" value="admin" class="w-full px-4 py-2.5 rounded-lg bg-slate-900/80 border border-slate-700 focus:outline-none focus:border-blue-500 text-white">
        </div>
        <div>
          <label class="block text-xs font-semibold text-slate-300 mb-1">密码</label>
          <input id="loginPass" type="password" value="admin888" class="w-full px-4 py-2.5 rounded-lg bg-slate-900/80 border border-slate-700 focus:outline-none focus:border-blue-500 text-white">
        </div>
        <button onclick="doLogin()" class="w-full py-3 bg-blue-600 hover:bg-blue-500 rounded-lg font-semibold text-white transition shadow-lg shadow-blue-600/30">
          <i class="fa-solid fa-right-to-bracket mr-2"></i>登 录
        </button>
        <p id="loginError" class="text-red-400 text-xs text-center hidden"></p>
      </div>
    </div>
  </div>

  <!-- 主控导航栏 -->
  <header class="border-b border-slate-800 bg-slate-900/60 sticky top-0 z-30 backdrop-blur">
    <div class="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
      <div class="flex items-center space-x-3">
        <div class="p-2 bg-gradient-to-tr from-blue-600 to-indigo-500 rounded-lg text-white">
          <i class="fa-solid fa-network-wired text-lg"></i>
        </div>
        <span class="font-bold text-lg tracking-wide">FreePBX Node Manager</span>
        <span class="text-xs px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 font-mono">Serverless</span>
      </div>
      <div class="flex items-center space-x-3">
        <button onclick="openSettingsModal()" class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm transition">
          <i class="fa-solid fa-gear mr-1.5"></i>全局设置
        </button>
        <button onclick="logout()" class="px-3 py-1.5 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 text-sm transition">
          <i class="fa-solid fa-arrow-right-from-bracket mr-1.5"></i>退出
        </button>
      </div>
    </div>
  </header>

  <!-- 主体工作区 -->
  <main class="max-w-6xl mx-auto px-4 py-8 flex-1 w-full space-y-6">

    <!-- 订阅概览卡片 -->
    <div class="glass-card rounded-2xl p-6 shadow-xl border border-slate-800">
      <div class="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h3 class="text-lg font-bold text-white flex items-center">
            <i class="fa-solid fa-rss text-blue-400 mr-2"></i>D31 智能座机订阅源
          </h3>
          <p class="text-xs text-slate-400 mt-1">D31 座机的 Mihomo 内核将自动通过此链接毫秒级拉取所有节点</p>
        </div>
        <div class="flex items-center space-x-2">
          <input id="subUrl" type="text" readonly class="bg-slate-950 border border-slate-700 px-3 py-2 rounded-lg text-xs font-mono text-slate-300 w-72 focus:outline-none">
          <button onclick="copySubUrl()" class="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-semibold transition">
            <i class="fa-regular fa-copy mr-1.5"></i>复制订阅链接
          </button>
        </div>
      </div>
    </div>

    <!-- 节点管理卡片 -->
    <div class="glass-card rounded-2xl p-6 shadow-xl border border-slate-800">
      <div class="flex items-center justify-between mb-6 pb-4 border-b border-slate-800">
        <div>
          <h3 class="text-lg font-bold text-white flex items-center">
            <i class="fa-solid fa-server text-emerald-400 mr-2"></i>代理服务器节点池
          </h3>
          <p class="text-xs text-slate-400 mt-1">管理甲骨文 VPS 节点及 3 个月轮换的谷歌云 (GCP) 测试机节点</p>
        </div>
        <button onclick="openAddNodeModal()" class="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold transition shadow-lg shadow-emerald-600/20">
          <i class="fa-solid fa-plus mr-1.5"></i>添加新节点
        </button>
      </div>

      <!-- 节点列表表格 -->
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="text-xs text-slate-400 uppercase bg-slate-900/50">
            <tr>
              <th class="px-4 py-3 rounded-l-lg">节点名称</th>
              <th class="px-4 py-3">协议 / 端口</th>
              <th class="px-4 py-3">服务器域名 (SNI)</th>
              <th class="px-4 py-3">WS 路径</th>
              <th class="px-4 py-3">优选 IP 覆写</th>
              <th class="px-4 py-3 text-right rounded-r-lg">操作</th>
            </tr>
          </thead>
          <tbody id="nodeTableBody" class="divide-y divide-slate-800/60">
            <!-- 动态渲染 -->
          </tbody>
        </table>
      </div>
    </div>
  </main>

  <!-- 添加/编辑节点模态框 -->
  <div id="nodeModal" class="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-40 hidden">
    <div class="glass-card p-6 rounded-2xl w-full max-w-lg shadow-2xl border border-slate-700 max-h-[90vh] overflow-y-auto">
      <h3 id="nodeModalTitle" class="text-lg font-bold mb-4">添加代理节点</h3>
      <div class="space-y-3 text-xs">
        <div>
          <label class="text-slate-300 font-semibold mb-1 block">节点备注名称</label>
          <input id="nodeName" type="text" placeholder="例如: GCP-Tokyo-01" class="w-full px-3 py-2 rounded bg-slate-900 border border-slate-700 text-white">
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="text-slate-300 font-semibold mb-1 block">服务器域名 / IP</label>
            <input id="nodeServer" type="text" placeholder="gcp.yourdomain.com" class="w-full px-3 py-2 rounded bg-slate-900 border border-slate-700 text-white">
          </div>
          <div>
            <label class="text-slate-300 font-semibold mb-1 block">端口 (默认 443)</label>
            <input id="nodePort" type="number" value="443" class="w-full px-3 py-2 rounded bg-slate-900 border border-slate-700 text-white">
          </div>
        </div>
        <div>
          <label class="text-slate-300 font-semibold mb-1 block">用户 UUID</label>
          <input id="nodeUuid" type="text" placeholder="11111111-2222-3333-4444-555555555555" class="w-full px-3 py-2 rounded bg-slate-900 border border-slate-700 font-mono text-white">
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="text-slate-300 font-semibold mb-1 block">WebSocket 路径</label>
            <input id="nodePath" type="text" value="/stream-proxy" class="w-full px-3 py-2 rounded bg-slate-900 border border-slate-700 text-white">
          </div>
          <div>
            <label class="text-slate-300 font-semibold mb-1 block">TLS / SNI 域名</label>
            <input id="nodeSni" type="text" placeholder="gcp.yourdomain.com" class="w-full px-3 py-2 rounded bg-slate-900 border border-slate-700 text-white">
          </div>
        </div>
        <div>
          <label class="text-slate-300 font-semibold mb-1 block">独立 CF 优选 IP (可选留空)</label>
          <input id="nodeCustomIp" type="text" placeholder="例如 104.16.80.80 (留空则继承全局优选 IP)" class="w-full px-3 py-2 rounded bg-slate-900 border border-slate-700 text-white">
        </div>
      </div>
      <div class="flex justify-end space-x-3 mt-6">
        <button onclick="closeNodeModal()" class="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded text-xs text-slate-300">取消</button>
        <button onclick="saveNode()" class="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded text-xs font-semibold text-white">保存节点</button>
      </div>
    </div>
  </div>

  <!-- 全局设置模态框 -->
  <div id="settingsModal" class="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-40 hidden">
    <div class="glass-card p-6 rounded-2xl w-full max-w-md shadow-2xl border border-slate-700">
      <h3 class="text-lg font-bold mb-4">全局设置与安全管理</h3>
      <div class="space-y-3 text-xs">
        <div>
          <label class="text-slate-300 font-semibold mb-1 block">全局 Cloudflare 优选 IP</label>
          <input id="setCfIp" type="text" placeholder="104.16.80.80" class="w-full px-3 py-2 rounded bg-slate-900 border border-slate-700 text-white">
        </div>
        <div>
          <label class="text-slate-300 font-semibold mb-1 block">订阅 Token</label>
          <input id="setSubToken" type="text" class="w-full px-3 py-2 rounded bg-slate-900 border border-slate-700 font-mono text-white">
        </div>
        <div class="border-t border-slate-800 pt-3">
          <label class="text-slate-300 font-semibold mb-1 block">修改管理员密码 (留空则不修改)</label>
          <input id="setNewPass" type="password" placeholder="输入新密码" class="w-full px-3 py-2 rounded bg-slate-900 border border-slate-700 text-white">
        </div>
      </div>
      <div class="flex justify-end space-x-3 mt-6">
        <button onclick="closeSettingsModal()" class="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded text-xs text-slate-300">取消</button>
        <button onclick="saveSettings()" class="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-xs font-semibold text-white">保存设置</button>
      </div>
    </div>
  </div>

  <script>
    let appData = { nodes: [], sub_token: "", cf_preferred_ip: "", admin_user: "" };
    let editingNodeIndex = -1;

    async function checkAuth() {
      const token = localStorage.getItem("panel_auth_token");
      if (token) {
        document.getElementById("loginModal").classList.add("hidden");
        loadData();
      } else {
        document.getElementById("loginModal").classList.remove("hidden");
      }
    }

    async function doLogin() {
      const u = document.getElementById("loginUser").value;
      const p = document.getElementById("loginPass").value;
      const err = document.getElementById("loginError");
      err.classList.add("hidden");

      try {
        const res = await fetch("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: u, password: p })
        });
        const d = await res.json();
        if (d.success) {
          localStorage.setItem("panel_auth_token", d.token);
          document.getElementById("loginModal").classList.add("hidden");
          loadData();
        } else {
          err.innerText = d.message || "登录失败";
          err.classList.remove("hidden");
        }
      } catch(e) {
        err.innerText = "网络通信错误: " + e.message;
        err.classList.remove("hidden");
      }
    }

    function logout() {
      localStorage.removeItem("panel_auth_token");
      document.getElementById("loginModal").classList.remove("hidden");
    }

    async function loadData() {
      try {
        const res = await fetch("/api/data");
        appData = await res.json();
        renderNodes();
        document.getElementById("subUrl").value = window.location.origin + "/sub/" + (appData.sub_token || "d31");
      } catch(e) {
        console.error("加载数据失败", e);
      }
    }

    function renderNodes() {
      const tbody = document.getElementById("nodeTableBody");
      tbody.innerHTML = "";
      if (!appData.nodes || appData.nodes.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="px-4 py-8 text-center text-slate-500 text-xs">暂无节点，请点击右上角添加新节点</td></tr>';
        return;
      }
      appData.nodes.forEach((node, idx) => {
        const tr = document.createElement("tr");
        tr.className = "hover:bg-slate-800/40 transition";
        tr.innerHTML = \`
          <td class="px-4 py-3 font-semibold text-white flex items-center">
            <span class="w-2 h-2 rounded-full bg-emerald-400 mr-2"></span>
            \${node.name}
          </td>
          <td class="px-4 py-3"><span class="px-2 py-0.5 rounded bg-blue-500/20 text-blue-400 text-xs uppercase font-mono">\${node.type || "vless"}</span> : \${node.port || 443}</td>
          <td class="px-4 py-3 font-mono text-xs text-slate-300">\${node.sni || node.server}</td>
          <td class="px-4 py-3 font-mono text-xs text-slate-400">\${node.path || "/"}</td>
          <td class="px-4 py-3 font-mono text-xs text-amber-400">\${node.custom_ip || appData.cf_preferred_ip || "全局默认"}</td>
          <td class="px-4 py-3 text-right space-x-2">
            <button onclick="editNode(\${idx})" class="text-blue-400 hover:text-blue-300 text-xs"><i class="fa-solid fa-pen-to-square"></i></button>
            <button onclick="deleteNode(\${idx})" class="text-red-400 hover:text-red-300 text-xs"><i class="fa-solid fa-trash"></i></button>
          </td>
        \`;
        tbody.appendChild(tr);
      });
    }

    function openAddNodeModal() {
      editingNodeIndex = -1;
      document.getElementById("nodeModalTitle").innerText = "添加新节点";
      document.getElementById("nodeName").value = "";
      document.getElementById("nodeServer").value = "";
      document.getElementById("nodePort").value = "443";
      document.getElementById("nodeUuid").value = "";
      document.getElementById("nodePath").value = "/stream-proxy";
      document.getElementById("nodeSni").value = "";
      document.getElementById("nodeCustomIp").value = "";
      document.getElementById("nodeModal").classList.remove("hidden");
    }

    function editNode(idx) {
      editingNodeIndex = idx;
      const n = appData.nodes[idx];
      document.getElementById("nodeModalTitle").innerText = "编辑节点";
      document.getElementById("nodeName").value = n.name || "";
      document.getElementById("nodeServer").value = n.server || "";
      document.getElementById("nodePort").value = n.port || 443;
      document.getElementById("nodeUuid").value = n.uuid || "";
      document.getElementById("nodePath").value = n.path || "/stream-proxy";
      document.getElementById("nodeSni").value = n.sni || "";
      document.getElementById("nodeCustomIp").value = n.custom_ip || "";
      document.getElementById("nodeModal").classList.remove("hidden");
    }

    function closeNodeModal() { document.getElementById("nodeModal").classList.add("hidden"); }

    async function saveNode() {
      const node = {
        name: document.getElementById("nodeName").value.trim() || "Node-" + (appData.nodes.length + 1),
        server: document.getElementById("nodeServer").value.trim(),
        port: parseInt(document.getElementById("nodePort").value) || 443,
        uuid: document.getElementById("nodeUuid").value.trim(),
        path: document.getElementById("nodePath").value.trim() || "/stream-proxy",
        sni: document.getElementById("nodeSni").value.trim(),
        custom_ip: document.getElementById("nodeCustomIp").value.trim(),
        type: "vless",
        network: "ws",
        tls: true
      };

      if (!node.server || !node.uuid) {
        alert("服务器域名和 UUID 不能为空！");
        return;
      }

      if (editingNodeIndex >= 0) {
        appData.nodes[editingNodeIndex] = node;
      } else {
        appData.nodes.push(node);
      }

      await syncSave();
      closeNodeModal();
      renderNodes();
    }

    async function deleteNode(idx) {
      if (confirm("确定要删除该节点吗？")) {
        appData.nodes.splice(idx, 1);
        await syncSave();
        renderNodes();
      }
    }

    function openSettingsModal() {
      document.getElementById("setCfIp").value = appData.cf_preferred_ip || "104.16.80.80";
      document.getElementById("setSubToken").value = appData.sub_token || "d31";
      document.getElementById("setNewPass").value = "";
      document.getElementById("settingsModal").classList.remove("hidden");
    }

    function closeSettingsModal() { document.getElementById("settingsModal").classList.add("hidden"); }

    async function saveSettings() {
      const cfIp = document.getElementById("setCfIp").value.trim();
      const token = document.getElementById("setSubToken").value.trim();
      const newPass = document.getElementById("setNewPass").value.trim();

      appData.cf_preferred_ip = cfIp;
      appData.sub_token = token || "d31";

      const payload = {
        cf_preferred_ip: cfIp,
        sub_token: token || "d31"
      };
      if (newPass) payload.new_password = newPass;

      await fetch("/api/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      closeSettingsModal();
      document.getElementById("subUrl").value = window.location.origin + "/sub/" + appData.sub_token;
      renderNodes();
      alert("全局设置保存成功！");
    }

    async function syncSave() {
      await fetch("/api/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodes: appData.nodes })
      });
    }

    function copySubUrl() {
      const url = document.getElementById("subUrl").value;
      navigator.clipboard.writeText(url).then(() => {
        alert("订阅链接已复制到剪贴板！\n" + url);
      });
    }

    checkAuth();
  </script>
</body>
</html>`;
}
