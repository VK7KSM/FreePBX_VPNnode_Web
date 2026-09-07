import { authJson } from "./admin-auth.js";

const TTL = 5 * 60000;
const key = id => "push/request/" + encodeURIComponent(id);
async function digest(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), b => b.toString(16).padStart(2, "0")).join("");
}
async function mqttUsername(id) { return "d_" + await digest(id); }
function fail(status, msg) { throw authJson({ ok: false, msg }, status); }

export async function pendingStatus(storage, id, now = Date.now()) {
  const value = await storage.get(key(id));
  if (!value) return null;
  if (value.state === "pending" && value.expires_at_ms <= now) {
    value.state = "expired";
    await storage.put(key(id), value);
  }
  return value;
}
export function statusNotification(value) {
  return value?.state === "pending" ? { type: "status_request", request_id: value.request_id,
    version: value.version, expires_at_ms: value.expires_at_ms } : null;
}
export async function acknowledgeStatus(storage, deviceId, data, now = Date.now()) {
  if (data.status_only !== true || typeof data.report_id !== "string" || !data.status_request_id) return;
  const current = await pendingStatus(storage, deviceId, now);
  if (current?.state !== "pending" || current.request_id !== data.status_request_id) return;
  current.state = "completed";
  current.completed_at = new Date(now).toISOString();
  current.report_id = data.report_id;
  await storage.put(key(deviceId), current);
}

