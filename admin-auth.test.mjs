import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import worker from "./worker.js";
import { fixture, request, login } from "./test-support.mjs";
import { handleAdminAuth, isMachineRoute } from "./admin-auth.js";
import { adminSessionSource } from "./admin-session.js";
import sipSource from "./sip-client-source.js";
import { build } from "esbuild";

test("打包后的会话脚本可在浏览器独立执行", async () => {
  const result = await build({ entryPoints: ["admin-session.js"], bundle: true, write: false, format: "iife", globalName: "sessionModule", keepNames: true });
  const bundled = {};
  vm.runInNewContext(result.outputFiles[0].text, bundled);
  const context = { fetch: async () => new Response('{"ok":true}'), localStorage: { removeItem() {} } };
  context.window = context;
  vm.runInNewContext(bundled.sessionModule.adminSessionSource, context);
  assert.equal(typeof context.adminSession.check, "function");
  context.adminSession.accept();
  assert.equal(context.adminSession.authenticated, true);
});

test("管理路由匿名与伪造标记均不能绕过登录，未知 API 默认保护", async () => {
  const f = fixture();
  const routes = ["/api/data", "/api/save", "/api/sip", "/api/sip/live", "/api/sip/save", "/api/devices", "/api/device-models", "/api/devices/update", "/api/devices/delete", "/api/devices/pair", "/api/elfremote/task", "/api/elfremote/releases", "/api/elfremote/assign", "/api/new-admin-route"];
  for (const path of routes) for (const method of ["GET", "POST"]) {
    const r = await worker.fetch(request(path, method, undefined, "_pt=1; elf_admin=fake"), f.env);
    assert.equal(r.status, 401, method + " " + path);
  }
});

test("旧密码迁移、随机会话和真实读取保存", async () => {
  const f = fixture();
  const c1 = await login(f), c2 = await login(f);
  assert.notEqual(c1, c2);
  assert.equal(f.data.has("admin_pass"), false);
  assert.equal(JSON.stringify([...f.data]).includes("fixture-password"), false);
  assert.equal(JSON.stringify([...f.data]).includes(c1.split("=")[1]), false);
  const save = await worker.fetch(request("/api/save", "POST", { nodes: [{ name: "测试节点" }] }, c1), f.env);
  assert.equal(save.status, 200);
  const read = await worker.fetch(request("/api/data", "GET", undefined, c2), f.env);
  assert.equal((await read.json()).nodes[0].name, "测试节点");
});

test("退出后旧会话失效，Cookie 具备安全属性", async () => {
  const f = fixture();
  const r = await worker.fetch(request("/api/login", "POST", { username: "admin", password: "fixture-password" }), f.env);
  const header = r.headers.get("Set-Cookie");
  for (const term of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) assert.ok(header.includes(term));
  const c = header.split(";")[0];
  assert.equal((await worker.fetch(request("/api/logout", "POST", undefined, c), f.env)).status, 200);
  assert.equal((await worker.fetch(request("/api/session", "GET", undefined, c), f.env)).status, 401);
});

test("改密码撤销所有旧会话且不能从旧 KV 恢复旧口令", async () => {
  const f = fixture();
  f.env.SUB_STORE_KV = { get: async k => k === "admin_pass" ? "stale-password" : null, delete: async () => {} };
  const c1 = await login(f), c2 = await login(f);
  const change = await worker.fetch(request("/api/save", "POST", { new_password: "replacement-password" }, c1), f.env);
  assert.equal((await change.json()).credentials_changed, true);
  for (const c of [c1, c2]) assert.equal((await worker.fetch(request("/api/data", "GET", undefined, c), f.env)).status, 401);
  for (const password of ["fixture-password", "stale-password"]) {
    assert.equal((await worker.fetch(request("/api/login", "POST", { username: "admin", password }), f.env)).status, 401);
  }
  assert.equal((await worker.fetch(request("/api/login", "POST", { username: "admin", password: "replacement-password" }), f.env)).status, 200);
});

test("无配置不启用默认密码，错误登录限频并到期恢复", async () => {
  assert.equal((await worker.fetch(request("/api/login", "POST", { username: "admin", password: "unused" }), fixture({}).env)).status, 503);
  const f = fixture();
  const wrong = () => new Request("https://elf-store/__auth/login", { method: "POST", body: JSON.stringify({ username: "admin", password: "wrong" }) });
  for (let i = 0; i < 8; i++) assert.equal((await handleAdminAuth(f.storage, {}, wrong(), 1000)).status, 401);
  assert.equal((await handleAdminAuth(f.storage, {}, wrong(), 1000)).status, 429);
  assert.equal((await handleAdminAuth(f.storage, {}, wrong(), 62000)).status, 401);
});

test("会话过期、跨站修改、错误方法均被拒绝", async () => {
  const f = fixture();
  const c = await login(f);
  assert.equal((await worker.fetch(request("/api/save", "POST", {}, c, { Origin: "https://other.test" }), f.env)).status, 403);
  assert.equal((await worker.fetch(request("/api/login", "GET"), f.env)).status, 405);
  const expired = await handleAdminAuth(f.storage, {}, new Request("https://elf-store/__auth/session", { headers: { Cookie: c } }), Date.now() + 15 * 86400000);
  assert.equal(expired.status, 401);
});

test("机器接口只豁免准确路径及方法，订阅仍可使用已有令牌", async () => {
  assert.equal(isMachineRoute("/api/devices/report", "POST"), true);
  assert.equal(isMachineRoute("/api/devices/report", "GET"), false);
  assert.equal(isMachineRoute("/api/elfremote/apk/test-job", "GET"), true);
  assert.equal(isMachineRoute("/api/elfremote/apk/test-job/extra", "GET"), false);
  const f = fixture({ sub_token: "test-subscription", nodes: [], sip_heartbeat_token: "test-service" });
  assert.equal((await worker.fetch(request("/sub/test-subscription"), f.env)).status, 200);
  const invalid = await worker.fetch(request("/api/devices/report", "POST", { device_id: "missing", token: "wrong" }), f.env);
  assert.notEqual(invalid.status, 200);
  const sip = await worker.fetch(request("/api/sip/heartbeat", "POST", {}), f.env);
  assert.notEqual(sip.status, 200);
});

test("三页实际下发脚本使用共用会话，SIP 嵌入与源码一致", async () => {
  assert.equal(sipSource, fs.readFileSync(new URL("./sip-client.js", import.meta.url), "utf8").replace(/\r\n/g, "\n"));
  for (const path of ["/", "/sip", "/devices"]) {
    const html = await (await worker.fetch(request(path), fixture().env)).text();
    assert.ok(html.includes('src="/admin-session.js"'), path);
    assert.equal(html.includes('localStorage.setItem("_pt"'), false, path);
    for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
  }
});

test("浏览器标记不会自动登录，管理 API 的 401 自动退回登录", async () => {
  const form = { style: {} };
  const context = { URL, location: { href: "https://example.test/devices", origin: "https://example.test" }, document: { getElementById: () => form }, localStorage: { removeItem() {} }, alert() {} };
  context.window = context;
  context.fetch = async () => new Response('{"ok":false}', { status: 401 });
  vm.runInNewContext(adminSessionSource, context);
  let loaded = false;
  await context.adminSession.check(() => { loaded = true; });
  assert.equal(loaded, false);
  context.adminSession.accept();
  await assert.rejects(context.fetch("/api/devices"));
  assert.equal(context.adminSession.authenticated, false);
  assert.equal(form.style.display, "flex");
});
