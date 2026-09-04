// =========================================================================
// elfRadio SIP/VPN Manage - Cloudflare Workers 管理面板与订阅生成器 v2.5.0
// 升级：通话组 + 网关账户 + 分级分机目录
// =========================================================================

import { LOGO_PNG_B64 } from "./logo.js";
import { isPrivateIp, pickLocation, parseGeoCache } from "./remote-location.js";

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
    const on = String(c.status || "").toLowerCase() === "avail" ? "1" : "0";
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
      const bundle = await loadSipBundle(env);
      const osaka = await fetchOsakaStatus(env);
      const status = osaka.status;
      const geo = await geoForStatus(env, status);
      const config_rev = (await getStore(env, "sip_config_rev")) || 0;
      const applied_rev = (status && status.applied_rev) || 0;
      return json({
        ok: true,
        extensions: bundle.extensions,
        groups: bundle.groups,
        gateways: bundle.gateways,
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
      const bundle = await loadSipBundle(env);
      const config_rev = (await getStore(env, "sip_config_rev")) || 0;
      const applied = parseInt(url.searchParams.get("applied") || "0", 10) || 0;
      const pending = Number(config_rev) !== Number(applied);
      const resp = { ok: true, config_rev, applied_rev: applied, pending };
      if (pending) {
        resp.extensions = withPasswords(bundle.extensions, bundle.secrets);
        resp.groups = bundle.groups;
        resp.gateways = withPasswords(bundle.gateways, bundle.secrets);
      }
      return json(resp);
    }

    if (pathname === "/api/sip/save" && method === "POST") {
      try {
        const data = await request.json();
        if (!Array.isArray(data.extensions) || !Array.isArray(data.groups) || !Array.isArray(data.gateways)) {
          return json({ ok: false, msg: "extensions、groups、gateways 都必须是数组" }, 400);
        }
        const secrets = Object.assign({}, (await getStore(env, "sip_secrets")) || {});
        const gwSet = {};
        const gateways = [];
        for (let i = 0; i < data.gateways.length; i++) {
          const src = data.gateways[i] || {};
          const ext = String(src.ext || "").trim();
          if (!/^[0-9]{3,6}$/.test(ext)) {
            return json({ ok: false, msg: "网关分机号必须是 3 到 6 位数字" }, 400);
          }
          if (gwSet[ext]) return json({ ok: false, msg: "网关分机号重复: " + ext }, 400);
          gwSet[ext] = true;
          const item = publicGateway(src, secrets);
          if (src.password) secrets[ext] = String(src.password);
          if (src.clear_password) delete secrets[ext];
          gateways.push(stripSecretFlag(item));
        }
        if (!gateways.length) {
          return json({ ok: false, msg: "至少需要一个网关账户" }, 400);
        }
        const groups = symmetrizeGroups((data.groups || []).map(publicGroup).filter(function (g) { return !!g.id; }));
        const groupIds = {};
        for (let i = 0; i < groups.length; i++) groupIds[groups[i].id] = true;
        const cleaned = [];
        const extSet = {};
        for (let i = 0; i < data.extensions.length; i++) {
          const src = data.extensions[i] || {};
          const ext = String(src.ext || "").trim();
          if (!/^[0-9]{3,6}$/.test(ext)) {
            return json({ ok: false, msg: "分机号必须是 3 到 6 位数字" }, 400);
          }
          if (gwSet[ext]) return json({ ok: false, msg: "分机号与网关重复: " + ext }, 400);
          if (extSet[ext]) return json({ ok: false, msg: "分机号重复: " + ext }, 400);
          extSet[ext] = true;
          const item = publicExtension(src, secrets);
          if (item.group_id && !groupIds[item.group_id]) item.group_id = "";
          if (src.password) secrets[ext] = String(src.password);
          if (src.clear_password) delete secrets[ext];
          cleaned.push(stripSecretFlag(item));
        }
        for (let i = 0; i < groups.length; i++) {
          if (groups[i].gateway && !gwSet[groups[i].gateway]) groups[i].gateway = "";
        }
        const gwFwdErr = validateGatewayForwards(gateways, cleaned);
        if (gwFwdErr) return json({ ok: false, msg: gwFwdErr }, 400);
        const keep = Object.assign({}, gwSet, extSet);
        Object.keys(secrets).forEach(function (k) { if (!keep[k]) delete secrets[k]; });
        const prevRev = (await getStore(env, "sip_config_rev")) || 0;
        await setStore(env, "sip_extensions", cleaned);
        await setStore(env, "sip_groups", groups);
        await setStore(env, "sip_gateways", gateways);
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

    if (pathname === "/api/device-models" && method === "GET") {
      return json({ ok: true, models: await loadDeviceModels(env) });
    }
    if (pathname === "/api/device-models" && method === "POST") {
      return handleDeviceModelSave(env, request);
    }
    if (pathname === "/api/devices" && method === "GET") {
      const devices = await loadDevicesHydrated(env);
      return json({ ok: true, devices });
    }
    if (pathname === "/api/devices" && method === "POST") {
      return handleDeviceCreate(env, request);
    }
    if (pathname === "/api/devices/update" && method === "POST") {
      return handleDeviceUpdate(env, request);
    }
    if (pathname === "/api/devices/delete" && method === "POST") {
      return handleDeviceDelete(env, request);
    }
    if (pathname === "/api/devices/pair" && method === "POST") {
      return json({ ok: false, msg: "等待设备端，请先用手工登记" }, 400);
    }

    if (pathname === "/sip" || pathname === "/sip/") {
      return new Response(renderSipHtml(), {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    if (pathname === "/devices" || pathname === "/devices/") {
      return new Response(renderDevicesHtml(), {
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
    ["203", "H13", true, false]
  ];
  return rows.map(function (r) {
    return publicExtension({
      ext: r[0],
      name: r[1],
      outbound: r[2],
      sms: r[3]
    }, {});
  });
}

function defaultSipGateways() {
  return [publicGateway({
    ext: "300",
    name: "Pixel3 GSM Gateway",
    public_number: "",
    inbound_fwd: "101",
    sms_fwd: "101"
  }, {})];
}

function publicExtension(x, secrets) {
  const ext = String((x && x.ext) || "").trim();
  const ring = parseInt(x && x.ringtimer, 10);
  return {
    ext: ext,
    name: String((x && x.name) || "").trim(),
    outbound: (x && x.outbound) !== false,
    sms: (x && x.sms) != null ? !!x.sms : ext === "101",
    group_id: String((x && x.group_id) || "").trim(),
    cf: String((x && x.cf) || "").trim(),
    cf_busy: String((x && x.cf_busy) || "").trim(),
    cf_noreply: String((x && x.cf_noreply) || "").trim(),
    ringtimer: ring > 0 ? ring : 60,
    has_password: !!(secrets && secrets[ext])
  };
}

function validateGatewayForwards(gateways, extensions) {
  const byExt = {};
  for (let i = 0; i < extensions.length; i++) byExt[String(extensions[i].ext)] = extensions[i];
  for (let i = 0; i < gateways.length; i++) {
    const g = gateways[i];
    const inn = String(g.inbound_fwd || "").trim();
    const sms = String(g.sms_fwd || "").trim();
    if (inn && !byExt[inn]) return "呼入转发目标不是内网分机: " + inn;
    if (sms && !byExt[sms]) return "短信转发目标不是内网分机: " + sms;
    if (inn && sms && inn !== sms) {
      const g1 = String(byExt[inn].group_id || "");
      const g2 = String(byExt[sms].group_id || "");
      if (g1 !== g2) return "网关 " + g.ext + " 的呼入和短信转发必须在同一通话组";
    }
    if (sms && !byExt[sms].sms) return "短信转发目标分机 " + sms + " 需要先打开短信权限";
  }
  return "";
}

function publicGateway(x, secrets) {
  const ext = String((x && x.ext) || "").trim();
  return {
    ext: ext,
    name: String((x && x.name) || "").trim(),
    public_number: String((x && x.public_number) || "").trim(),
    inbound_fwd: String((x && x.inbound_fwd) || "").trim(),
    sms_fwd: String((x && x.sms_fwd) || "").trim(),
    has_password: !!(secrets && secrets[ext])
  };
}

function publicGroup(x) {
  const pol = (x && x.internal) || "self";
  const internal = (pol === "peers" || pol === "all" || pol === "self") ? pol : "self";
  const peers = Array.isArray(x && x.peers) ? x.peers.map(function (id) { return String(id || "").trim(); }).filter(Boolean) : [];
  return {
    id: String((x && x.id) || "").trim(),
    name: String((x && x.name) || "").trim(),
    internal: internal,
    peers: peers,
    gateway: String((x && x.gateway) || "").trim()
  };
}

function stripSecretFlag(item) {
  const o = Object.assign({}, item);
  delete o.has_password;
  delete o.password;
  return o;
}

function symmetrizeGroups(groups) {
  const byId = {};
  for (let i = 0; i < groups.length; i++) byId[groups[i].id] = groups[i];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (g.internal !== "peers") {
      g.peers = [];
      continue;
    }
    const next = [];
    for (let j = 0; j < g.peers.length; j++) {
      const pid = g.peers[j];
      if (!pid || pid === g.id || !byId[pid]) continue;
      next.push(pid);
      const o = byId[pid];
      o.internal = "peers";
      if (o.peers.indexOf(g.id) < 0) o.peers.push(g.id);
    }
    g.peers = next;
  }
  return groups;
}

async function loadSipBundle(env) {
  const secrets = (await getStore(env, "sip_secrets")) || {};
  let raw = await getStore(env, "sip_extensions");
  if (!Array.isArray(raw)) raw = defaultSipExtensions();
  let groups = await getStore(env, "sip_groups");
  let gateways = await getStore(env, "sip_gateways");
  let persist = false;
  if (!Array.isArray(gateways)) {
    gateways = [];
    const kept = [];
    for (let i = 0; i < raw.length; i++) {
      const x = raw[i];
      if (String(x.ext) === "300") {
        gateways.push({
          ext: "300",
          name: x.name || "Pixel3 GSM Gateway",
          public_number: "",
          inbound_fwd: "101",
          sms_fwd: "101"
        });
      } else kept.push(x);
    }
    raw = kept;
    persist = true;
  }
  if (!Array.isArray(groups)) {
    groups = [];
    persist = true;
  }
  const gwSet = {};
  gateways = gateways.map(function (g) { return publicGateway(g, secrets); });
  for (let i = 0; i < gateways.length; i++) gwSet[gateways[i].ext] = true;
  raw = raw.filter(function (x) { return !gwSet[String(x.ext)]; });
  groups = symmetrizeGroups(groups.map(publicGroup).filter(function (g) { return !!g.id; }));
  const extensions = raw.map(function (x) { return publicExtension(x, secrets); });
  if (persist) {
    await setStore(env, "sip_extensions", extensions.map(stripSecretFlag));
    await setStore(env, "sip_groups", groups);
    await setStore(env, "sip_gateways", gateways.map(stripSecretFlag));
  }
  return { extensions: extensions, groups: groups, gateways: gateways, secrets: secrets };
}

function withPasswords(list, secrets) {
  return list.map(function (item) {
    const o = Object.assign({}, item);
    const pw = secrets[o.ext];
    if (pw) o.password = pw;
    delete o.has_password;
    return o;
  });
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
    if (cs[i] && String(cs[i].status || "").toLowerCase() === "avail") n++;
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
    const parsed = parseGeoCache(cached);
    if (parsed && parsed.label) {
      geo[ip] = parsed.label;
      continue;
    }
    if (typeof cached === "string" && cached) {
      geo[ip] = cached;
      continue;
    }
    try {
      const looked = await fetchIpGeo(ip);
      if (looked) {
        try { await setStore(env, "geo_" + ip, looked); } catch (e) {}
        geo[ip] = looked.label || "未知";
      } else geo[ip] = "未知";
    } catch (e) {
      geo[ip] = "未知";
    }
  }
  return geo;
}

function newRemoteId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function defaultDeviceModels() {
  return [
    { id: "mdl_d22", name: "D22", icon: "", note: "对讲机" },
    { id: "mdl_h13", name: "H13", icon: "", note: "对讲机" },
    { id: "mdl_d31", name: "D31", icon: "", note: "座机" },
    { id: "mdl_pixel3", name: "Pixel 3", icon: "", note: "网关手机" }
  ];
}

async function loadDeviceModels(env) {
  const raw = await getStore(env, "remote_device_models");
  if (Array.isArray(raw) && raw.length) return raw;
  const models = defaultDeviceModels();
  await setStore(env, "remote_device_models", models);
  return models;
}

async function saveDeviceModels(env, models) {
  await setStore(env, "remote_device_models", models);
}

async function loadDevices(env) {
  const raw = await getStore(env, "remote_devices");
  return Array.isArray(raw) ? raw : [];
}

async function saveDevices(env, list) {
  await setStore(env, "remote_devices", list);
}

async function fetchIpGeo(ip) {
  const r = await fetch("http://ip-api.com/json/" + encodeURIComponent(ip) + "?lang=zh-CN&fields=status,country,regionName,city,lat,lon");
  const j = await r.json();
  if (!j || j.status !== "success" || !Number.isFinite(j.lat) || !Number.isFinite(j.lon)) return null;
  return {
    label: [j.country, j.regionName, j.city].filter(Boolean).join(" "),
    lat: j.lat,
    lng: j.lon
  };
}

async function geoForIp(env, ip) {
  if (!ip || isPrivateIp(ip)) return null;
  const cached = parseGeoCache(await getStore(env, "geo_" + ip));
  if (cached) return cached;
  try {
    const looked = await fetchIpGeo(ip);
    if (looked) {
      try { await setStore(env, "geo_" + ip, looked); } catch (e) {}
      return looked;
    }
  } catch (e) {}
  return null;
}

function publicDevice(d, modelName) {
  return {
    id: d.id,
    name: d.name,
    model_id: d.model_id,
    model_name: modelName || "",
    enabled: d.enabled !== false,
    online: !!d.online,
    last_seen: d.last_seen || null,
    battery: d.battery == null ? null : d.battery,
    network: d.network || "unknown",
    ip: d.ip || "",
    os_version: d.os_version || "",
    app_version: d.app_version || "",
    ready: !!d.ready,
    loc: d.loc || null,
    update: d.update || { state: "", target: "", detail: "" }
  };
}

async function loadDevicesHydrated(env) {
  const models = await loadDeviceModels(env);
  const byId = {};
  for (let i = 0; i < models.length; i++) byId[models[i].id] = models[i];
  const list = await loadDevices(env);
  let dirty = false;
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const d = list[i];
    const m = byId[d.model_id];
    if (!d.loc || !Number.isFinite(Number(d.loc.lat))) {
      const ipGeo = await geoForIp(env, d.ip);
      const loc = pickLocation(d, ipGeo);
      if (loc) {
        d.loc = loc;
        dirty = true;
      }
    }
    out.push(publicDevice(d, m ? m.name : ""));
  }
  if (dirty) await saveDevices(env, list);
  return out;
}

async function handleDeviceModelSave(env, request) {
  try {
    const data = await request.json();
    const models = await loadDeviceModels(env);
    const action = String(data.action || "upsert");
    if (action === "delete") {
      const id = String(data.id || "").trim();
      if (!id) return json({ ok: false, msg: "缺少型号" }, 400);
      const devices = await loadDevices(env);
      for (let i = 0; i < devices.length; i++) {
        if (devices[i].model_id === id) return json({ ok: false, msg: "仍有设备使用该型号，不能删除" }, 400);
      }
      const next = models.filter(function (m) { return m.id !== id; });
      if (next.length === models.length) return json({ ok: false, msg: "未找到该型号" }, 404);
      await saveDeviceModels(env, next);
      return json({ ok: true, models: next });
    }
    const name = String(data.name || "").trim();
    if (!name) return json({ ok: false, msg: "型号名称不能为空" }, 400);
    let id = String(data.id || "").trim();
    const item = {
      id: id || newRemoteId("mdl_"),
      name: name,
      icon: String(data.icon || "").trim(),
      note: String(data.note || "").trim()
    };
    if (id) {
      let found = false;
      for (let i = 0; i < models.length; i++) {
        if (models[i].id === id) { models[i] = item; found = true; break; }
      }
      if (!found) models.push(item);
    } else models.push(item);
    await saveDeviceModels(env, models);
    return json({ ok: true, models: models, model: item });
  } catch (e) {
    return json({ ok: false, msg: e.message }, 400);
  }
}

async function handleDeviceCreate(env, request) {
  try {
    const data = await request.json();
    const name = String(data.name || "").trim();
    const model_id = String(data.model_id || "").trim();
    const ip = String(data.ip || "").trim();
    if (!name) return json({ ok: false, msg: "名称不能为空" }, 400);
    const models = await loadDeviceModels(env);
    let okModel = false;
    for (let i = 0; i < models.length; i++) if (models[i].id === model_id) okModel = true;
    if (!okModel) return json({ ok: false, msg: "请选择已有型号" }, 400);
    const list = await loadDevices(env);
    const row = {
      id: newRemoteId("dev_"),
      name: name,
      model_id: model_id,
      enabled: true,
      online: false,
      last_seen: null,
      battery: null,
      network: "unknown",
      ip: ip,
      os_version: "",
      app_version: "",
      ready: false,
      loc: null,
      update: { state: "", target: "", detail: "" }
    };
    const ipGeo = await geoForIp(env, ip);
    const loc = pickLocation(row, ipGeo);
    if (loc) row.loc = loc;
    list.push(row);
    await saveDevices(env, list);
    return json({ ok: true, device: row });
  } catch (e) {
    return json({ ok: false, msg: e.message }, 400);
  }
}

async function handleDeviceUpdate(env, request) {
  try {
    const data = await request.json();
    const id = String(data.id || "").trim();
    if (!id) return json({ ok: false, msg: "缺少设备" }, 400);
    const list = await loadDevices(env);
    let found = null;
    for (let i = 0; i < list.length; i++) {
      if (list[i].id !== id) continue;
      if (data.name != null) {
        const n = String(data.name).trim();
        if (!n) return json({ ok: false, msg: "名称不能为空" }, 400);
        list[i].name = n;
      }
      if (data.enabled != null) list[i].enabled = !!data.enabled;
      if (data.model_id != null) {
        const mid = String(data.model_id).trim();
        const models = await loadDeviceModels(env);
        let okModel = false;
        for (let j = 0; j < models.length; j++) if (models[j].id === mid) okModel = true;
        if (!okModel) return json({ ok: false, msg: "请选择已有型号" }, 400);
        list[i].model_id = mid;
      }
      if (data.ip != null) {
        list[i].ip = String(data.ip).trim();
        const ipGeo = await geoForIp(env, list[i].ip);
        list[i].loc = pickLocation(list[i], ipGeo);
      }
      found = list[i];
      break;
    }
    if (!found) return json({ ok: false, msg: "未找到该设备" }, 404);
    await saveDevices(env, list);
    return json({ ok: true, device: found });
  } catch (e) {
    return json({ ok: false, msg: e.message }, 400);
  }
}

async function handleDeviceDelete(env, request) {
  try {
    const data = await request.json();
    if (data.confirm !== true) return json({ ok: false, msg: "删除需要确认" }, 400);
    const id = String(data.id || "").trim();
    if (!id) return json({ ok: false, msg: "缺少设备" }, 400);
    const list = await loadDevices(env);
    const next = list.filter(function (d) { return d.id !== id; });
    if (next.length === list.length) return json({ ok: false, msg: "未找到该设备" }, 404);
    await saveDevices(env, next);
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, msg: e.message }, 400);
  }
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
    '<a href="/devices" style="padding:.35rem .7rem;border-radius:.4rem;color:#cbd5e1;text-decoration:none;font-size:.85rem;font-weight:600">设备管理<\/a>',
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
    '.btn-gray:disabled{opacity:.35;cursor:default}',
    '.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;z-index:50}',
    'table{width:100%;border-collapse:collapse}',
    'th{text-align:left;padding:.65rem .7rem;font-size:.8rem;color:#94a3b8;background:rgba(15,23,42,.6);white-space:nowrap}',
    'td{padding:.65rem .7rem;font-size:.85rem;border-top:1px solid #1e293b;vertical-align:middle}',
    'tr.sel td{background:rgba(30,58,95,.55)}',
    'tr.talking td{animation:talkPulse 2.6s ease-in-out infinite;animation-delay:inherit}',
    '@keyframes talkPulse{0%,100%{background-color:rgba(52,211,153,.10)}50%{background-color:rgba(52,211,153,.34)}}',
    '.sip-table,.dir-table{table-layout:fixed;width:100%}',
    '.sip-table th,.sip-table td,.dir-table th,.dir-table td{overflow:hidden}',
    '.dir-table td{height:3.2rem;box-sizing:border-box}',
    '.c-chk{width:40px}',
    '.c-on{width:52px}',
    '.c-ext{width:84px}',
    '.cell2{display:flex;flex-direction:column;justify-content:center;min-height:2.4em}',
    '.cell2a,.cell2b{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.25}',
    '.cell2a{font-family:monospace;font-size:.8rem}',
    '.cell2b{font-size:.75rem;color:#94a3b8;margin-top:.15rem;min-height:1em}',
    '.btn-icon{width:32px;height:32px;padding:0;display:inline-flex;align-items:center;justify-content:center;background:#334155;color:#e2e8f0;border:none;border-radius:.5rem;cursor:pointer}',
    '.btn-icon:disabled{opacity:.35;cursor:default}',
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
    '<a href="/devices" style="padding:.35rem .7rem;border-radius:.4rem;color:#cbd5e1;text-decoration:none;font-size:.85rem;font-weight:600;white-space:nowrap">设备管理<\/a>',
    '<\/div>',
    '<div style="display:flex;align-items:center;gap:1rem">',
    '<p id="syncHint" style="font-size:.8rem;color:#94a3b8;margin:0;white-space:nowrap">等待同步状态...<\/p>',
    '<button class="btn-gray" style="color:#f87171" onclick="logout()">退出<\/button>',
    '<\/div>',
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
    '<h3 style="font-weight:700;line-height:2.2rem;margin:0">通话组<\/h3>',
    '<div style="display:flex;gap:.5rem;align-items:center">',
    '<button class="btn-green" onclick="openGrp()">+ 添加通话组<\/button>',
    '<button class="btn-gray" onclick="editSelGrp()">编辑<\/button>',
    '<button class="btn-gray" style="color:#f87171" onclick="delSelGrp()">删除<\/button>',
    '<\/div><\/div>',
    '<div style="overflow-x:auto"><table class="sip-table"><colgroup><col class="c-chk"><col class="c-on"><col><col style="width:72px"><col><col style="width:22%"><\/colgroup><thead><tr>',
    '<th><\/th><th><\/th><th>组名<\/th><th>人数<\/th><th>外呼出口<\/th><th>内部通话<\/th>',
    '<\/tr><\/thead><tbody id="gtb"><\/tbody><\/table><\/div><\/div>',

    '<div class="card" style="padding:1.5rem;border-radius:1rem">',
    '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:1rem;gap:1rem">',
    '<h3 style="font-weight:700;line-height:2.2rem;margin:0">网关账户<\/h3>',
    '<div style="display:flex;gap:.5rem;align-items:center">',
    '<button class="btn-green" onclick="openGw()">+ 添加网关<\/button>',
    '<button class="btn-gray" onclick="editSelGw()">编辑<\/button>',
    '<button class="btn-gray" style="color:#f87171" onclick="delSelGw()">删除<\/button>',
    '<\/div><\/div>',
    '<div style="overflow-x:auto"><table class="sip-table"><colgroup><col class="c-chk"><col class="c-on"><col class="c-ext"><col><col><col style="width:90px"><col style="width:90px"><col><col style="width:56px"><col style="width:80px"><\/colgroup><thead><tr>',
    '<th><\/th><th>在线<\/th><th>分机号<\/th><th>名称<\/th><th>公网号码<\/th><th>呼入转发<\/th><th>短信转发<\/th><th>外呼路由<\/th><th>传输<\/th><th>延时<\/th>',
    '<\/tr><\/thead><tbody id="wtb"><\/tbody><\/table><\/div><\/div>',

    '<div class="card" style="padding:1.5rem;border-radius:1rem">',
    '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:1rem;gap:1rem">',
    '<h3 style="font-weight:700;line-height:2.2rem;margin:0">分机目录<\/h3>',
    '<div style="display:flex;gap:.5rem;align-items:center">',
    '<button class="btn-green" onclick="openExt(\'\')">+ 添加分机<\/button>',
    '<button class="btn-gray" onclick="editSelExt()">编辑<\/button>',
    '<button class="btn-gray" style="color:#f87171" onclick="delSelExt()">删除<\/button>',
    '<\/div><\/div>',
    '<div id="groupBoxes" style="display:flex;flex-direction:column;gap:1rem"><\/div>',
    '<\/div>',
    '<\/main>',

    '<div id="extWrap" class="modal-bg" style="display:none">',
    '<div class="card" style="padding:1.5rem;border-radius:1rem;width:100%;max-width:520px;max-height:90vh;overflow:auto">',
    '<h3 id="extTitle" style="font-weight:700;margin-bottom:1rem">添加分机<\/h3>',
    '<div style="display:flex;flex-direction:column;gap:.8rem">',
    '<div><label style="font-size:.8rem;color:#cbd5e1">分机号<\/label><input id="eExt" class="inp"><\/div>',
    '<div><label style="font-size:.8rem;color:#cbd5e1">名称<\/label><input id="eName" class="inp"><\/div>',
    '<div><label style="font-size:.8rem;color:#cbd5e1">密码<\/label><input id="ePw" type="password" class="inp" placeholder="留空则不修改现有密码"><\/div>',
    '<div><label style="font-size:.8rem;color:#cbd5e1">通话组<\/label><select id="eGroup" class="inp"><\/select><\/div>',
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

    '<div id="grpWrap" class="modal-bg" style="display:none">',
    '<div class="card" style="padding:1.5rem;border-radius:1rem;width:100%;max-width:520px;max-height:90vh;overflow:auto">',
    '<h3 id="grpTitle" style="font-weight:700;margin-bottom:1rem">添加通话组<\/h3>',
    '<div style="display:flex;flex-direction:column;gap:.8rem">',
    '<div><label style="font-size:.8rem;color:#cbd5e1">组名<\/label><input id="gName" class="inp"><\/div>',
    '<div><label style="font-size:.8rem;color:#cbd5e1">外呼出口<\/label><select id="gGw" class="inp"><\/select><\/div>',
    '<div><label style="font-size:.8rem;color:#cbd5e1">内部通话<\/label><select id="gInt" class="inp" onchange="togglePeers()"><option value="self">仅组内<\/option><option value="peers">指定组（对称）<\/option><option value="all">全部内网<\/option><\/select><\/div>',
    '<div id="gPeerBox" style="display:none"><label style="font-size:.8rem;color:#cbd5e1">可互打的组<\/label><div id="gPeers" style="display:flex;flex-direction:column;gap:.35rem;margin-top:.4rem"><\/div><\/div>',
    '<\/div>',
    '<div style="display:flex;justify-content:flex-end;gap:.5rem;margin-top:1.2rem">',
    '<button class="btn-gray" onclick="hide(\'grpWrap\')">取消<\/button>',
    '<button class="btn-green" onclick="saveGrp()">保存并同步<\/button>',
    '<\/div><\/div><\/div>',

    '<div id="gwWrap" class="modal-bg" style="display:none">',
    '<div class="card" style="padding:1.5rem;border-radius:1rem;width:100%;max-width:520px;max-height:90vh;overflow:auto">',
    '<h3 id="gwTitle" style="font-weight:700;margin-bottom:1rem">添加网关<\/h3>',
    '<div style="display:flex;flex-direction:column;gap:.8rem">',
    '<div><label style="font-size:.8rem;color:#cbd5e1">分机号<\/label><input id="wExt" class="inp"><\/div>',
    '<div><label style="font-size:.8rem;color:#cbd5e1">名称<\/label><input id="wName" class="inp"><\/div>',
    '<div><label style="font-size:.8rem;color:#cbd5e1">密码<\/label><input id="wPw" type="password" class="inp" placeholder="留空则不修改现有密码"><\/div>',
    '<div><label style="font-size:.8rem;color:#cbd5e1">公网电话号码<\/label><input id="wNum" class="inp" placeholder="例如 +61412345678"><\/div>',
    '<div><label style="font-size:.8rem;color:#cbd5e1">呼入转发到<\/label><select id="wIn" class="inp" onchange="onInFwdChange()"><\/select><\/div>',
    '<div><label style="font-size:.8rem;color:#cbd5e1">短信转发到<\/label><select id="wSms" class="inp"><\/select><\/div>',
    '<p style="font-size:.75rem;color:#94a3b8;margin:0">电话和短信可以转到不同分机，但必须同一通话组。D31 无短信时，把短信转到同组另一个账户；该账户需打开短信权限，且不要和话机抢同一个 SIP 登录。<\/p>',
    '<div><label style="font-size:.8rem;color:#94a3b8">被哪些组当出口（只读，在通话组里指定）<\/label><div id="wUsed" style="font-size:.85rem;color:#cbd5e1;margin-top:.3rem">无<\/div><\/div>',
    '<\/div>',
    '<div style="display:flex;justify-content:flex-end;gap:.5rem;margin-top:1.2rem">',
    '<button class="btn-gray" onclick="hide(\'gwWrap\')">取消<\/button>',
    '<button class="btn-green" onclick="saveGw()">保存并同步<\/button>',
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
    sipClientJs(),
    '<\/script>',
    '<\/body>',
    '<\/html>'
  ].join('\n');
}

function renderDevicesHtml() {
  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<title>elfRadio SIP/VPN Manage</title>',
    '<link rel="icon" type="image/png" href="/logo.png">',
    '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css">',
    '<script src="https://cdn.tailwindcss.com"><\/script>',
    '<script src="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js"><\/script>',
    '<style>',
    'body{background:#0f172a;color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0}',
    '.card{background:rgba(30,41,59,.7);border:1px solid rgba(255,255,255,.1);backdrop-filter:blur(12px)}',
    '.inp{width:100%;padding:.6rem .9rem;border-radius:.5rem;background:#0f172a;border:1px solid #334155;color:#fff;outline:none;box-sizing:border-box}',
    '.btn-blue{padding:.55rem 1.1rem;background:#2563eb;color:#fff;border-radius:.5rem;cursor:pointer;font-weight:600;border:none;font-size:.85rem}',
    '.btn-green{padding:.5rem 1rem;background:#059669;color:#fff;border-radius:.5rem;cursor:pointer;font-weight:600;border:none;font-size:.8rem}',
    '.btn-add{padding:.25rem .65rem;font-size:.8rem}',
    '.btn-gray{padding:.4rem .8rem;background:#334155;color:#cbd5e1;border-radius:.5rem;cursor:pointer;border:none;font-size:.8rem}',
    '.btn-gray:disabled{opacity:.35;cursor:default}',
    '.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;z-index:50}',
    '.muted{color:#94a3b8;font-size:.85rem}',
    '.dot{display:inline-block;width:12px;height:12px;border-radius:50%;flex-shrink:0;box-shadow:0 0 0 3px rgba(255,255,255,.08)}',
    '.dot-on{background:#22c55e}.dot-off{background:#64748b}',
    '.layout{display:grid;grid-template-columns:220px 1fr;grid-template-rows:minmax(300px,40vh) auto;gap:1rem}',
    '@media(max-width:800px){.layout{grid-template-columns:1fr;grid-template-rows:auto 320px auto}}',
    '#devList{overflow:auto;padding:.4rem}',
    '.dev-row{display:flex;align-items:center;gap:.55rem;padding:.55rem .65rem;border-radius:.5rem;cursor:pointer}',
    '.dev-row:hover{background:rgba(30,58,95,.4)}',
    '.dev-row.sel{background:rgba(30,58,95,.7)}',
    '.dev-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.9rem}',
    '.tag{font-size:.7rem;color:#fbbf24;border:1px solid #fbbf24;border-radius:.3rem;padding:0 .3rem}',
    '#devMap{height:100%;min-height:320px;border-radius:.8rem;background:#0b1220}',
    '.leaflet-container{background:#0b1220;font:inherit}',
    '#devOps{grid-column:1/-1;padding:.85rem 1.1rem 1rem}',
    '.ops-head{display:flex;align-items:center;gap:.6rem;margin-bottom:.65rem;flex-wrap:wrap}',
    '.ops-head-left{display:flex;align-items:baseline;gap:.55rem;min-width:0;flex:1}',
    '.ops-head h3{margin:0;font-size:1.05rem;white-space:nowrap}',
    '.ops-head-actions{display:flex;flex-wrap:wrap;gap:.4rem;align-items:center;margin-left:auto}',
    '.ops-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.55rem}',
    '@media(max-width:800px){.ops-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}',
    '.kv{background:rgba(15,23,42,.55);border:1px solid #1e293b;border-radius:.5rem;padding:.41rem .7rem}',
    '.kv .k{font-size:.75rem;color:#94a3b8}',
    '.kv .v{margin-top:.21rem;font-size:.9rem;word-break:break-all;line-height:1.3}',
    '.ops-sec-title{font-size:.75rem;color:#94a3b8;margin:0 0 .35rem}',
    '.ops-actions{display:flex;flex-wrap:wrap;gap:.45rem;align-items:center}',
    '.ops-head-actions .btn-gray:disabled,.fn-page .btn-gray:disabled,.fn-page .btn-green:disabled,.fn-page textarea:disabled,.fn-page input:disabled{opacity:.45;cursor:default}',
    '.fn-menu{display:flex;flex-wrap:nowrap;gap:.55rem;margin:.75rem 0 .65rem;width:100%;box-sizing:border-box}',
    '.fn-btn{flex:1 1 0;min-width:0;display:flex;flex-direction:row;align-items:center;justify-content:center;gap:.4rem;padding:.42rem .35rem;background:#1e293b;border:1px solid #334155;border-radius:.55rem;color:#e2e8f0;cursor:pointer;font-size:.8rem;font-weight:600;white-space:nowrap}',
    '.fn-btn:hover{border-color:#60a5fa;background:#1e3a5f}',
    '.fn-btn.on{border-color:#3b82f6;background:#1e3a5f;color:#93c5fd}',
    '.fn-ico{width:18px;height:18px;flex-shrink:0;display:block}',
    '@media(max-width:1100px){.fn-btn{font-size:.72rem;padding:.38rem .2rem;gap:.28rem}.fn-ico{width:16px;height:16px}}',
    '@media(max-width:800px){.fn-menu{overflow-x:auto}}',
    '.fn-page{background:rgba(15,23,42,.45);border:1px solid #1e293b;border-radius:.7rem;padding:.9rem 1rem;min-height:160px}',
    '.fn-page h4{margin:0 0 .35rem;font-size:.95rem}',
    '.fn-page textarea.inp{min-height:72px;resize:vertical}',
    '.fn-wait{color:#fbbf24;font-size:.8rem;margin:.35rem 0 .6rem}',
    '.lost-bar{display:flex;flex-wrap:wrap;gap:.45rem;margin-bottom:.65rem}',
    '.fn-live{min-height:140px;border-radius:.6rem;background:#0b1220;border:1px solid #1e293b;color:#94a3b8;display:flex;align-items:center;justify-content:center;margin-bottom:.2rem}',
    'table{width:100%;border-collapse:collapse}',
    'th{text-align:left;padding:.5rem;font-size:.8rem;color:#94a3b8}',
    'td{padding:.5rem;font-size:.85rem;border-top:1px solid #1e293b}',
    '<\/style><\/head><body>',
    '<div id="loginWrap" class="modal-bg">',
    '<div class="card" style="padding:2rem;border-radius:1rem;width:100%;max-width:420px">',
    '<div style="text-align:center;margin-bottom:1rem">',
    '<img src="/logo.png" alt="elfRadio" width="56" height="56" style="width:56px;height:56px;border-radius:.7rem;object-fit:cover;margin-bottom:.5rem">',
    '<h2 style="font-size:1.3rem;font-weight:700">elfRadio SIP/VPN Manage<\/h2>',
    '<p style="font-size:.8rem;color:#94a3b8;margin-top:.3rem">设备管理登录<\/p>',
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
    '<a href="/sip" style="padding:.35rem .7rem;border-radius:.4rem;color:#cbd5e1;text-decoration:none;font-size:.85rem;font-weight:600;white-space:nowrap">SIP 管理<\/a>',
    '<a href="/devices" style="padding:.35rem .7rem;border-radius:.4rem;background:#1e3a5f;color:#93c5fd;text-decoration:none;font-size:.85rem;font-weight:600;white-space:nowrap">设备管理<\/a>',
    '<\/div>',
    '<div><button class="btn-gray" style="color:#f87171" onclick="logout()">退出<\/button><\/div>',
    '<\/div><\/header>',
    '<main style="max-width:1280px;margin:1.2rem auto;padding:0 1.5rem">',
    '<div class="layout">',
    '<div class="card" style="border-radius:1rem;display:flex;flex-direction:column;min-height:0">',
    '<div style="display:flex;justify-content:space-between;align-items:center;padding:.75rem .8rem 0">',
    '<h3 style="margin:0;font-size:.95rem">设备<\/h3>',
    '<button class="btn-green btn-add" onclick="openAdd()">添加设备<\/button>',
    '<\/div>',
    '<div id="devList"><\/div><\/div>',
    '<div class="card" style="border-radius:1rem;overflow:hidden;min-height:0">',
    '<div id="devMap"><\/div><\/div>',
    '<div class="card" id="devOps" style="border-radius:1rem">',
    '<div class="ops-head"><h3>功能设置<\/h3><span class="muted">请先从左侧选择设备，或点「添加设备」<\/span><\/div>',
    '<\/div>',
    '<\/div><\/main>',
    '<div id="addWrap" class="modal-bg" style="display:none">',
    '<div class="card" style="padding:1.4rem;border-radius:1rem;width:100%;max-width:460px">',
    '<h3 style="margin:0 0 1rem;font-size:1.05rem">添加设备<\/h3>',
    '<p class="muted" style="margin:.2rem 0 .5rem">手工登记<\/p>',
    '<div style="display:flex;flex-direction:column;gap:.55rem">',
    '<input id="dName" class="inp" placeholder="名称">',
    '<select id="dModel" class="inp"><\/select>',
    '<input id="dIp" class="inp" placeholder="公网 IP（可选，用于粗定位）">',
    '<button class="btn-green" onclick="saveManual()">保存登记<\/button>',
    '<p id="addErr" style="color:#f87171;font-size:.8rem;min-height:1em"><\/p>',
    '<\/div>',
    '<hr style="border:none;border-top:1px solid #1e293b;margin:1rem 0">',
    '<p class="muted" style="margin:.2rem 0 .5rem">六位配对（请看机子屏幕）<\/p>',
    '<input id="pairCode" class="inp" placeholder="六位码" style="margin-bottom:.5rem">',
    '<button class="btn-gray" onclick="submitPair()">提交配对码<\/button>',
    '<p id="pairErr" style="color:#fbbf24;font-size:.8rem;margin-top:.4rem"><\/p>',
    '<div style="text-align:right;margin-top:1rem"><button class="btn-gray" onclick="closeAdd()">关闭<\/button><\/div>',
    '<\/div><\/div>',
    '<div id="editWrap" class="modal-bg" style="display:none">',
    '<div class="card" style="padding:1.4rem;border-radius:1rem;width:100%;max-width:420px">',
    '<h3 style="margin:0 0 1rem;font-size:1.05rem">编辑设备<\/h3>',
    '<div style="display:flex;flex-direction:column;gap:.55rem">',
    '<input id="edName" class="inp" placeholder="名称">',
    '<select id="edModel" class="inp"><\/select>',
    '<button class="btn-green" onclick="saveEdit()">保存<\/button>',
    '<p id="edErr" style="color:#f87171;font-size:.8rem;min-height:1em"><\/p>',
    '<\/div>',
    '<div style="text-align:right;margin-top:.8rem"><button class="btn-gray" onclick="closeEdit()">关闭<\/button><\/div>',
    '<\/div><\/div>',
    '<script>',
    devicesClientJs(),
    '<\/script>',
    '<\/body><\/html>'
  ].join("\n");
}

