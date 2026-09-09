const COOKIE = "elf_admin";
const ITERATIONS = 100000;
const SESSION_MS = 14 * 86400000;
const enc = new TextEncoder();

function hex(bytes) {
  return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, "0")).join("");
}
function random() { return hex(crypto.getRandomValues(new Uint8Array(32))); }
async function digest(value) { return hex(await crypto.subtle.digest("SHA-256", enc.encode(value))); }
async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: ITERATIONS }, key, 256));
}
function equal(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function cookie(value, age) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
}
export function authJson(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra
  } });
}
export function trustedOrigin(request) {
  const origin = request.headers.get("Origin");
  return request.headers.get("Sec-Fetch-Site") !== "cross-site"
    && (!origin || origin === new URL(request.url).origin);
}
export function isMachineRoute(path, method) {
  return new Set([
    "GET /api/sip/pull", "POST /api/sip/heartbeat",
    "POST /api/devices/enroll", "GET /api/devices/enroll-status", "POST /api/devices/report",
    "POST /api/devices/push-config", "POST /api/devices/push-sync",
    "POST /api/elfremote/update-progress", "POST /api/elfremote/task-progress", "GET /api/elfremote/file-download", "POST /api/elfremote/report-photo",
    "POST /api/elfremote/file-return", "PUT /api/elfremote/file-return"
  ]).has(`${method} ${path}`) || (method === "GET" && /^\/api\/elfremote\/apk\/[^/]+$/.test(path));
}
async function jsonInput(request) {
  const text = await request.text();
  if (text.length > 8192) throw new Error("请求过大");
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求格式错误");
  return value;
}
async function legacyValue(storage, env, key) {
  const value = await storage.get(key);
  if (value !== undefined && value !== null) return value;
  const raw = await env.SUB_STORE_KV?.get(key);
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}
async function credentials(storage, env) {
  const existing = await storage.get("admin_auth");
  if (existing) return existing;
  // 仅迁移真实存储或显式配置，禁止重新启用代码中的默认密码。
  const username = await legacyValue(storage, env, "admin_user") || env.ADMIN_USER || "admin";
  const password = await legacyValue(storage, env, "admin_pass") || env.ADMIN_PASSWORD;
  if (typeof username !== "string" || !username || typeof password !== "string" || !password) return null;
  const salt = random();
  const result = { username, salt, hash: await passwordHash(password, salt), revision: random() };
  await storage.put("admin_auth", result);
  await storage.put("admin_user", username);
  await storage.delete("admin_pass");
  if (env.SUB_STORE_KV?.delete) await env.SUB_STORE_KV.delete("admin_pass");
  return result;
}
async function sessionKey(request) {
  const token = (request.headers.get("Cookie") || "").split(";").map(s => s.trim())
    .find(s => s.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? "auth/session/" + await digest(token) : null;
}
async function validSession(storage, request, now) {
  const key = await sessionKey(request);
  if (!key) return false;
  const [entry, auth] = await Promise.all([storage.get(key), storage.get("admin_auth")]);
  if (entry && auth && entry.expires > now && entry.revision === auth.revision) return true;
  if (entry) await storage.delete(key);
  return false;
}

// 由现有 Durable Object 串行调用，迁移、改密码与会话变更不会相互覆盖。
export async function handleAdminAuth(storage, env, request, now = Date.now()) {
  const action = new URL(request.url).pathname;
  try {
    if (action === "/__auth/login" && request.method === "POST") {
      const body = await jsonInput(request);
      const peer = await digest(request.headers.get("CF-Connecting-IP") || "local");
      const failures = (await storage.get("auth/failures")) || [];
      const recent = failures.filter(e => e.until > now);
      const bucket = recent.find(e => e.peer === peer);
      if (bucket?.count >= 8) return authJson({ ok: false, msg: "登录失败次数过多，请稍后重试" }, 429, { "Retry-After": "60" });
      const auth = await credentials(storage, env);
      if (!auth) return authJson({ ok: false, msg: "管理员登录尚未配置" }, 503);
      const inputOk = typeof body.username === "string" && typeof body.password === "string" && body.password.length <= 1024;
      const hash = await passwordHash(inputOk ? body.password : "", auth.salt);
      if (!inputOk || !equal(hash, auth.hash) || body.username !== auth.username) {
        if (bucket) bucket.count++;
        else recent.push({ peer, count: 1, until: now + 60000 });
        await storage.put("auth/failures", recent.slice(-128));
        return authJson({ ok: false, msg: "账号或密码错误" }, 401);
      }
      await storage.put("auth/failures", recent.filter(e => e.peer !== peer));
      const old = await storage.list({ prefix: "auth/session/" });
      for (const [key, value] of old) if (value.expires <= now || value.revision !== auth.revision) await storage.delete(key);
      const token = random();
      await storage.put("auth/session/" + await digest(token), { revision: auth.revision, expires: now + SESSION_MS });
      return authJson({ ok: true }, 200, { "Set-Cookie": cookie(token, SESSION_MS / 1000) });
    }
    if (action === "/__auth/logout" && request.method === "POST") {
      const key = await sessionKey(request);
      if (key) await storage.delete(key);
      return authJson({ ok: true }, 200, { "Set-Cookie": cookie("", 0) });
    }
    if (!await validSession(storage, request, now)) return authJson({ ok: false, msg: "请先登录" }, 401);
    if (action === "/__auth/password" && request.method === "POST") {
      const { password } = await jsonInput(request);
      if (typeof password !== "string" || !password || password.length > 1024) return authJson({ ok: false, msg: "密码长度无效" }, 400);
      const auth = await storage.get("admin_auth");
      const salt = random();
      await storage.put("admin_auth", { username: auth.username, salt, hash: await passwordHash(password, salt), revision: random() });
      await storage.delete("admin_pass");
      if (env.SUB_STORE_KV?.delete) await env.SUB_STORE_KV.delete("admin_pass");
      return authJson({ ok: true, credentials_changed: true }, 200, { "Set-Cookie": cookie("", 0) });
    }
    if (action === "/__auth/session" && request.method === "GET") return authJson({ ok: true });
    return authJson({ ok: false, msg: "接口不存在" }, 404);
  } catch {
    return authJson({ ok: false, msg: "登录服务请求失败" }, 400);
  }
}

export async function adminRpc(env, request, action, body) {
  if (!env.ELF_DO) return authJson({ ok: false, msg: "登录存储不可用" }, 503);
  const headers = new Headers(request.headers);
  headers.delete("Content-Length");
  const method = action === "session" ? "GET" : "POST";
  return env.ELF_DO.get(env.ELF_DO.idFromName("main")).fetch(new Request("https://elf-store/__auth/" + action, {
    method, headers, ...(method === "POST" ? { body: body === undefined ? await request.text() : JSON.stringify(body) } : {})
  }));
}
