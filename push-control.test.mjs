import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import worker from "./worker.js";
import { fixture, login, request } from "./test-support.mjs";
import { brokerCall } from "./push-control.js";

const token = "fixture-device-token";
function setup() {
  const f = fixture({ admin_pass: "fixture-password", remote_devices: [{ id: "fixture-device", enabled: true,
    token_sha256: createHash("sha256").update(token).digest("hex") }] });
  f.env.MQTT_API_URL = "https://broker.example.test";
  f.env.MQTT_API_TOKEN = "fixture-api-token";
  f.calls = [];
  f.env.MQTT_FETCH = async (url, init) => {
    const body = JSON.parse(init.body);
    f.calls.push({ url: String(url), body });
    assert.equal(init.headers.Authorization, "Bearer fixture-api-token");
    assert.equal(init.redirect, "manual");
    if (String(url).endsWith("credentials")) return Response.json({ ok: true, connection: {
      username: body.username, password: "fixture-mqtt-password", tls: true, host: "mqtt.example.test" } });
    assert.ok(f.data.get("push/request/fixture-device"), "发布前请求必须已持久化");
    return Response.json({ ok: true, accepted: true, request_id: body.notification.request_id });
  };
  return f;
}
const deviceBody = { device_id: "fixture-device", token };
const call = (f, path, body, cookie) => worker.fetch(request(path, "POST", body, cookie), f.env);

test('媒体邀请在认证同步时立即领取，不依赖定位和报告，跨设备及伪造凭据不可领取',async()=>{
  const f=setup(),cookie=await login(f);f.data.get('remote_devices')[0].managed_media=true;
  const r=await call(f,'/api/elfremote/media/session',{device_id:deviceBody.device_id,mode:'photo'},cookie);
  assert.equal(r.status,200);const created=await r.json();
  const sync=await (await call(f,'/api/devices/push-sync',deviceBody)).json();
  assert.equal(sync.media_session.session_id,created.session_id);assert.ok(sync.media_session.token);
  assert.equal(f.data.get('remote_devices')[0].last_reported_at,undefined);
  assert.equal((await call(f,'/api/devices/push-sync',{...deviceBody,token:'wrong'})).status,401);
  const denied=await worker.fetch(request('/api/elfremote/media/session','DELETE',{session_id:created.session_id}),f.env);assert.equal(denied.status,401);
  assert.equal((await worker.fetch(request('/api/elfremote/media/session','DELETE',{session_id:created.session_id},cookie),f.env)).status,200);
  assert.equal((await (await call(f,'/api/devices/push-sync',deviceBody)).json()).media_session,null);
});

test("通知领取回执认证并匹配编号版本，幂等且不冒充完整报告", async () => {
  const f=setup(), cookie=await login(f);
  const prepared=await (await call(f,'/api/devices/request-status',deviceBody,cookie)).json();
  const receipt={...deviceBody,received_request_id:prepared.request.request_id,received_version:prepared.request.version};
  assert.equal((await call(f,'/api/devices/push-sync',{...receipt,token:'bad'})).status,401);
  await call(f,'/api/devices/push-sync',{...receipt,received_version:receipt.received_version+1});
  assert.equal(f.data.get('push/request/fixture-device').received_at,undefined);
  await call(f,'/api/devices/push-sync',receipt);
  const first=f.data.get('push/request/fixture-device');
  assert.ok(first.received_at);assert.equal(first.state,'pending');
  await call(f,'/api/devices/push-sync',receipt);
  assert.equal(f.data.get('push/request/fixture-device').received_at,first.received_at);
});

test("真实运行时 fetch 保留全局接收者，不能使用脱离对象的调用", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async function (url) {
    assert.equal(this, globalThis);
    assert.equal(url, "https://broker.example.test/v1/publish");
    return Response.json({ ok: true });
  };
  try { await brokerCall({ MQTT_API_URL: "https://broker.example.test", MQTT_API_TOKEN: "fixture" }, "/v1/publish", {}); }
  finally { globalThis.fetch = previous; }
});

test("发布入口重定向被拒绝，不向新地址发送服务凭据", async () => {
  let calls = 0;
  await assert.rejects(brokerCall({ MQTT_API_URL: "https://broker.example.test", MQTT_API_TOKEN: "fixture",
    MQTT_FETCH: async (url, options) => {
      calls++;
      assert.equal(options.redirect, "manual");
      return new Response(null, { status: 302, headers: { Location: "https://other.example.test" } });
    } }, "/v1/credentials", {}));
  assert.equal(calls, 1);
});