function devicesClientJs() {
  return "var DEV = [];\nvar MODELS = [];\nvar selDev = \"\";\nvar selFn = \"adb\";\nvar map = null;\nvar markers = {};\nvar circles = {};\nvar UI = {};\n\nvar FN_ITEMS = [\n  [\"adb\", \"远程ADB\", '<rect x=\"3\" y=\"4\" width=\"18\" height=\"14\" rx=\"2\"></rect><path d=\"M8 20h8M12 18v2\"></path><path d=\"M7 10h.01M10 10h6\"></path>'],\n  [\"update\", \"更新客户端\", '<path d=\"M21 12a9 9 0 1 1-3-6.7\"></path><polyline points=\"21 3 21 9 15 9\"></polyline>'],\n  [\"wifi\", \"配置Wi-Fi\", '<path d=\"M5 12.5a9 9 0 0 1 14 0\"></path><path d=\"M8.5 16a5 5 0 0 1 7 0\"></path><circle cx=\"12\" cy=\"20\" r=\"1\"></circle>'],\n  [\"contacts\", \"通信录\", '<path d=\"M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2\"></path><circle cx=\"12\" cy=\"7\" r=\"4\"></circle>'],\n  [\"locate\", \"立即定位\", '<path d=\"M12 21s7-6 7-11a7 7 0 1 0-14 0c0 5 7 11 7 11z\"></path><circle cx=\"12\" cy=\"10\" r=\"2.5\"></circle>'],\n  [\"alarm\", \"播放警报\", '<path d=\"M11 5a1 1 0 0 1 2 0v1.1A7 7 0 0 1 19 13v4l1.5 2H3.5L5 17v-4a7 7 0 0 1 6-6.9V5z\"></path><path d=\"M9 21h6\"></path>'],\n  [\"lost\", \"丢失模式\", '<path d=\"M12 3l8 4v5c0 5-3.5 8.5-8 9.5C7.5 20.5 4 17 4 12V7l8-4z\"></path>'],\n  [\"model\", \"添加型号\", '<rect x=\"3\" y=\"3\" width=\"7\" height=\"7\" rx=\"1\"></rect><rect x=\"14\" y=\"3\" width=\"7\" height=\"7\" rx=\"1\"></rect><rect x=\"3\" y=\"14\" width=\"7\" height=\"7\" rx=\"1\"></rect><path d=\"M17 14v8M14 18h8\"></path>']\n];\n\nfunction $(id){ return document.getElementById(id); }\nfunction show(id){ $(id).style.display = \"flex\"; }\nfunction hide(id){ $(id).style.display = \"none\"; }\nfunction sydney(iso){\n  if(!iso) return \"—\";\n  try {\n    return new Date(iso).toLocaleString(\"zh-CN\", { timeZone: \"Australia/Sydney\", hour12: false });\n  } catch(e){ return String(iso); }\n}\nfunction locLabel(src){\n  if(src===\"gps\") return \"GPS\";\n  if(src===\"wifi\") return \"Wi-Fi\";\n  if(src===\"cell\") return \"基站\";\n  if(src===\"ip\") return \"IP 大致区域\";\n  return \"未知\";\n}\nfunction modelName(id){\n  for(var i=0;i<MODELS.length;i++) if(MODELS[i].id===id) return MODELS[i].name;\n  return id || \"—\";\n}\nfunction currentDev(){\n  for(var i=0;i<DEV.length;i++) if(DEV[i].id===selDev) return DEV[i];\n  return null;\n}\nfunction deviceReady(){\n  var d = currentDev();\n  return !!(d && d.enabled !== false);\n}\nfunction disAttr(){ return deviceReady() ? \"\" : \" disabled\"; }\nfunction nowIso(){ return new Date().toISOString(); }\nfunction uiOf(){\n  var d = currentDev();\n  if(!d) return null;\n  if(!UI[d.id]){\n    UI[d.id] = {\n      loc: [],\n      alarm: [],\n      wifi: [],\n      wifiSel: \"\",\n      wifiLastOk: \"\",\n      contacts: [],\n      updates: [],\n      photos: [],\n      recs: [],\n      adb: { state: \"未连接\", port: \"\", cmd: \"\" },\n      talk: false,\n      live: \"\"\n    };\n  }\n  return UI[d.id];\n}\n\nfunction checkAuth(){\n  if(localStorage.getItem(\"_pt\")){ hide(\"loginWrap\"); loadDevices(); }\n  else show(\"loginWrap\");\n}\nfunction doLogin(){\n  fetch(\"/api/login\",{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify({username:$(\"lu\").value,password:$(\"lp\").value})})\n  .then(function(r){return r.json();}).then(function(d){\n    if(d.ok){ localStorage.setItem(\"_pt\",\"1\"); hide(\"loginWrap\"); loadDevices(); }\n    else { $(\"lerr\").style.display=\"block\"; $(\"lerr\").innerText=d.msg||\"登录失败\"; }\n  }).catch(function(){ $(\"lerr\").style.display=\"block\"; $(\"lerr\").innerText=\"登录失败\"; });\n}\nfunction logout(){ localStorage.removeItem(\"_pt\"); location.href=\"/\"; }\n\nfunction loadDevices(){\n  Promise.all([\n    fetch(\"/api/devices\").then(function(r){return r.json();}),\n    fetch(\"/api/device-models\").then(function(r){return r.json();})\n  ]).then(function(arr){\n    if(arr[0].devices) DEV = arr[0].devices;\n    if(arr[1].models) MODELS = arr[1].models;\n    if(!currentDev() && DEV.length) selDev = DEV[0].id;\n    renderList();\n    renderMap();\n    renderOps();\n  }).catch(function(){});\n}\n\nfunction renderList(){\n  var box = $(\"devList\");\n  if(!DEV.length){\n    box.innerHTML = '<p class=\"muted\">还没有设备</p>';\n    return;\n  }\n  var h = \"\";\n  for(var i=0;i<DEV.length;i++){\n    var d = DEV[i];\n    var on = d.online && d.enabled!==false;\n    var cls = \"dev-row\" + (d.id===selDev ? \" sel\" : \"\");\n    var upd = d.update && d.update.state ? '<span class=\"tag\">升级中</span>' : \"\";\n    h += '<div class=\"'+cls+'\" onclick=\"selectDev(\\''+d.id+'\\')\">';\n    h += '<span class=\"dot '+(on?\"dot-on\":\"dot-off\")+'\"></span>';\n    h += '<span class=\"dev-name\">'+esc(d.name)+'</span>'+upd;\n    h += '</div>';\n  }\n  box.innerHTML = h;\n}\n\nfunction esc(s){\n  return String(s||\"\").replace(/[&<>\"']/g, function(c){\n    return ({ \"&\":\"&amp;\",\"<\":\"&lt;\",\">\":\"&gt;\",\"\\\"\":\"&quot;\",\"'\":\"&#39;\" })[c];\n  });\n}\n\nfunction selectDev(id){\n  selDev = id;\n  renderList();\n  renderOps();\n  flyTo(id);\n}\n\nfunction initMap(){\n  if(map || typeof L === \"undefined\") return;\n  map = L.map(\"devMap\", { zoomControl: true, attributionControl: true }).setView([-33.87, 151.21], 4);\n  L.tileLayer(\"https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png\", {\n    maxZoom: 19,\n    attribution: \"&copy; OpenStreetMap\"\n  }).addTo(map);\n}\n\nfunction markerHtml(d, selected){\n  var on = d.online && d.enabled!==false;\n  var gps = d.loc && d.loc.source===\"gps\";\n  var color = !d.enabled ? \"#64748b\" : (on ? (gps ? \"#22c55e\" : \"#38bdf8\") : \"#94a3b8\");\n  var fill = gps ? color : \"transparent\";\n  var ring = selected ? \"0 0 0 3px #93c5fd\" : \"0 0 0 2px rgba(15,23,42,.8)\";\n  return '<div style=\"width:16px;height:16px;border-radius:50%;background:'+fill+';border:3px solid '+color+';box-shadow:'+ring+'\"></div>';\n}\n\nfunction renderMap(){\n  initMap();\n  if(!map) return;\n  setTimeout(function(){ map.invalidateSize(); }, 50);\n  Object.keys(markers).forEach(function(k){ map.removeLayer(markers[k]); });\n  Object.keys(circles).forEach(function(k){ map.removeLayer(circles[k]); });\n  markers = {}; circles = {};\n  var bounds = [];\n  for(var i=0;i<DEV.length;i++){\n    var d = DEV[i];\n    if(!d.loc || !isFinite(d.loc.lat) || !isFinite(d.loc.lng)) continue;\n    var ll = [d.loc.lat, d.loc.lng];\n    bounds.push(ll);\n    var acc = Number(d.loc.acc_m) || (d.loc.source===\"gps\" ? 40 : 25000);\n    var gps = d.loc.source===\"gps\";\n    var col = d.online && d.enabled!==false ? (gps ? \"#22c55e\" : \"#38bdf8\") : \"#94a3b8\";\n    circles[d.id] = L.circle(ll, {\n      radius: acc,\n      color: col,\n      weight: gps ? 1 : 1,\n      fillColor: col,\n      fillOpacity: gps ? 0.12 : 0.15\n    }).addTo(map);\n    var ic = L.divIcon({ className: \"\", html: markerHtml(d, d.id===selDev), iconSize: [16,16], iconAnchor: [8,8] });\n    (function(id){\n      markers[id] = L.marker(ll, { icon: ic }).addTo(map).on(\"click\", function(){ selectDev(id); });\n    })(d.id);\n    var bat = d.battery==null ? \"—\" : (d.battery+\"%\");\n    markers[d.id].bindPopup(\n      \"<b>\"+esc(d.name)+\"</b><br>电量 \"+bat+\"<br>IP \"+esc(d.ip||\"—\")+\"<br>\"+locLabel(d.loc.source)+\"<br>\"+sydney(d.loc.at)\n    );\n  }\n  if(bounds.length) map.fitBounds(bounds, { padding: [40,40], maxZoom: 14 });\n}\n\nfunction flyTo(id){\n  var d = null;\n  for(var i=0;i<DEV.length;i++) if(DEV[i].id===id) d = DEV[i];\n  if(!d || !d.loc || !map) { renderMap(); return; }\n  renderMap();\n  map.flyTo([d.loc.lat, d.loc.lng], d.loc.source===\"gps\" ? 14 : 10, { duration: 0.6 });\n  if(markers[id]) markers[id].openPopup();\n}\n\nfunction kv(k,v){ return '<div class=\"kv\"><div class=\"k\">'+k+'</div><div class=\"v\">'+esc(v)+'</div></div>'; }\n\nfunction pickFn(id){\n  selFn = id;\n  renderOps();\n}\n\nfunction onFnClick(ev){\n  var t = ev.target;\n  while(t && t !== ev.currentTarget && !t.getAttribute(\"data-fn\")) t = t.parentNode;\n  if(!t || !t.getAttribute(\"data-fn\")) return;\n  pickFn(t.getAttribute(\"data-fn\"));\n}\n\nfunction renderOps(){\n  var box = $(\"devOps\");\n  var d = currentDev();\n  var dis = d ? \"\" : \" disabled\";\n  var bat = !d || d.battery==null ? \"—\" : (d.battery+\"%\");\n  var net = !d ? \"—\" : (d.network===\"wifi\" ? \"Wi-Fi\" : (d.network===\"cellular\" ? \"移动数据\" : \"未知\"));\n  var src = d && d.loc ? locLabel(d.loc.source) : \"—\";\n  var online = !d ? \"—\" : (d.online ? \"在线\" : (d.enabled===false ? \"已停用\" : \"未接入\"));\n  var h = \"\";\n  h += '<div class=\"ops-head\"><div class=\"ops-head-left\"><h3>功能设置</h3>';\n  if(d) h += '<span class=\"muted\">'+esc(d.name)+\" · \"+esc(d.model_name||modelName(d.model_id))+\"</span>\";\n  else h += '<span class=\"muted\">请先从左侧选择设备，或点「添加设备」</span>';\n  h += '</div><div class=\"ops-head-actions\">';\n  h += '<button class=\"btn-gray\" onclick=\"openEdit()\"'+dis+'>编辑</button>';\n  if(d && d.enabled===false) h += '<button class=\"btn-gray\" onclick=\"setEnabled(true)\">启用</button>';\n  else h += '<button class=\"btn-gray\" onclick=\"setEnabled(false)\"'+dis+'>停用</button>';\n  h += '<button class=\"btn-gray\" style=\"color:#f87171\" onclick=\"delDev()\"'+dis+'>解除配对</button>';\n  h += \"</div></div>\";\n  h += '<div class=\"ops-grid\">';\n  h += kv(\"在线\", online);\n  h += kv(\"电量\", bat);\n  h += kv(\"网络\", net);\n  h += kv(\"IP\", d && d.ip ? d.ip : \"—\");\n  h += kv(\"定位\", src);\n  h += kv(\"系统\", d && d.os_version ? d.os_version : \"—\");\n  h += kv(\"管理程序\", d && d.app_version ? d.app_version : (d ? \"未接入\" : \"—\"));\n  h += kv(\"最后上报\", d ? sydney(d.last_seen) : \"—\");\n  h += \"</div>\";\n  h += '<div class=\"fn-menu\" onclick=\"onFnClick(event)\">';\n  for(var i=0;i<FN_ITEMS.length;i++){\n    var it = FN_ITEMS[i];\n    h += '<button type=\"button\" class=\"fn-btn'+(selFn===it[0]?\" on\":\"\")+'\" data-fn=\"'+it[0]+'\">';\n    h += '<svg class=\"fn-ico\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\">'+it[2]+\"</svg>\";\n    h += \"<span>\"+it[1]+\"</span></button>\";\n  }\n  h += \"</div>\";\n  h += '<div class=\"fn-page\">'+fnPageHtml()+\"</div>\";\n  box.innerHTML = h;\n}\n\nfunction fnPageHtml(){\n  var dis = disAttr();\n  if(selFn===\"update\") return pageUpdate(dis);\n  if(selFn===\"wifi\") return pageWifi(dis);\n  if(selFn===\"contacts\") return pageContacts(dis);\n  if(selFn===\"locate\") return pageLocate(dis);\n  if(selFn===\"alarm\") return pageAlarm(dis);\n  if(selFn===\"lost\") return pageLost(dis);\n  if(selFn===\"model\") return pageModel();\n  return pageAdb(dis);\n}\n\nfunction pageAdb(dis){\n  var u = uiOf();\n  var st = u ? u.adb.state : \"未连接\";\n  var port = u && u.adb.port ? u.adb.port : \"—\";\n  var cmd = (u && u.adb.cmd) ? u.adb.cmd : \"adb connect 127.0.0.1:<端口>\";\n  var h = \"<h4>远程 ADB</h4>\";\n  h += '<div class=\"ops-grid\">';\n  h += kv(\"会话\", st);\n  h += kv(\"本机端口\", port);\n  h += kv(\"连接命令\", cmd);\n  h += \"</div>\";\n  h += '<div class=\"ops-actions\" style=\"margin-top:.7rem\">';\n  h += '<button class=\"btn-green\" onclick=\"adbStart()\"'+dis+'>开启会话</button>';\n  h += '<button class=\"btn-gray\" onclick=\"adbStop()\"'+dis+'>关闭会话</button>';\n  h += \"</div>\";\n  h += '<p class=\"ops-sec-title\" style=\"margin-top:.85rem\">授权本机 ADB 公钥</p>';\n  h += '<textarea class=\"inp\" id=\"adbPub\" placeholder=\"粘贴本机 adbkey.pub，私钥留在这台电脑\"'+dis+\"></textarea>\";\n  h += '<div class=\"ops-actions\" style=\"margin-top:.5rem\">';\n  h += '<button class=\"btn-gray\" onclick=\"adbAuth()\"'+dis+'>写入设备信任列表</button>';\n  h += \"</div>\";\n  return h;\n}\n\nfunction pageUpdate(dis){\n  var u = uiOf();\n  var d = currentDev();\n  var ver = d && d.app_version ? d.app_version : \"未接入\";\n  var h = \"<h4>更新客户端</h4>\";\n  h += '<div class=\"ops-grid\">'+kv(\"当前版本\", ver)+\"</div>\";\n  h += '<div class=\"ops-actions\" style=\"margin-top:.7rem\">';\n  h += '<input id=\"ghRel\" class=\"inp\" placeholder=\"GitHub Releases 地址\" style=\"max-width:360px\"'+dis+'>';\n  h += '<button class=\"btn-green\" onclick=\"updateFromGithub()\"'+dis+'>从 GitHub 安装</button>';\n  h += \"</div>\";\n  h += '<div class=\"ops-actions\" style=\"margin-top:.45rem\">';\n  h += '<input id=\"apkFile\" type=\"file\" accept=\".apk\"'+dis+'>';\n  h += '<button class=\"btn-green\" onclick=\"updateFromFile()\"'+dis+'>从本地文件安装</button>';\n  h += \"</div>\";\n  h += '<table style=\"margin-top:.7rem\"><thead><tr><th>时间</th><th>来源</th><th>文件/版本</th><th>结果</th></tr></thead><tbody>';\n  var rows = u ? u.updates : [];\n  if(!rows.length) h += '<tr><td colspan=\"4\" class=\"muted\">还没有安装记录</td></tr>';\n  else for(var i=0;i<rows.length;i++){\n    var r=rows[i];\n    h += \"<tr><td>\"+sydney(r.at)+\"</td><td>\"+esc(r.src)+\"</td><td>\"+esc(r.name)+\"</td><td>\"+esc(r.result)+\"</td></tr>\";\n  }\n  h += \"</tbody></table>\";\n  return h;\n}\n\nfunction pageWifi(dis){\n  var u = uiOf();\n  var list = u ? u.wifi : [];\n  var sel = u ? u.wifiSel : \"\";\n  var last = u ? u.wifiLastOk : \"\";\n  var h = \"<h4>配置 Wi-Fi</h4>\";\n  h += '<div class=\"ops-actions\">';\n  h += '<button class=\"btn-gray\" onclick=\"wifiScan()\"'+dis+'>刷新扫描</button>';\n  if(last) h += '<span class=\"muted\">上次成功：'+esc(last)+\"</span>\";\n  h += \"</div>\";\n  h += '<table style=\"margin-top:.55rem\"><thead><tr><th>SSID</th><th>信号</th><th>加密</th><th></th></tr></thead><tbody>';\n  if(!list.length) h += '<tr><td colspan=\"4\" class=\"muted\">等待设备上报周围 Wi-Fi</td></tr>';\n  else for(var i=0;i<list.length;i++){\n    var w=list[i];\n    h += \"<tr><td>\"+esc(w.ssid)+\"</td><td>\"+esc(w.rssi)+\"</td><td>\"+esc(w.sec)+\"</td>\";\n    h += '<td><button class=\"btn-gray\" onclick=\"wifiPick(\\''+esc(w.ssid)+'\\')\"'+dis+'>选择</button></td></tr>';\n  }\n  h += \"</tbody></table>\";\n  h += '<div class=\"ops-actions\" style=\"margin-top:.7rem\">';\n  h += '<input id=\"wifiSsid\" class=\"inp\" placeholder=\"SSID\" value=\"'+esc(sel)+'\" style=\"max-width:200px\"'+dis+'>';\n  h += '<input id=\"wifiPw\" class=\"inp\" type=\"password\" placeholder=\"密码\" style=\"max-width:200px\"'+dis+'>';\n  h += '<button class=\"btn-green\" onclick=\"wifiConnect()\"'+dis+'>连接</button>';\n  h += \"</div>\";\n  return h;\n}\n\nfunction pageContacts(dis){\n  var u = uiOf();\n  var list = u ? u.contacts : [];\n  var h = \"<h4>通信录</h4>\";\n  h += '<div class=\"ops-actions\">';\n  h += '<input id=\"cName\" class=\"inp\" placeholder=\"姓名\" style=\"max-width:160px\"'+dis+'>';\n  h += '<input id=\"cPhone\" class=\"inp\" placeholder=\"号码\" style=\"max-width:160px\"'+dis+'>';\n  h += '<button class=\"btn-green\" onclick=\"contactAdd()\"'+dis+'>添加</button>';\n  h += '<button class=\"btn-gray\" onclick=\"contactRefresh()\"'+dis+'>刷新</button>';\n  h += \"</div>\";\n  h += '<table style=\"margin-top:.55rem\"><thead><tr><th>姓名</th><th>号码</th><th></th></tr></thead><tbody>';\n  if(!list.length) h += '<tr><td colspan=\"3\" class=\"muted\">暂无联系人</td></tr>';\n  else for(var i=0;i<list.length;i++){\n    var c=list[i];\n    h += \"<tr><td>\"+esc(c.name)+\"</td><td>\"+esc(c.phone)+\"</td><td>\";\n    h += '<button class=\"btn-gray\" onclick=\"contactEdit('+i+')\"'+dis+'>改</button> ';\n    h += '<button class=\"btn-gray\" style=\"color:#f87171\" onclick=\"contactDel('+i+')\"'+dis+'>删</button>';\n    h += \"</td></tr>\";\n  }\n  h += \"</tbody></table>\";\n  return h;\n}\n\nfunction pageLocate(dis){\n  var u = uiOf();\n  var rows = u ? u.loc : [];\n  var h = '<div class=\"ops-actions\">';\n  h += '<button class=\"btn-green\" onclick=\"locNow()\"'+dis+'>立即更新位置</button>';\n  h += \"</div>\";\n  h += '<table style=\"margin-top:.55rem\"><thead><tr><th>时间</th><th>纬度</th><th>经度</th></tr></thead><tbody>';\n  if(!rows.length) h += '<tr><td colspan=\"3\" class=\"muted\">还没有定位记录</td></tr>';\n  else for(var i=0;i<rows.length;i++){\n    var r=rows[i];\n    h += \"<tr><td>\"+sydney(r.at)+\"</td><td>\"+esc(r.lat)+\"</td><td>\"+esc(r.lng)+\"</td></tr>\";\n  }\n  h += \"</tbody></table>\";\n  return h;\n}\n\nfunction pageAlarm(dis){\n  var u = uiOf();\n  var rows = u ? u.alarm : [];\n  var h = '<div class=\"ops-actions\">';\n  h += '<button class=\"btn-green\" onclick=\"alarmPlay()\"'+dis+'>播放警报声</button>';\n  h += \"</div>\";\n  h += '<table style=\"margin-top:.55rem\"><thead><tr><th>时间</th><th>时长</th></tr></thead><tbody>';\n  if(!rows.length) h += '<tr><td colspan=\"2\" class=\"muted\">还没有播放记录</td></tr>';\n  else for(var i=0;i<rows.length;i++){\n    var r=rows[i];\n    h += \"<tr><td>\"+sydney(r.at)+\"</td><td>\"+esc(r.dur)+\"</td></tr>\";\n  }\n  h += \"</tbody></table>\";\n  return h;\n}\n\nfunction pageLost(dis){\n  var u = uiOf();\n  var live = u && u.live ? u.live : \"未开始\";\n  var h = '<div class=\"lost-bar\">';\n  h += '<button class=\"btn-gray\" onclick=\"lostRec()\"'+dis+'>远程录音</button>';\n  h += '<button class=\"btn-gray\" onclick=\"lostVideo(\\'front\\')\"'+dis+'>前置录像</button>';\n  h += '<button class=\"btn-gray\" onclick=\"lostVideo(\\'back\\')\"'+dis+'>后置录像</button>';\n  h += '<button class=\"btn-gray\" onclick=\"lostPhoto(\\'front\\')\"'+dis+'>前置拍照</button>';\n  h += '<button class=\"btn-gray\" onclick=\"lostPhoto(\\'back\\')\"'+dis+'>后置拍照</button>';\n  h += '<button class=\"btn-gray\" onclick=\"lostTalk()\"'+dis+'>远程对讲</button>';\n  h += \"</div>\";\n  h += '<div class=\"fn-live\">'+esc(live)+\"</div>\";\n  h += '<div class=\"ops-actions\" style=\"margin-top:.7rem\">';\n  h += '<input id=\"lockPw\" class=\"inp\" type=\"password\" placeholder=\"解锁密码\" style=\"max-width:180px\"'+dis+'>';\n  h += '<button class=\"btn-green\" onclick=\"lostLock()\"'+dis+'>远程锁机</button>';\n  h += '<button class=\"btn-gray\" onclick=\"lostUnlock()\"'+dis+'>远程解锁</button>';\n  h += \"</div>\";\n  h += '<p class=\"ops-sec-title\" style=\"margin-top:.85rem\">录音 / 录像</p>';\n  h += lostRecTable(u);\n  h += '<p class=\"ops-sec-title\" style=\"margin-top:.85rem\">照片</p>';\n  h += lostPhotoTable(u);\n  return h;\n}\n\nfunction lostRecTable(u){\n  var rows = u ? u.recs : [];\n  var h = '<table><thead><tr><th>时间</th><th>类型</th><th>状态</th></tr></thead><tbody>';\n  if(!rows.length) h += '<tr><td colspan=\"3\" class=\"muted\">暂无记录</td></tr>';\n  else for(var i=0;i<rows.length;i++){\n    var r=rows[i];\n    h += \"<tr><td>\"+sydney(r.at)+\"</td><td>\"+esc(r.kind)+\"</td><td>\"+esc(r.state)+\"</td></tr>\";\n  }\n  h += \"</tbody></table>\";\n  return h;\n}\nfunction lostPhotoTable(u){\n  var rows = u ? u.photos : [];\n  var h = '<table><thead><tr><th>时间</th><th>镜头</th><th>状态</th></tr></thead><tbody>';\n  if(!rows.length) h += '<tr><td colspan=\"3\" class=\"muted\">暂无照片</td></tr>';\n  else for(var i=0;i<rows.length;i++){\n    var r=rows[i];\n    h += \"<tr><td>\"+sydney(r.at)+\"</td><td>\"+esc(r.cam)+\"</td><td>\"+esc(r.state)+\"</td></tr>\";\n  }\n  h += \"</tbody></table>\";\n  return h;\n}\n\nfunction needDev(){\n  if(uiOf()) return true;\n  return false;\n}\nfunction adbStart(){\n  var u=uiOf(); if(!u) return;\n  u.adb.state=\"等待本机桥接器与设备出站连接\";\n  u.adb.port=\"待桥接器分配\";\n  u.adb.cmd=\"adb connect 127.0.0.1:<端口>\";\n  renderOps();\n}\nfunction adbStop(){\n  var u=uiOf(); if(!u) return;\n  u.adb.state=\"未连接\";\n  u.adb.port=\"—\";\n  u.adb.cmd=\"adb connect 127.0.0.1:<端口>\";\n  renderOps();\n}\nfunction adbAuth(){\n  var u=uiOf(); if(!u) return;\n  var pub=$(\"adbPub\")?$(\"adbPub\").value.trim():\"\";\n  if(!pub){ alert(\"请粘贴本机 adbkey.pub\"); return; }\n  u.adb.state=\"公钥已提交，等待设备写入信任列表\";\n  renderOps();\n}\nfunction pushUpdate(src, name){\n  var u=uiOf(); if(!u) return;\n  u.updates.unshift({ at: nowIso(), src: src, name: name, result: \"已下发，等待安装结果\" });\n  renderOps();\n}\nfunction updateFromGithub(){\n  var url=$(\"ghRel\")?$(\"ghRel\").value.trim():\"\";\n  if(!url){ alert(\"请填写 GitHub Releases 地址\"); return; }\n  pushUpdate(\"GitHub\", url);\n}\nfunction updateFromFile(){\n  var f=$(\"apkFile\") && $(\"apkFile\").files && $(\"apkFile\").files[0];\n  if(!f){ alert(\"请选择本地 APK\"); return; }\n  pushUpdate(\"本地文件\", f.name);\n}\nfunction wifiScan(){\n  var u=uiOf(); if(!u) return;\n  renderOps();\n}\nfunction wifiPick(ssid){\n  var u=uiOf(); if(!u) return;\n  u.wifiSel=ssid;\n  renderOps();\n}\nfunction wifiConnect(){\n  var u=uiOf(); if(!u) return;\n  var ssid=$(\"wifiSsid\")?$(\"wifiSsid\").value.trim():\"\";\n  var pw=$(\"wifiPw\")?$(\"wifiPw\").value:\"\";\n  if(!ssid){ alert(\"请选择或填写 SSID\"); return; }\n  if(!pw){ alert(\"请输入密码\"); return; }\n  u.wifiSel=ssid;\n  renderOps();\n}\nfunction contactRefresh(){ renderOps(); }\nfunction contactAdd(){\n  var u=uiOf(); if(!u) return;\n  var name=$(\"cName\")?$(\"cName\").value.trim():\"\";\n  var phone=$(\"cPhone\")?$(\"cPhone\").value.trim():\"\";\n  if(!name||!phone){ alert(\"请填写姓名和号码\"); return; }\n  u.contacts.push({ name:name, phone:phone });\n  renderOps();\n}\nfunction contactEdit(i){\n  var u=uiOf(); if(!u||!u.contacts[i]) return;\n  var name=prompt(\"姓名\", u.contacts[i].name); if(name==null) return;\n  var phone=prompt(\"号码\", u.contacts[i].phone); if(phone==null) return;\n  name=name.trim(); phone=phone.trim();\n  if(!name||!phone) return;\n  u.contacts[i]={ name:name, phone:phone };\n  renderOps();\n}\nfunction contactDel(i){\n  var u=uiOf(); if(!u) return;\n  u.contacts.splice(i,1);\n  renderOps();\n}\nfunction locNow(){\n  var u=uiOf(); if(!u) return;\n  var d=currentDev();\n  var lat=\"—\", lng=\"—\";\n  if(d && d.loc && isFinite(d.loc.lat) && isFinite(d.loc.lng)){\n    lat=Number(d.loc.lat).toFixed(6);\n    lng=Number(d.loc.lng).toFixed(6);\n  }\n  u.loc.unshift({ at: nowIso(), lat: lat, lng: lng });\n  renderOps();\n}\nfunction alarmPlay(){\n  var u=uiOf(); if(!u) return;\n  u.alarm.unshift({ at: nowIso(), dur: \"等待设备回报\" });\n  renderOps();\n}\nfunction lostRec(){\n  var u=uiOf(); if(!u) return;\n  u.live=\"录音中（实时播放待设备接入）\";\n  u.recs.unshift({ at: nowIso(), kind: \"录音\", state: \"进行中\" });\n  renderOps();\n}\nfunction lostVideo(cam){\n  var u=uiOf(); if(!u) return;\n  var lab = cam===\"front\" ? \"前置录像\" : \"后置录像\";\n  u.live=lab+\"中（实时画面待设备接入）\";\n  u.recs.unshift({ at: nowIso(), kind: lab, state: \"进行中\" });\n  renderOps();\n}\nfunction lostPhoto(cam){\n  var u=uiOf(); if(!u) return;\n  var lab = cam===\"front\" ? \"前置\" : \"后置\";\n  u.photos.unshift({ at: nowIso(), cam: lab, state: \"等待回传\" });\n  renderOps();\n}\nfunction lostTalk(){\n  var u=uiOf(); if(!u) return;\n  u.talk=!u.talk;\n  u.live=u.talk ? \"对讲中：外置扬声器 + 麦克风\" : \"对讲已停止\";\n  renderOps();\n}\nfunction lostLock(){\n  var u=uiOf(); if(!u) return;\n  var pw=$(\"lockPw\")?$(\"lockPw\").value:\"\";\n  if(!pw){ alert(\"请设置解锁密码\"); return; }\n  u.live=\"已下发锁机\";\n  renderOps();\n}\nfunction lostUnlock(){\n  var u=uiOf(); if(!u) return;\n  u.live=\"已下发解锁\";\n  renderOps();\n}\n\nfunction stubAct(){\n  if(!deviceReady()) return;\n}\n\nfunction openEdit(){\n  var d = currentDev(); if(!d) return;\n  $(\"edName\").value = d.name;\n  fillModelSelect($(\"edModel\"), d.model_id);\n  $(\"edErr\").innerText = \"\";\n  show(\"editWrap\");\n}\nfunction closeEdit(){ hide(\"editWrap\"); }\nfunction saveEdit(){\n  var d = currentDev(); if(!d) return;\n  var name = $(\"edName\").value.trim();\n  var model_id = $(\"edModel\").value;\n  fetch(\"/api/devices/update\",{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify({id:d.id,name:name,model_id:model_id})})\n  .then(function(r){return r.json();}).then(function(x){\n    if(!x.ok){ $(\"edErr\").innerText=x.msg||\"保存失败\"; return; }\n    closeEdit(); loadDevices();\n  });\n}\nfunction setEnabled(on){\n  var d = currentDev(); if(!d) return;\n  fetch(\"/api/devices/update\",{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify({id:d.id,enabled:on})})\n  .then(function(r){return r.json();}).then(function(){ loadDevices(); });\n}\nfunction delDev(){\n  var d = currentDev(); if(!d) return;\n  if(!confirm(\"确定解除配对「\"+d.name+\"」？此台将从列表和地图消失。\")) return;\n  fetch(\"/api/devices/delete\",{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify({id:d.id,confirm:true})})\n  .then(function(r){return r.json();}).then(function(x){\n    if(!x.ok){ alert(x.msg||\"删除失败\"); return; }\n    selDev=\"\"; loadDevices();\n  });\n}\n\nfunction fillModelSelect(sel, val){\n  var h = \"\";\n  for(var i=0;i<MODELS.length;i++){\n    var m = MODELS[i];\n    h += '<option value=\"'+esc(m.id)+'\"'+(m.id===val?\" selected\":\"\")+\">\"+esc(m.name)+\"</option>\";\n  }\n  sel.innerHTML = h || '<option value=\"\">请先添加型号</option>';\n}\n\nfunction openAdd(){\n  fillModelSelect($(\"dModel\"), MODELS[0] ? MODELS[0].id : \"\");\n  $(\"dName\").value=\"\"; $(\"dIp\").value=\"\"; $(\"pairCode\").value=\"\";\n  $(\"addErr\").innerText=\"\"; $(\"pairErr\").innerText=\"\";\n  show(\"addWrap\");\n}\nfunction closeAdd(){ hide(\"addWrap\"); }\n\nfunction saveManual(){\n  var body = { name:$(\"dName\").value.trim(), model_id:$(\"dModel\").value, ip:$(\"dIp\").value.trim() };\n  fetch(\"/api/devices\",{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify(body)})\n  .then(function(r){return r.json();}).then(function(d){\n    if(!d.ok){ $(\"addErr\").innerText=d.msg||\"保存失败\"; return; }\n    closeAdd(); selDev=d.device && d.device.id; loadDevices();\n  });\n}\nfunction submitPair(){\n  fetch(\"/api/devices/pair\",{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify({code:$(\"pairCode\").value.trim()})})\n  .then(function(r){return r.json();}).then(function(d){\n    $(\"pairErr\").innerText=d.msg||\"等待设备端，请先用手工登记\";\n  }).catch(function(){ $(\"pairErr\").innerText=\"请求失败\"; });\n}\n\nfunction addModel(){\n  var name = $(\"mName\").value.trim();\n  var note = $(\"mNote\").value.trim();\n  fetch(\"/api/device-models\",{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify({name:name,note:note})})\n  .then(function(r){return r.json();}).then(function(d){\n    if(!d.ok){ alert(d.msg||\"失败\"); return; }\n    MODELS = d.models; renderOps();\n  });\n}\nfunction editModel(id){\n  var cur=null; for(var i=0;i<MODELS.length;i++) if(MODELS[i].id===id) cur=MODELS[i];\n  if(!cur) return;\n  var name = prompt(\"型号名称\", cur.name); if(name==null) return;\n  name = name.trim(); if(!name) return;\n  fetch(\"/api/device-models\",{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify({id:id,name:name,note:cur.note||\"\",icon:cur.icon||\"\"})})\n  .then(function(r){return r.json();}).then(function(d){\n    if(!d.ok){ alert(d.msg||\"失败\"); return; }\n    MODELS = d.models; renderOps();\n  });\n}\nfunction delModel(id){\n  if(!confirm(\"删除该型号？\")) return;\n  fetch(\"/api/device-models\",{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify({action:\"delete\",id:id})})\n  .then(function(r){return r.json();}).then(function(d){\n    if(!d.ok){ alert(d.msg||\"失败\"); return; }\n    MODELS = d.models; renderOps();\n  });\n}\n\ncheckAuth();\nsetTimeout(function(){ if(typeof L!==\"undefined\") renderMap(); }, 200);\n";
}