// 此函数只在 Durable Object 事务内操作状态；联网发布在事务提交之后进行。
export async function pushState(storage, request, loadDevices, now = Date.now()) {
  try {
    const action = new URL(request.url).pathname.slice("/__push/".length);
    const data = await request.json();
    const id = typeof data.device_id === "string" ? data.device_id : "";
    const device = (await loadDevices()).find(d => d.id === id);
    if (!device) fail(404, "未找到该设备");
    if (device.enabled === false) fail(409, "设备已停用");
    if (action === "config" || action === "sync") {
      if (typeof data.token !== "string" || !data.token || await digest(data.token) !== device.token_sha256) fail(401, "设备凭证无效");
      if (action === "config") return authJson({ ok: true, username: await mqttUsername(id) });
      const current = await pendingStatus(storage, id, now);
      if (current?.state === "pending" && data.received_request_id === current.request_id && data.received_version === current.version && !current.received_at) {
        current.received_at = new Date(now).toISOString();
        await storage.put(key(id), current);
      }
      return authJson({ ok: true, status_request: statusNotification(current) });
    }
    if (action === "read") return authJson({ ok: true, request: await pendingStatus(storage, id, now) });
    if (action === "prepare") {
      let current = await pendingStatus(storage, id, now);
      if (current?.state !== "pending") {
        current = { request_id: crypto.randomUUID(), version: (current?.version || 0) + 1,
          state: "pending", created_at: new Date(now).toISOString(), expires_at_ms: now + TTL,
          publish_attempts: 0, published: false };
      }
      const shouldPublish = current.publish_attempts < 3 && (!current.last_publish_at_ms || now - current.last_publish_at_ms >= 5000);
      if (shouldPublish) {
        current.publish_attempts++;
        current.last_publish_at_ms = now;
      }
      await storage.put(key(id), current);
      return authJson({ ok: true, request: current, should_publish: shouldPublish, username: await mqttUsername(id) });
    }
    if (action === "delivery") {
      const current = await pendingStatus(storage, id, now);
      if (current?.request_id === data.request_id && current.last_publish_at_ms === data.attempt_at_ms && current.state === "pending") {
        current.published = data.accepted === true;
        current.publish_result = data.accepted ? "accepted" : "unavailable";
        await storage.put(key(id), current);
      }
      return authJson({ ok: true, request: current });
    }
    return authJson({ ok: false }, 404);
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}

export async function brokerCall(env, path, body) {
  if (!env.MQTT_API_URL || !env.MQTT_API_TOKEN) throw new Error("推送入口未配置");
  const endpoint = new URL(env.MQTT_API_URL);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("推送入口无效");
  const options = {
    method: "POST", headers: { "Authorization": "Bearer " + env.MQTT_API_TOKEN, "Content-Type": "application/json", "User-Agent": "elfRemote-worker/1.0" },
    body: JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(15000)
  };
  const url = new URL(path, endpoint).toString();
  const response = env.MQTT_FETCH ? await env.MQTT_FETCH(url, options) : await globalThis.fetch(url, options);
  if (!response.ok) {
    console.warn("mqtt_api_http_status", response.status);
    throw new Error("推送服务暂不可用");
  }
  const value = await response.json();
  if (value.ok !== true) throw new Error("推送服务返回无效");
  return value;
}

export function isPushHttp(path) {
  return ["/api/devices/push-config", "/api/devices/push-sync", "/api/devices/request-status", "/api/devices/status-request", "/api/devices/delete"].includes(path);
}
export async function pushHttp(env, request, stub) {
  const url = new URL(request.url);
  const read = url.pathname === "/api/devices/status-request";
  if (request.method !== (read ? "GET" : "POST")) return authJson({ ok: false }, 405);
  let data;
  try {
    const text = read ? "" : await request.text();
    if (text.length > 8192) throw new Error();
    data = read ? { device_id: url.searchParams.get("device_id") } : JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
  } catch { return authJson({ ok: false, msg: "请求格式无效" }, 400); }
  const rpc = (action, body = data) => stub.fetch("https://elf-store/__push/" + action, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  if (url.pathname === "/api/devices/delete") {
    let notice;
    if (data.confirm === true && data.id) {
      const prepared = await rpc("prepare", { device_id: data.id });
      if (prepared.ok) notice = await prepared.json();
    }
    const removed = await stub.fetch(new Request(request.url, {
      method: "POST", headers: request.headers, body: JSON.stringify(data)
    }));
    if (removed.ok && notice) {
      // 配对删除提交之后才唤醒；设备上报会得到重新配对指令。
      try { await brokerCall(env, "/v1/publish", { username: notice.username, notification: statusNotification(notice.request) }); }
      catch { /* 离线时由下一次设备报告发现解除配对。 */ }
    }
    return removed;
  }
  const action = { "/api/devices/push-config": "config", "/api/devices/push-sync": "sync",
    "/api/devices/request-status": "prepare", "/api/devices/status-request": "read" }[url.pathname];
  const prepared = await rpc(action);
  if (!prepared.ok || read || action === "sync") return prepared;
  const result = await prepared.json();
  if (action === "config") {
    try {
      const reply = await brokerCall(env, "/v1/credentials", { username: result.username });
      if (reply.connection?.username !== result.username || reply.connection?.tls !== true || !reply.connection?.password) throw new Error();
      // 外部调用期间可能已经解除配对，返回秘密前再校验一次现有配对关系。
      const stillPaired = await rpc("config");
      if (!stillPaired.ok) return stillPaired;
      return authJson({ ok: true, connection: reply.connection });
    } catch (error) {
      console.warn("mqtt_config_failure", error?.name || "Error", error?.stack?.split("\n").slice(1, 3).join("\n"));
      return authJson({ ok: false, msg: "推送配置暂不可用" }, 503);
    }
  }
  if (!result.should_publish) return authJson({ ok: true, request: result.request }, 202);
  let accepted = false;
  try {
    const reply = await brokerCall(env, "/v1/publish", { username: result.username, notification: statusNotification(result.request) });
    accepted = reply.accepted === true && reply.request_id === result.request.request_id;
  } catch { /* 待处理记录已提交，设备重连或周期对账可补领。 */ }
  const recorded = await rpc("delivery", { device_id: data.device_id, request_id: result.request.request_id,
    attempt_at_ms: result.request.last_publish_at_ms, accepted });
  if (!recorded.ok) return recorded;
  return authJson(await recorded.json(), 202);
}