test("设备获取自己的连接配置，不需要浏览器会话，错误凭据无副作用", async () => {
  const f = setup();
  assert.equal((await call(f, "/api/devices/push-config", { ...deviceBody, token: "bad" })).status, 401);
  assert.equal(f.calls.length, 0);
  const response = await call(f, "/api/devices/push-config", deviceBody);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const body = await response.json();
  assert.match(body.connection.username, /^d_[a-f0-9]{64}$/);
  assert.equal(body.connection.password, "fixture-mqtt-password");
  assert.equal(JSON.stringify([...f.data]).includes("fixture-mqtt-password"), false);
});

test("管理请求先保存再发布，重复点击合并，设备上报才完成", async () => {
  const f = setup(), cookie = await login(f);
  assert.equal((await call(f, "/api/devices/request-status", deviceBody)).status, 401);
  const first = await (await call(f, "/api/devices/request-status", deviceBody, cookie)).json();
  assert.equal(first.request.state, "pending");
  assert.equal(first.request.published, true);
  const again = await (await call(f, "/api/devices/request-status", deviceBody, cookie)).json();
  assert.equal(again.request.request_id, first.request.request_id);
  assert.equal(f.calls.length, 1);
  const synced = await (await call(f, "/api/devices/push-sync", deviceBody)).json();
  assert.equal(synced.status_request.request_id, first.request.request_id);
  const report = { ...deviceBody, status_only: true, report_id: "fixture-report", status_request_id: first.request.request_id };
  assert.equal((await call(f, "/api/devices/report", report)).status, 200);
  assert.equal(f.data.get("push/request/fixture-device").state, "completed");
  assert.equal((await (await call(f, "/api/devices/push-sync", deviceBody)).json()).status_request, null);
});

test("发布失败仍可补领，不能声称设备已收到", async () => {
  const f = setup(), cookie = await login(f);
  f.env.MQTT_FETCH = async () => { throw new Error("fixture-secret-error"); };
  const response = await call(f, "/api/devices/request-status", deviceBody, cookie);
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.request.state, "pending");
  assert.equal(body.request.published, false);
  assert.equal(JSON.stringify(body).includes("fixture-secret-error"), false);
  assert.ok((await (await call(f, "/api/devices/push-sync", deviceBody)).json()).status_request);
});

test("存储失败不发布，过期和错误关联号不完成请求", async () => {
  const f = setup(), cookie = await login(f);
  const put = f.storage.put;
  f.storage.put = async (k, v) => { if (k.startsWith("push/request/")) throw new Error("disk"); return put(k, v); };
  assert.equal((await call(f, "/api/devices/request-status", deviceBody, cookie)).status, 503);
  assert.equal(f.calls.length, 0);
  f.storage.put = put;
  await call(f, "/api/devices/request-status", deviceBody, cookie);
  await call(f, "/api/devices/report", { ...deviceBody, status_only: true, report_id: "wrong", status_request_id: "not-current" });
  assert.equal(f.data.get("push/request/fixture-device").state, "pending");
  f.data.get("push/request/fixture-device").expires_at_ms = 1;
  assert.equal((await (await call(f, "/api/devices/push-sync", deviceBody)).json()).status_request, null);
  assert.equal(f.data.get("push/request/fixture-device").state, "expired");
});

test("发放期间解除配对不泄露连接配置，停用设备不能取得配置", async () => {
  const f = setup();
  const fetch = f.env.MQTT_FETCH;
  f.env.MQTT_FETCH = async (...args) => { f.data.set("remote_devices", []); return fetch(...args); };
  const result = await call(f, "/api/devices/push-config", deviceBody);
  assert.equal(result.status, 404);
  assert.equal((await result.text()).includes("fixture-mqtt-password"), false);
  const other = setup();
  other.data.get("remote_devices")[0].enabled = false;
  assert.equal((await call(other, "/api/devices/push-config", deviceBody)).status, 409);
  assert.equal(other.calls.length, 0);
});

test("外部发布等待不占住存储事务，回执不能覆盖并发设备完成状态", async () => {
  const f = setup(), cookie = await login(f);
  let finish, began;
  const started = new Promise(resolve => { began = resolve; });
  f.env.MQTT_FETCH = async (url, init) => {
    const body = JSON.parse(init.body);
    began(body.notification);
    await new Promise(resolve => { finish = resolve; });
    return Response.json({ ok: true, accepted: true, request_id: body.notification.request_id });
  };
  const pending = call(f, "/api/devices/request-status", deviceBody, cookie);
  const notification = await started;
  try {
    const response = await call(f, "/api/devices/report", { ...deviceBody, status_only: true,
      report_id: "concurrent", status_request_id: notification.request_id });
    assert.equal(response.status, 200);
  } finally { finish(); }
  const result = await (await pending).json();
  assert.equal(result.request.state, "completed");
});