function sipClientJs() {
  return "var E = [];\nvar G = [];\nvar W = [];\nvar ST = null;\nvar GEO = {};\nvar STALE = true;\nvar SYNC = null;\nvar cdrPage = 1;\nvar cdrExt = \"\";\nvar PAGE = 25;\nvar PAGE_G = 10;\nvar HOLD = {};\nvar selExt = \"\";\nvar selGw = \"\";\nvar selGrp = \"\";\nvar GP = {};\nvar editingExt = \"\";\nvar editingGw = \"\";\nvar editingGrp = \"\";\n\nfunction $(id){ return document.getElementById(id); }\nfunction show(id){ $(id).style.display = \"flex\"; }\nfunction hide(id){ $(id).style.display = \"none\"; }\nfunction checkAuth(){ if(localStorage.getItem(\"_pt\")){ hide(\"loginWrap\"); loadSip(); } else show(\"loginWrap\"); }\nfunction doLogin(){\n  fetch(\"/api/login\",{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify({username:$(\"lu\").value,password:$(\"lp\").value})})\n  .then(function(r){return r.json();}).then(function(d){\n    if(d.ok){ localStorage.setItem(\"_pt\",\"1\"); hide(\"loginWrap\"); loadSip(); }\n    else { $(\"lerr\").innerText=d.msg||\"失败\"; $(\"lerr\").style.display=\"block\"; }\n  });\n}\nfunction logout(){ localStorage.removeItem(\"_pt\"); location.href=\"/\"; }\nfunction loadSip(){\n  fetch(\"/api/sip\").then(function(r){return r.json();}).then(function(d){\n    if(d.extensions) E = d.extensions;\n    if(d.groups) G = d.groups;\n    if(d.gateways) W = d.gateways;\n    if(d.status){ ST = d.status; if(d.geo) GEO = d.geo; }\n    STALE = !!d.stale || !d.status;\n    SYNC = d.sync||null;\n    renderStatus();\n    renderAll();\n    renderSync();\n  }).catch(function(){ STALE=true; renderStatus(); });\n}\nfunction saveAll(done){\n  window._sipSaved = true;\n  fetch(\"/api/sip/save\",{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify({extensions:E,groups:G,gateways:W})})\n  .then(function(r){return r.json();}).then(function(d){\n    if(!d.ok){ alert(d.msg||\"保存失败\"); window._sipSaved=false; return; }\n    if(done) done();\n    loadSip();\n  }).catch(function(){ alert(\"保存失败\"); window._sipSaved=false; });\n}\nfunction gwName(ext){\n  for(var i=0;i<W.length;i++) if(String(W[i].ext)===String(ext)) return W[i].name || ext;\n  return ext;\n}\nfunction grpName(id){\n  for(var i=0;i<G.length;i++) if(G[i].id===id) return G[i].name || id;\n  return id;\n}\nfunction grpOf(id){\n  for(var i=0;i<G.length;i++) if(G[i].id===id) return G[i];\n  return null;\n}\nfunction membersOf(gid){\n  var out=[];\n  for(var i=0;i<E.length;i++){\n    var id = E[i].group_id || \"\";\n    if(gid===\"__none\" && !id) out.push(E[i]);\n    else if(id===gid) out.push(E[i]);\n  }\n  return out;\n}\nfunction groupsUsingGw(ext){\n  var names=[];\n  for(var i=0;i<G.length;i++) if(String(G[i].gateway)===String(ext)) names.push(G[i].name||G[i].id);\n  return names;\n}\nfunction peerLabel(g){\n  if(g.internal===\"all\") return \"全部内网\";\n  if(g.internal===\"peers\"){\n    var names=[];\n    for(var i=0;i<(g.peers||[]).length;i++) names.push(grpName(g.peers[i]));\n    return names.length ? (\"互打：\"+names.join(\"、\")) : \"指定组（未选）\";\n  }\n  return \"仅组内\";\n}\nfunction liveMap(){\n  var m = {}; var cs = (ST && ST.contacts) || []; var now = Date.now();\n  for(var i=0;i<cs.length;i++){\n    if(!cs[i].ext) continue;\n    var id=String(cs[i].ext);\n    m[id]=cs[i];\n    if(contactLive(cs[i])) HOLD[id]={c:cs[i], until:now+30000};\n  }\n  for(var k in HOLD){ if(!m[k] && HOLD[k] && now<HOLD[k].until) m[k]=HOLD[k].c; }\n  return m;\n}\nfunction isGwExt(ext){\n  for(var i=0;i<W.length;i++) if(String(W[i].ext)===String(ext)) return true;\n  return false;\n}\nfunction isAvailStatus(status){\n  return String(status||\"\").toLowerCase() === \"avail\";\n}\nfunction contactLive(c){\n  if(!c) return false;\n  if(isGwExt(c.ext)) return !!(c.uri || c.ip || c.status);\n  return isAvailStatus(c.status);\n}\nfunction isOnline(ext, live){\n  return contactLive(live[String(ext)]);\n}\nfunction fmtRtt(L){\n  if(!L || L.rtt==null || !isFinite(Number(L.rtt))) return \"-\";\n  return Number(L.rtt)+\" ms\";\n}\nfunction twoLine(a,b){\n  return \"<div class=\\\"cell2\\\"><div class=\\\"cell2a\\\">\"+(a||\"-\")+\"</div><div class=\\\"cell2b\\\">\"+(b||\"\\u00a0\")+\"</div></div>\";\n}\nfunction fmtDur(sec){\n  sec = parseInt(sec,10)||0;\n  var h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60), s=sec%60;\n  function z(n){return n<10?\"0\"+n:\"\"+n;}\n  return h>0 ? h+\":\"+z(m)+\":\"+z(s) : z(m)+\":\"+z(s);\n}\nfunction parseTime(t){\n  if(!t) return null;\n  var s=String(t).trim();\n  if(/^\\d{4}-\\d{2}-\\d{2} /.test(s) && s.indexOf(\"Z\")<0 && s.indexOf(\"+\")<0) s=s.replace(\" \",\"T\")+\"Z\";\n  var d=new Date(s);\n  return isNaN(d.getTime())?null:d;\n}\nfunction sydneyDay(d){\n  if(!d) return \"\";\n  var p=new Intl.DateTimeFormat(\"en-CA\",{timeZone:\"Australia/Sydney\",year:\"numeric\",month:\"2-digit\",day:\"2-digit\"}).formatToParts(d);\n  function g(tp){ for(var i=0;i<p.length;i++) if(p[i].type===tp) return p[i].value; return \"\"; }\n  return g(\"year\")+\"-\"+g(\"month\")+\"-\"+g(\"day\");\n}\nfunction fmtSydney(t){\n  var d=parseTime(t); if(!d) return \"-\";\n  var p=new Intl.DateTimeFormat(\"en-CA\",{timeZone:\"Australia/Sydney\",year:\"numeric\",month:\"2-digit\",day:\"2-digit\",hour:\"2-digit\",minute:\"2-digit\",second:\"2-digit\",hour12:false}).formatToParts(d);\n  function g(tp){ for(var i=0;i<p.length;i++) if(p[i].type===tp) return p[i].value; return \"\"; }\n  return g(\"year\")+\"-\"+g(\"month\")+\"-\"+g(\"day\")+\" \"+g(\"hour\")+\":\"+g(\"minute\")+\":\"+g(\"second\");\n}\nfunction fmtTime(t){ return fmtSydney(t); }\nfunction fmtSeen(t){\n  var s = fmtSydney(t);\n  if(!s || s===\"-\") return twoLine(\"-\", \"\\u00a0\");\n  var p = s.split(\" \");\n  if(p.length<2) return twoLine(s, \"\\u00a0\");\n  return twoLine(p[0], p[1]);\n}\nfunction cdrFor(ext){\n  var all = (ST && ST.cdr) || []; var out=[];\n  for(var i=0;i<all.length;i++){\n    var r=all[i];\n    if(String(r.src)===String(ext) || String(r.dst)===String(ext)) out.push(r);\n  }\n  return out.reverse();\n}\nfunction statsFor(ext){\n  var rows = cdrFor(ext); var n=0, dur=0;\n  for(var i=0;i<rows.length;i++){ n++; dur += parseInt(rows[i].billsec||rows[i].duration||0,10)||0; }\n  return {count:n, dur:dur};\n}\nfunction renderStatus(){\n  var box = $(\"stats\"); var hint = $(\"staleHint\"); var s = ST;\n  if(!s){ hint.innerText=\"暂时读不到新数据，图表保持上次。\"; return; }\n  hint.innerHTML = STALE ? \"<span class=\\\"bad\\\">心跳超时，机器可能卡住或离线</span> · 上次 \"+fmtSydney(s.received_at) : \"<span class=\\\"ok\\\">心跳正常</span> · \"+fmtSydney(s.received_at);\n  function kpi(t,v,c){ return \"<div class=\\\"stat\\\"><div style=\\\"font-size:.75rem;color:#94a3b8\\\">\"+t+\"</div><div style=\\\"font-size:1.15rem;font-weight:700;margin-top:.25rem\\\" class=\\\"\"+(c||\"\")+\"\\\">\"+v+\"</div></div>\"; }\n  function series(hist,key){ var o=[]; for(var i=0;i<hist.length;i++) o.push(Number(hist[i][key])||0); return o; }\n  function svgArea(vals,color,yMax){\n    var w=100,h=38,n=vals.length;\n    if(!n) return \"<div style=\\\"height:72px\\\"></div>\";\n    var mx=yMax||0; for(var i=0;i<n;i++) if(vals[i]>mx) mx=vals[i]; if(mx<=0) mx=1;\n    function pt(i,v){ var x=n===1?50:(i/(n-1)*w); var y=h-(v/mx)*h*0.9; return x.toFixed(2)+\",\"+y.toFixed(2); }\n    var line=[], fill=[\"0,\"+h];\n    for(var j=0;j<n;j++){ var p=pt(j,vals[j]); line.push(p); fill.push(p); }\n    fill.push(w+\",\"+h);\n    return \"<svg viewBox=\\\"0 0 \"+w+\" \"+h+\"\\\" preserveAspectRatio=\\\"none\\\" style=\\\"width:100%;height:72px;display:block\\\"><polygon fill=\\\"\"+color+\"22\\\" points=\\\"\"+fill.join(\" \")+\"\\\"/><polyline fill=\\\"none\\\" stroke=\\\"\"+color+\"\\\" stroke-width=\\\"1.2\\\" stroke-linejoin=\\\"round\\\" vector-effect=\\\"non-scaling-stroke\\\" points=\\\"\"+line.join(\" \")+\"\\\"/></svg>\";\n  }\n  function svgDual(a,b,ca,cb,yMax){\n    var w=100,h=38,n=Math.max(a.length,b.length);\n    if(!n) return \"<div style=\\\"height:72px\\\"></div>\";\n    var mx=yMax||0; for(var i=0;i<n;i++){ if((a[i]||0)>mx) mx=a[i]; if((b[i]||0)>mx) mx=b[i]; } if(mx<=0) mx=1;\n    function poly(vals,col){ var pts=[]; for(var i=0;i<n;i++){ var x=n===1?50:(i/(n-1)*w); var y=h-((vals[i]||0)/mx)*h*0.9; pts.push(x.toFixed(2)+\",\"+y.toFixed(2)); } return \"<polyline fill=\\\"none\\\" stroke=\\\"\"+col+\"\\\" stroke-width=\\\"1\\\" stroke-linejoin=\\\"miter\\\" stroke-linecap=\\\"butt\\\" vector-effect=\\\"non-scaling-stroke\\\" points=\\\"\"+pts.join(\" \")+\"\\\"/>\"; }\n    return \"<svg viewBox=\\\"0 0 \"+w+\" \"+h+\"\\\" preserveAspectRatio=\\\"none\\\" style=\\\"width:100%;height:72px;display:block\\\">\"+poly(a,ca)+poly(b,cb)+\"</svg>\";\n  }\n  function fmtRate(bps){ bps=Number(bps)||0; if(bps<1024) return Math.round(bps)+\" B/s\"; if(bps<1048576) return (bps/1024).toFixed(1)+\" KB/s\"; return (bps/1048576).toFixed(2)+\" MB/s\"; }\n  function todayCalls(st){\n    var rows=(st&&st.cdr)||[]; var day=sydneyDay(parseTime(st.received_at)); var n=0;\n    for(var i=0;i<rows.length;i++){ var d=sydneyDay(parseTime(rows[i].time)); if(!day || d===day) n++; }\n    return n;\n  }\n  var hist=s.history||[];\n  var live=liveMap(); var online=0;\n  for(var i=0;i<E.length;i++) if(isOnline(E[i].ext, live)) online++;\n  var callsNow=s.active_calls!=null?s.active_calls:0;\n  var html=\"<div style=\\\"display:flex;flex-wrap:wrap;gap:.7rem;width:100%;margin-bottom:.9rem\\\">\";\n  html += kpi(\"主机\", s.hostname||\"-\");\n  html += kpi(\"Asterisk\", s.asterisk||\"-\", s.asterisk===\"active\"?\"ok\":\"bad\");\n  html += kpi(\"运行时长\", s.uptime||\"-\");\n  html += kpi(\"在线分机\", online+\" / \"+(E.length||0), online?\"ok\":\"\");\n  html += kpi(\"当前呼叫\", String(callsNow), callsNow?\"ok\":\"\");\n  html += kpi(\"今日通话\", String(todayCalls(s)));\n  html += \"</div><div class=\\\"mon-grid\\\">\";\n  html += \"<div class=\\\"mon-card\\\"><div style=\\\"display:flex;justify-content:space-between;align-items:baseline\\\"><span style=\\\"font-size:.8rem;color:#94a3b8\\\">CPU</span><span style=\\\"font-size:1.25rem;font-weight:700\\\" class=\\\"\"+((s.cpu_pct||0)>85?\"bad\":\"\")+\"\\\">\"+(s.cpu_pct!=null?s.cpu_pct+\"%\":\"-\")+\"</span></div><div style=\\\"font-size:.75rem;color:#64748b;margin:.2rem 0 .35rem\\\">负载 \"+(s.load||\"-\")+\"</div>\"+svgArea(series(hist,\"cpu\"),\"#4ade80\",100)+\"</div>\";\n  html += \"<div class=\\\"mon-card\\\"><div style=\\\"display:flex;justify-content:space-between;align-items:baseline\\\"><span style=\\\"font-size:.8rem;color:#94a3b8\\\">内存</span><span style=\\\"font-size:1.25rem;font-weight:700\\\" class=\\\"\"+((s.mem_pct||0)>90?\"bad\":\"\")+\"\\\">\"+(s.mem_pct!=null?s.mem_pct+\"%\":\"-\")+\"</span></div><div style=\\\"font-size:.75rem;color:#64748b;margin:.2rem 0 .35rem\\\">\"+(s.mem_used||\"-\")+\" / \"+(s.mem_total||\"-\")+\"</div>\"+svgArea(series(hist,\"mem\"),\"#a78bfa\",100)+\"</div>\";\n  html += \"<div class=\\\"mon-card\\\"><div style=\\\"display:flex;justify-content:space-between;align-items:baseline\\\"><span style=\\\"font-size:.8rem;color:#94a3b8\\\">磁盘</span><span style=\\\"font-size:1.25rem;font-weight:700\\\" class=\\\"\"+((s.disk_pct||0)>90?\"bad\":\"\")+\"\\\">\"+(s.disk_pct!=null?s.disk_pct+\"%\":\"-\")+\"</span></div><div style=\\\"font-size:.75rem;color:#64748b;margin:.2rem 0 .35rem\\\">\"+(s.disk_used||\"-\")+\" / \"+(s.disk_total||\"-\")+\"</div>\"+svgArea(series(hist,\"disk\"),\"#fbbf24\",100)+\"</div>\";\n  html += \"<div class=\\\"mon-card\\\"><div style=\\\"display:flex;justify-content:space-between;align-items:baseline\\\"><span style=\\\"font-size:.8rem;color:#94a3b8\\\">网卡</span><span style=\\\"font-size:1.05rem;font-weight:700\\\">↓ \"+fmtRate(s.rx_bps)+\" · ↑ \"+fmtRate(s.tx_bps)+\"</span></div><div style=\\\"font-size:.75rem;color:#64748b;margin:.2rem 0 .35rem\\\"><span style=\\\"color:#38bdf8\\\">接收</span> / <span style=\\\"color:#fb7185\\\">发送</span> · 累计 \"+(s.net||\"-\")+\"</div>\"+svgDual(series(hist,\"rx\"),series(hist,\"tx\"),\"#38bdf8\",\"#fb7185\")+\"</div>\";\n  html += \"</div>\";\n  box.innerHTML = html;\n}\nfunction renderSync(){\n  var el=$(\"syncHint\"); if(!el) return;\n  el.style.display=\"block\";\n  if(SYNC && SYNC.error){ el.innerHTML=\"<span class=\\\"bad\\\">保存到交换机失败：</span>\"+SYNC.error; return; }\n  if(SYNC && SYNC.pending && window._sipSaved){ el.innerHTML=\"<span class=\\\"warn\\\">正在保存到 SIP 服务器…</span>\"; return; }\n  window._sipSaved=false;\n  el.innerHTML=\"<span class=\\\"ok\\\">已同步到 SIP 服务器</span>\";\n}\nfunction talkingSet(){\n  var a = (ST && ST.talking_exts) || [];\n  var s = {};\n  for(var i=0;i<a.length;i++) s[String(a[i])] = true;\n  return s;\n}\nfunction talkDelay(){\n  return (-((Date.now() % 2600) / 1000)).toFixed(3) + \"s\";\n}\nfunction extRowHtml(x, live){\n  var L=live[String(x.ext)];\n  var online = isOnline(x.ext, live);\n  var talking = !!talkingSet()[String(x.ext)];\n  var dot = online ? \"<span class=\\\"dot dot-on\\\" title=\\\"在线\\\"></span>\" : \"<span class=\\\"dot dot-off\\\" title=\\\"离线\\\"></span>\";\n  var tr = online && L && L.transport ? String(L.transport).toUpperCase() : \"-\";\n  var ipCell = (online && L && L.ip) ? twoLine(L.ip, GEO[L.ip] || \"查询中\") : twoLine(\"-\", \"\\u00a0\");\n  var rtt = (online && L) ? fmtRtt(L) : \"-\";\n  var last=(ST && ST.last_seen)||{};\n  var seen = last[x.ext] ? fmtSeen(last[x.ext]) : twoLine(\"-\", \"\\u00a0\");\n  var st = statsFor(x.ext);\n  var cls = (selExt===String(x.ext)?\"sel\":\"\")+(talking?\" talking\":\"\");\n  var html = \"<tr class=\\\"\"+cls.trim()+\"\\\"\"+(talking?\" style=\\\"animation-delay:\"+talkDelay()+\"\\\"\":\"\")+\">\";\n  html += \"<td><input class=\\\"rowchk\\\" type=\\\"checkbox\\\" \"+(selExt===String(x.ext)?\"checked\":\"\")+\" onchange=\\\"pickExt('\"+x.ext+\"',this.checked)\\\"></td>\";\n  html += \"<td style=\\\"text-align:center\\\">\"+dot+\"</td>\";\n  html += \"<td><a class=\\\"extlink\\\" href=\\\"#\\\" onclick=\\\"openCdr('\"+x.ext+\"');return false;\\\">\"+x.ext+\"</a></td>\";\n  html += \"<td><a class=\\\"namelink\\\" href=\\\"#\\\" onclick=\\\"openCdr('\"+x.ext+\"');return false;\\\">\"+(x.name||\"-\")+\"</a></td>\";\n  html += \"<td>\"+tr+\"</td><td>\"+ipCell+\"</td>\";\n  html += \"<td style=\\\"white-space:nowrap\\\">\"+rtt+\"</td>\";\n  html += \"<td>\"+seen+\"</td>\";\n  html += \"<td>\"+st.count+\"</td><td style=\\\"white-space:nowrap\\\">\"+fmtDur(st.dur)+\"</td>\";\n  html += \"</tr>\";\n  return html;\n}\nfunction renderAll(){\n  renderGroupsTable();\n  renderGatewaysTable();\n  renderGroupBoxes();\n}\nfunction renderGroupsTable(){\n  var tb=$(\"gtb\"); if(!tb) return;\n  var html=\"\";\n  for(var i=0;i<G.length;i++){\n    var g=G[i];\n    var n=membersOf(g.id).length;\n    var out = g.gateway ? (g.gateway+\" \"+gwName(g.gateway)) : \"无\";\n    html += \"<tr\"+(selGrp===g.id?\" class=\\\"sel\\\"\":\"\")+\">\";\n    html += \"<td><input class=\\\"rowchk\\\" type=\\\"checkbox\\\" \"+(selGrp===g.id?\"checked\":\"\")+\" onchange=\\\"pickGrp('\"+g.id+\"',this.checked)\\\"></td>\";\n    html += \"<td></td><td>\"+g.name+\"</td><td>\"+n+\"</td><td>\"+out+\"</td><td>\"+peerLabel(g)+\"</td></tr>\";\n  }\n  tb.innerHTML = html || \"<tr><td colspan=\\\"5\\\" style=\\\"text-align:center;color:#475569;padding:1.2rem\\\">暂无通话组，请先添加</td></tr>\";\n}\nfunction renderGatewaysTable(){\n  var tb=$(\"wtb\"); if(!tb) return;\n  var live=liveMap(); var html=\"\";\n  for(var i=0;i<W.length;i++){\n    var x=W[i]; var L=live[String(x.ext)];\n    var online=isOnline(x.ext, live);\n    var talking = !!talkingSet()[String(x.ext)];\n    var dot = online ? \"<span class=\\\"dot dot-on\\\"></span>\" : \"<span class=\\\"dot dot-off\\\"></span>\";\n    var tr = online && L && L.transport ? String(L.transport).toUpperCase() : \"-\";\n    var rtt = (online && L) ? fmtRtt(L) : \"-\";\n    var used = groupsUsingGw(x.ext);\n    var cls = (selGw===String(x.ext)?\"sel\":\"\")+(talking?\" talking\":\"\");\n    html += \"<tr class=\\\"\"+cls.trim()+\"\\\"\"+(talking?\" style=\\\"animation-delay:\"+talkDelay()+\"\\\"\":\"\")+\">\";\n    html += \"<td><input class=\\\"rowchk\\\" type=\\\"checkbox\\\" \"+(selGw===String(x.ext)?\"checked\":\"\")+\" onchange=\\\"pickGw('\"+x.ext+\"',this.checked)\\\"></td>\";\n    html += \"<td style=\\\"text-align:center\\\">\"+dot+\"</td>\";\n    html += \"<td>\"+x.ext+\"</td><td>\"+x.name+\"</td>\";\n    html += \"<td>\"+(x.public_number||\"-\")+\"</td>\";\n    html += \"<td>\"+(x.inbound_fwd||\"-\")+\"</td>\";\n    html += \"<td>\"+(x.sms_fwd||\"-\")+\"</td>\";\n    html += \"<td>\"+(used.length?used.join(\"、\"):\"无\")+\"</td>\";\n    html += \"<td>\"+tr+\"</td><td style=\\\"white-space:nowrap\\\">\"+rtt+\"</td></tr>\";\n  }\n  tb.innerHTML = html || \"<tr><td colspan=\\\"10\\\" style=\\\"text-align:center;color:#475569;padding:1.2rem\\\">暂无网关账户</td></tr>\";\n}\nfunction renderGroupBoxes(){\n  var box=$(\"groupBoxes\"); if(!box) return;\n  var live=liveMap();\n  var html=\"\";\n  function oneBox(gid, title, meta, moveBtns){\n    moveBtns = moveBtns || \"\";\n    var rows=membersOf(gid);\n    var page=GP[gid]||1;\n    var pages=Math.max(1, Math.ceil(rows.length/PAGE_G));\n    if(page>pages) page=pages;\n    GP[gid]=page;\n    var start=(page-1)*PAGE_G;\n    var slice=rows.slice(start, start+PAGE_G);\n    var pager=\"\";\n    if(rows.length>PAGE_G){\n      var prevDis = page<=1 ? \" disabled\" : \"\";\n      var nextDis = page>=pages ? \" disabled\" : \"\";\n      pager=\"<div style=\\\"display:flex;justify-content:flex-end;align-items:center;gap:.55rem;padding:.65rem .7rem 1rem;font-size:.8rem;color:#94a3b8;white-space:nowrap\\\"><span>第 \"+page+\" / \"+pages+\" 页，共 \"+rows.length+\" 个分机</span><button class=\\\"btn-gray\\\"\"+prevDis+\" onclick=\\\"setGPage('\"+gid+\"',\"+(page-1)+\")\\\">上一页</button><button class=\\\"btn-gray\\\"\"+nextDis+\" onclick=\\\"setGPage('\"+gid+\"',\"+(page+1)+\")\\\">下一页</button></div>\";\n    }\n    var cols=\"<colgroup><col class=\\\"c-chk\\\"><col class=\\\"c-on\\\"><col class=\\\"c-ext\\\"><col style=\\\"width:16%\\\"><col style=\\\"width:56px\\\"><col style=\\\"width:22%\\\"><col style=\\\"width:90px\\\"><col style=\\\"width:110px\\\"><col style=\\\"width:72px\\\"><col style=\\\"width:90px\\\"></colgroup>\";\n    var body=\"<table class=\\\"dir-table\\\">\"+cols+\"<thead><tr><th></th><th>在线</th><th>分机号</th><th>名称</th><th>传输</th><th>IP</th><th>延时</th><th>最近上线</th><th>拨打次数</th><th>总通话时长</th></tr></thead><tbody>\";\n    if(!slice.length) body += \"<tr><td colspan=\\\"10\\\" style=\\\"text-align:center;color:#475569;padding:1.2rem\\\">暂无分机</td></tr>\";\n    else for(var i=0;i<slice.length;i++) body += extRowHtml(slice[i], live);\n    body += \"</tbody></table>\";\n    html += \"<div style=\\\"border-radius:.8rem;background:rgba(15,23,42,.6);border:1px solid #1e293b\\\">\";\n    html += \"<div style=\\\"display:flex;justify-content:space-between;align-items:center;padding:1rem .7rem .8rem;gap:1rem;flex-wrap:wrap\\\">\";\n    html += \"<div><h3 style=\\\"font-weight:700;margin:0;font-size:1rem\\\">\"+title+\"</h3><p style=\\\"font-size:.8rem;color:#94a3b8;margin:.35rem 0 0\\\">\"+meta+\"</p></div>\";\n    html += moveBtns;\n    html += \"</div><div style=\\\"overflow-x:auto\\\">\"+body+\"</div>\"+pager+\"</div>\";\n  }\n  for(var i=0;i<G.length;i++){\n    var g=G[i];\n    var mem=membersOf(g.id);\n    var on=0; for(var j=0;j<mem.length;j++) if(isOnline(mem[j].ext, live)) on++;\n    var out = g.gateway ? g.gateway : \"无\";\n    var upDis = i===0 ? \" disabled\" : \"\";\n    var downDis = i===G.length-1 ? \" disabled\" : \"\";\n    var moveBtns = \"<div style=\\\"display:flex;gap:.4rem\\\">\"+\n      \"<button class=\\\"btn-icon\\\" title=\\\"上移\\\" onclick=\\\"moveGrp('\"+g.id+\"',-1)\\\"\"+upDis+\"><svg width=\\\"14\\\" height=\\\"14\\\" viewBox=\\\"0 0 24 24\\\" fill=\\\"none\\\" stroke=\\\"currentColor\\\" stroke-width=\\\"2.4\\\" stroke-linecap=\\\"round\\\" stroke-linejoin=\\\"round\\\"><polyline points=\\\"18 15 12 9 6 15\\\"></polyline></svg></button>\"+\n      \"<button class=\\\"btn-icon\\\" title=\\\"下移\\\" onclick=\\\"moveGrp('\"+g.id+\"',1)\\\"\"+downDis+\"><svg width=\\\"14\\\" height=\\\"14\\\" viewBox=\\\"0 0 24 24\\\" fill=\\\"none\\\" stroke=\\\"currentColor\\\" stroke-width=\\\"2.4\\\" stroke-linecap=\\\"round\\\" stroke-linejoin=\\\"round\\\"><polyline points=\\\"6 9 12 15 18 9\\\"></polyline></svg></button>\"+\n      \"</div>\";\n    oneBox(g.id, g.name, mem.length+\" 人 · \"+on+\" 在线 · 外呼：\"+out+\" · \"+peerLabel(g), moveBtns);\n  }\n  var none=membersOf(\"__none\");\n  var onn=0; for(var k=0;k<none.length;k++) if(isOnline(none[k].ext, live)) onn++;\n  oneBox(\"__none\", \"未分组\", none.length+\" 人 · \"+onn+\" 在线 · 外呼：无 · 仅未分组互打\", \"\");\n  box.innerHTML = html;\n}\nfunction moveGrp(id, dir){\n  var i=-1;\n  for(var k=0;k<G.length;k++) if(G[k].id===id) i=k;\n  var j=i+dir;\n  if(i<0 || j<0 || j>=G.length) return;\n  var t=G[i]; G[i]=G[j]; G[j]=t;\n  saveAll();\n}\nfunction setGPage(gid, page){ if(page<1) page=1; GP[gid]=page; renderGroupBoxes(); }\nfunction pickExt(ext,on){ selExt = on ? String(ext) : (selExt===String(ext)?\"\":selExt); renderGroupBoxes(); }\nfunction pickGw(ext,on){ selGw = on ? String(ext) : (selGw===String(ext)?\"\":selGw); renderGatewaysTable(); }\nfunction pickGrp(id,on){ selGrp = on ? id : (selGrp===id?\"\":selGrp); renderGroupsTable(); }\nfunction fillGroupSelect(sel, cur, includeNone){\n  var html = includeNone ? \"<option value=\\\"\\\">未分组</option>\" : \"<option value=\\\"\\\">无</option>\";\n  for(var i=0;i<G.length;i++) html += \"<option value=\\\"\"+G[i].id+\"\\\">\"+G[i].name+\"</option>\";\n  sel.innerHTML = html;\n  sel.value = cur || \"\";\n}\nfunction fillExtSelect(sel, cur){\n  var html = \"<option value=\\\"\\\">（不转发）</option>\";\n  for(var i=0;i<E.length;i++) html += \"<option value=\\\"\"+E[i].ext+\"\\\">\"+E[i].ext+\" \"+(E[i].name||\"\")+\"</option>\";\n  sel.innerHTML = html;\n  sel.value = cur || \"\";\n}\nfunction extRow(ext){\n  for(var i=0;i<E.length;i++) if(String(E[i].ext)===String(ext)) return E[i];\n  return null;\n}\nfunction groupIdOf(ext){\n  var x = extRow(ext);\n  return x ? (x.group_id || \"\") : \"\";\n}\nfunction fillSmsSelect(sel, inbound, cur){\n  var gid = inbound ? groupIdOf(inbound) : null;\n  var html = \"<option value=\\\"\\\">（不转发）</option>\";\n  for(var i=0;i<E.length;i++){\n    var x=E[i];\n    if(inbound && (x.group_id||\"\")!==gid) continue;\n    html += \"<option value=\\\"\"+x.ext+\"\\\">\"+x.ext+\" \"+(x.name||\"\")+(x.sms?\"\":\" （无短信权限）\")+\"</option>\";\n  }\n  sel.innerHTML = html;\n  if(cur){\n    var ok=false;\n    for(var j=0;j<sel.options.length;j++) if(sel.options[j].value===String(cur)) ok=true;\n    sel.value = ok ? cur : \"\";\n  } else sel.value = \"\";\n}\nfunction onInFwdChange(){\n  fillSmsSelect($(\"wSms\"), $(\"wIn\").value, $(\"wSms\").value);\n}\nfunction fillGwSelect(sel, cur){\n  var html = \"<option value=\\\"\\\">无</option>\";\n  for(var i=0;i<W.length;i++) html += \"<option value=\\\"\"+W[i].ext+\"\\\">\"+W[i].ext+\" \"+(W[i].name||\"\")+\"</option>\";\n  sel.innerHTML = html;\n  sel.value = cur || \"\";\n}\nfunction fillExtForm(x){\n  $(\"eExt\").value=x.ext||\"\"; $(\"eName\").value=x.name||\"\"; $(\"ePw\").value=\"\";\n  fillGroupSelect($(\"eGroup\"), x.group_id||\"\", true);\n  $(\"eOut\").value=x.outbound===false?\"0\":\"1\";\n  $(\"eSms\").value=x.sms?\"1\":\"0\"; $(\"eCf\").value=x.cf||\"\"; $(\"eCfb\").value=x.cf_busy||\"\"; $(\"eCfu\").value=x.cf_noreply||\"\";\n  $(\"eRing\").value=x.ringtimer||60;\n}\nfunction openExt(gid){\n  editingExt=\"\"; $(\"extTitle\").innerText=\"添加分机\"; $(\"eExt\").readOnly=false;\n  var pre = (gid && gid!==\"__none\") ? gid : \"\";\n  fillExtForm({outbound:true,sms:false,ringtimer:60,group_id:pre});\n  $(\"ePw\").placeholder=\"新分机必须填写密码\"; show(\"extWrap\");\n}\nfunction editSelExt(){\n  if(!selExt){ alert(\"请先勾选一个分机\"); return; }\n  var x=null; for(var i=0;i<E.length;i++) if(String(E[i].ext)===selExt) x=E[i];\n  if(!x){ alert(\"未找到该分机\"); return; }\n  editingExt=selExt; $(\"extTitle\").innerText=\"编辑分机 \"+x.ext; $(\"eExt\").readOnly=true;\n  fillExtForm(x); $(\"ePw\").placeholder=x.has_password?\"已有密码，留空则不修改\":\"请设置密码\"; show(\"extWrap\");\n}\nfunction saveExt(){\n  var n={ ext:$(\"eExt\").value.trim(), name:$(\"eName\").value.trim(), group_id:$(\"eGroup\").value, outbound:$(\"eOut\").value===\"1\", sms:$(\"eSms\").value===\"1\", cf:$(\"eCf\").value.trim(), cf_busy:$(\"eCfb\").value.trim(), cf_noreply:$(\"eCfu\").value.trim(), ringtimer:parseInt($(\"eRing\").value,10)||60 };\n  var pw=$(\"ePw\").value;\n  if(!n.ext){ alert(\"分机号不能为空\"); return; }\n  if(!/^[0-9]{3,6}$/.test(n.ext)){ alert(\"分机号必须是 3 到 6 位数字\"); return; }\n  for(var i=0;i<W.length;i++) if(String(W[i].ext)===n.ext){ alert(\"该号码已是网关账户\"); return; }\n  if(!editingExt && !pw){ alert(\"新分机必须设置密码\"); return; }\n  if(pw) n.password=pw;\n  if(editingExt){\n    for(var j=0;j<E.length;j++) if(String(E[j].ext)===editingExt){ n.has_password=!!(pw||E[j].has_password); E[j]=n; }\n  } else {\n    for(var k=0;k<E.length;k++) if(String(E[k].ext)===n.ext){ alert(\"分机号已存在\"); return; }\n    n.has_password=!!pw; E.push(n); selExt=n.ext;\n  }\n  hide(\"extWrap\"); saveAll();\n}\nfunction delSelExt(){\n  if(!selExt){ alert(\"请先勾选一个分机\"); return; }\n  var x=null; for(var i=0;i<E.length;i++) if(String(E[i].ext)===selExt) x=E[i];\n  if(!x) return;\n  if(!confirm(\"确定删除分机 \"+x.ext+\"（\"+(x.name||\"\")+\"）？\\n将同步删除 SIP 机上的 Asterisk 分机账号。\")) return;\n  E = E.filter(function(e){ return String(e.ext)!==selExt; });\n  selExt=\"\"; saveAll();\n}\nfunction togglePeers(){\n  $(\"gPeerBox\").style.display = $(\"gInt\").value===\"peers\" ? \"block\" : \"none\";\n}\nfunction openGrp(){\n  editingGrp=\"\"; $(\"grpTitle\").innerText=\"添加通话组\"; $(\"gName\").value=\"\";\n  fillGwSelect($(\"gGw\"), \"\"); $(\"gInt\").value=\"self\";\n  renderPeerChecks([]); togglePeers(); show(\"grpWrap\");\n}\nfunction editSelGrp(){\n  if(!selGrp){ alert(\"请先勾选一个通话组\"); return; }\n  var g=grpOf(selGrp); if(!g) return;\n  editingGrp=g.id; $(\"grpTitle\").innerText=\"编辑通话组\"; $(\"gName\").value=g.name||\"\";\n  fillGwSelect($(\"gGw\"), g.gateway||\"\"); $(\"gInt\").value=g.internal||\"self\";\n  renderPeerChecks(g.peers||[]); togglePeers(); show(\"grpWrap\");\n}\nfunction renderPeerChecks(selected){\n  var html=\"\";\n  for(var i=0;i<G.length;i++){\n    if(editingGrp && G[i].id===editingGrp) continue;\n    var on = selected.indexOf(G[i].id)>=0;\n    html += \"<label style=\\\"display:flex;gap:.5rem;align-items:center;font-size:.85rem\\\"><input type=\\\"checkbox\\\" class=\\\"peerchk\\\" value=\\\"\"+G[i].id+\"\\\" \"+(on?\"checked\":\"\")+\"> \"+G[i].name+\"</label>\";\n  }\n  if(!html) html = \"<span style=\\\"color:#64748b;font-size:.8rem\\\">还没有其他通话组</span>\";\n  $(\"gPeers\").innerHTML = html;\n}\nfunction saveGrp(){\n  var name=$(\"gName\").value.trim();\n  if(!name){ alert(\"请填写组名\"); return; }\n  var peers=[];\n  var boxes=$(\"gPeers\").querySelectorAll(\".peerchk\");\n  for(var i=0;i<boxes.length;i++) if(boxes[i].checked) peers.push(boxes[i].value);\n  var g={ id: editingGrp || (\"g\"+Date.now()), name:name, gateway:$(\"gGw\").value, internal:$(\"gInt\").value, peers: $(\"gInt\").value===\"peers\"?peers:[] };\n  if(editingGrp){\n    for(var j=0;j<G.length;j++) if(G[j].id===editingGrp) G[j]=g;\n  } else { G.push(g); selGrp=g.id; }\n  hide(\"grpWrap\"); saveAll();\n}\nfunction delSelGrp(){\n  if(!selGrp){ alert(\"请先勾选一个通话组\"); return; }\n  var g=grpOf(selGrp); if(!g) return;\n  if(!confirm(\"确定删除通话组「\"+g.name+\"」？组内分机将变为未分组。\")) return;\n  for(var i=0;i<E.length;i++) if(E[i].group_id===selGrp) E[i].group_id=\"\";\n  G = G.filter(function(x){ return x.id!==selGrp; });\n  selGrp=\"\"; saveAll();\n}\nfunction openGw(){\n  editingGw=\"\"; $(\"gwTitle\").innerText=\"添加网关\"; $(\"wExt\").readOnly=false;\n  $(\"wExt\").value=\"\"; $(\"wName\").value=\"\"; $(\"wPw\").value=\"\"; $(\"wNum\").value=\"\";\n  fillExtSelect($(\"wIn\"), \"\"); fillSmsSelect($(\"wSms\"), \"\", \"\");\n  $(\"wUsed\").innerText=\"无\"; $(\"wPw\").placeholder=\"新网关必须填写密码\"; show(\"gwWrap\");\n}\nfunction editSelGw(){\n  if(!selGw){ alert(\"请先勾选一个网关\"); return; }\n  var x=null; for(var i=0;i<W.length;i++) if(String(W[i].ext)===selGw) x=W[i];\n  if(!x) return;\n  editingGw=selGw; $(\"gwTitle\").innerText=\"编辑网关 \"+x.ext; $(\"wExt\").readOnly=true;\n  $(\"wExt\").value=x.ext; $(\"wName\").value=x.name||\"\"; $(\"wPw\").value=\"\"; $(\"wNum\").value=x.public_number||\"\";\n  fillExtSelect($(\"wIn\"), x.inbound_fwd||\"\");\n  fillSmsSelect($(\"wSms\"), x.inbound_fwd||\"\", x.sms_fwd||x.inbound_fwd||\"\");\n  var used=groupsUsingGw(x.ext); $(\"wUsed\").innerText=used.length?used.join(\"、\"):\"无\";\n  $(\"wPw\").placeholder=x.has_password?\"已有密码，留空则不修改\":\"请设置密码\"; show(\"gwWrap\");\n}\nfunction saveGw(){\n  var n={ ext:$(\"wExt\").value.trim(), name:$(\"wName\").value.trim(), public_number:$(\"wNum\").value.trim(), inbound_fwd:$(\"wIn\").value, sms_fwd:$(\"wSms\").value };\n  var pw=$(\"wPw\").value;\n  if(!n.ext){ alert(\"分机号不能为空\"); return; }\n  if(!/^[0-9]{3,6}$/.test(n.ext)){ alert(\"分机号必须是 3 到 6 位数字\"); return; }\n  for(var i=0;i<E.length;i++) if(String(E[i].ext)===n.ext){ alert(\"该号码已是内网分机\"); return; }\n  if(n.inbound_fwd && !extRow(n.inbound_fwd)){ alert(\"呼入转发目标必须是内网分机\"); return; }\n  if(n.sms_fwd && !extRow(n.sms_fwd)){ alert(\"短信转发目标必须是内网分机\"); return; }\n  if(n.inbound_fwd && n.sms_fwd && n.inbound_fwd!==n.sms_fwd && groupIdOf(n.inbound_fwd)!==groupIdOf(n.sms_fwd)){\n    alert(\"呼入和短信转发必须指向同一通话组的分机，这样短信回程仍走这台网关。\");\n    return;\n  }\n  if(n.sms_fwd && !extRow(n.sms_fwd).sms){ alert(\"短信转发目标分机需要先打开短信权限\"); return; }\n  if(!editingGw && !pw){ alert(\"新网关必须设置密码\"); return; }\n  if(pw) n.password=pw;\n  if(editingGw){\n    for(var j=0;j<W.length;j++) if(String(W[j].ext)===editingGw){ n.has_password=!!(pw||W[j].has_password); W[j]=n; }\n  } else {\n    for(var k=0;k<W.length;k++) if(String(W[k].ext)===n.ext){ alert(\"网关分机号已存在\"); return; }\n    n.has_password=!!pw; W.push(n); selGw=n.ext;\n  }\n  hide(\"gwWrap\"); saveAll();\n}\nfunction delSelGw(){\n  if(!selGw){ alert(\"请先勾选一个网关\"); return; }\n  if(W.length<=1){ alert(\"至少保留一个网关账户\"); return; }\n  var x=null; for(var i=0;i<W.length;i++) if(String(W[i].ext)===selGw) x=W[i];\n  if(!x) return;\n  if(!confirm(\"确定删除网关 \"+x.ext+\"（\"+(x.name||\"\")+\"）？\")) return;\n  for(var j=0;j<G.length;j++) if(String(G[j].gateway)===selGw) G[j].gateway=\"\";\n  W = W.filter(function(e){ return String(e.ext)!==selGw; });\n  selGw=\"\"; saveAll();\n}\nfunction openCdr(ext){ cdrExt=String(ext); cdrPage=1; $(\"cdrTitle\").innerText=\"分机 \"+ext+\" 通话记录\"; show(\"cdrWrap\"); drawCdr(); }\nfunction drawCdr(){\n  var rows = cdrFor(cdrExt);\n  var total = rows.length; var pages = Math.max(1, Math.ceil(total/PAGE));\n  if(cdrPage>pages) cdrPage=pages; if(cdrPage<1) cdrPage=1;\n  var start=(cdrPage-1)*PAGE; var slice=rows.slice(start, start+PAGE);\n  var html=\"\";\n  if(!slice.length){ html=\"<tr><td colspan=\\\"9\\\" style=\\\"text-align:center;color:#475569;padding:1.5rem\\\">暂无通话</td></tr>\"; }\n  else {\n    for(var i=0;i<slice.length;i++){\n      var r=slice[i];\n      var qc = r.quality===\"好\"?\"ok\":(r.quality===\"差\"?\"bad\":\"warn\");\n      html += \"<tr>\";\n      html += \"<td style=\\\"white-space:nowrap\\\">\"+fmtTime(r.time)+\"</td>\";\n      html += \"<td>\"+r.src+\"</td><td>\"+r.dst+\"</td>\";\n      html += \"<td>\"+(r.disposition||\"-\")+\"</td>\";\n      html += \"<td>\"+fmtDur(r.billsec||r.duration)+\"</td>\";\n      html += \"<td class=\\\"\"+qc+\"\\\">\"+(r.quality||\"-\")+\"</td>\";\n      html += \"<td>\"+(r.media_rtt||\"-\")+\"</td>\";\n      html += \"<td>\"+(r.jitter||\"-\")+\"</td>\";\n      html += \"<td>\"+(r.loss||\"-\")+\"</td>\";\n      html += \"</tr>\";\n    }\n  }\n  $(\"cdrBody\").innerHTML = html;\n  var pg = \"第 \"+cdrPage+\" / \"+pages+\" 页，共 \"+total+\" 条\";\n  pg += \" <span><button class=\\\"btn-gray\\\" onclick=\\\"cdrPage--;drawCdr()\\\">上一页</button> \";\n  pg += \"<button class=\\\"btn-gray\\\" onclick=\\\"cdrPage++;drawCdr()\\\">下一页</button></span>\";\n  $(\"cdrPager\").innerHTML = pg;\n}\ndocument.addEventListener(\"keydown\", function(e){ if(e.key===\"Enter\" && $(\"loginWrap\").style.display!==\"none\") doLogin(); });\nsetInterval(function(){ if(localStorage.getItem(\"_pt\")) loadSip(); }, 2000);\ncheckAuth();\n";
}
