import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";
import { fixture, request, login } from "./test-support.mjs";
import { createHash } from "node:crypto";

test("临时身份可报告和推送，配对及解除保持身份，超时仅隐藏未配对设备", async () => {
  const f = fixture(), cookie = await login(f);
  const token = "test-installation-token";
  const body = {token,token_sha256:createHash("sha256").update(token).digest("hex"),device_name:"系统名称",model_hint:"D22"};
  const call = async (path, data, auth = cookie) => (await worker.fetch(request(path, data ? "POST":"GET", data, auth), f.env)).json();
  const registered = await call("/api/devices/enroll", body, undefined);
  assert.ok(registered.device_id);
  assert.equal(registered.paired,false);
  const report = () => call("/api/devices/report", {device_id:registered.device_id,token,status_only:true,
    report_id:crypto.randomUUID(),reported_at:new Date().toISOString(),network:"wifi",battery:88,device_name:"系统名称"}, undefined);
  assert.equal((await report()).ok,true);
  let visible=(await call("/api/devices")).devices;
  assert.equal(visible.length,1);
  assert.equal(visible[0].paired,false);
  assert.equal(visible[0].battery,88);
  assert.equal(JSON.stringify(visible).includes(registered.code),false);
  assert.equal((await call("/api/devices/push-sync", {device_id:registered.device_id,token},undefined)).ok,true);
  const paired=await call("/api/devices/pair",{code:registered.code,name:"备注名",model_id:"mdl_d22"});
  assert.equal(paired.device.id,registered.device_id);
  assert.equal(paired.device.paired,true);
  assert.equal(f.data.get("remote_devices").length,1);
  await call("/api/devices/delete",{id:registered.device_id,confirm:true});
  assert.equal((await report()).paired,false);
  visible=(await call("/api/devices")).devices;
  assert.equal(visible[0].name,"系统名称");
  const renewed=await call("/api/devices/enroll",body,undefined);
  assert.equal(renewed.device_id,registered.device_id);
  assert.notEqual(renewed.code,registered.code);
  const stored=f.data.get("remote_devices");
  stored[0].last_seen=new Date(Date.now()-901000).toISOString();
  f.data.set("remote_devices",stored);
  assert.equal((await call("/api/devices")).devices.length,0);
  stored[0].paired=true; f.data.set("remote_devices",stored);
  visible=(await call("/api/devices")).devices;
  assert.equal(visible.length,1); assert.equal(visible[0].online,false);
});

test("升级已有配对设备保留身份和备注，注册必须证明持有令牌", async () => {
  const f=fixture();
  const token="existing-token", hash=createHash("sha256").update(token).digest("hex");
  f.data.set("remote_devices",[{id:"dev_existing",name:"备注",token_sha256:hash}]);
  const data={token,token_sha256:hash,device_name:"系统名称"};
  const response=await worker.fetch(request("/api/devices/enroll","POST",data),f.env);
  const result=await response.json();
  assert.equal(result.device_id,"dev_existing"); assert.equal(result.paired,true);
  assert.equal(f.data.get("remote_devices")[0].name,"备注");
  const denied=await worker.fetch(request("/api/devices/enroll","POST",{...data,token:"wrong"}),f.env);
  assert.equal(denied.status,401);
});

test("未配对安装按名称显示，注册重试不重复，配对后自动消失", async () => {
  const f = fixture();
  const cookie = await login(f);
  const body = { token_sha256: "a".repeat(64), device_name: "D22-BB", model_hint: "D22", app_version: "test" };
  const enroll = async () => (await worker.fetch(request("/api/devices/enroll", "POST", body), f.env)).json();
  const first = await enroll(), retry = await enroll();
  assert.equal(first.code, retry.code);
  const list = async () => (await worker.fetch(request("/api/devices", "GET", undefined, cookie), f.env)).json();
  let pending = (await list()).unpaired;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].name, "D22-BB");
  assert.equal(pending[0].code, undefined);
  assert.equal(JSON.stringify(pending).includes(body.token_sha256), false);
  const models = (await (await worker.fetch(request("/api/device-models", "GET", undefined, cookie), f.env)).json()).models;
  const pair = await worker.fetch(request("/api/devices/pair", "POST", { code: first.code, model_id: models[0].id }, cookie), f.env);
  assert.equal(pair.status, 200);
  const paired = (await pair.json()).device;
  assert.equal(paired.name, "D22-BB");
  assert.equal((await list()).unpaired.length, 0);
  await worker.fetch(request("/api/devices/update", "POST", {id:paired.id, name:"管理员备注名"}, cookie), f.env);
  await worker.fetch(request("/api/devices/delete", "POST", {id:paired.id, confirm:true}, cookie), f.env);
  const after = await list();
  assert.equal(after.devices.length, 0);
  assert.equal(after.unpaired.length, 1);
  assert.equal(after.unpaired[0].name, "D22-BB");
  assert.equal(after.unpaired[0].code, undefined);
  const renewed = await enroll();
  assert.notEqual(renewed.code, first.code);
  assert.equal((await list()).unpaired.length, 1);
});

test("过期未配对设备仍显示但不能配对，重新注册替换旧记录", async () => {
  const f = fixture();
  const cookie = await login(f);
  f.data.set("remote_enrolls", { "123456": { token_sha256: "b".repeat(64), device_name: "D22-JJ", paired: false, expires_at: "2020-01-01T00:00:00Z" } });
  const list = await (await worker.fetch(request("/api/devices", "GET", undefined, cookie), f.env)).json();
  assert.equal(list.unpaired[0].pairable, false);
  const denied = await worker.fetch(request("/api/devices/pair", "POST", { code: "123456" }, cookie), f.env);
  assert.equal(denied.status, 400);
  await worker.fetch(request("/api/devices/enroll", "POST", { token_sha256: "b".repeat(64), device_name: "D22-JJ" }), f.env);
  assert.equal(Object.keys(f.data.get("remote_enrolls")).length, 1);
});

test("解除配对提交后才发送通知，旧设备上报明确要求重新配对", async () => {
  const f = fixture();
  const cookie = await login(f);
  f.data.set("remote_devices", [{id:"dev_remove", name:"备注名称", device_name:"Android原名", token_sha256:"c".repeat(64)}]);
  f.env.MQTT_API_URL = "https://broker.test";
  f.env.MQTT_API_TOKEN = "test-token";
  const original = globalThis.fetch;
  let published = false;
  globalThis.fetch = async (url, options) => {
    assert.equal(f.data.get("remote_devices").length, 0);
    const body = JSON.parse(options.body);
    assert.equal(body.notification.type, "status_request");
    published = true;
    return Response.json({ok:true, accepted:true, request_id:body.notification.request_id});
  };
  try {
    const removed = await worker.fetch(request("/api/devices/delete", "POST", {id:"dev_remove",confirm:true}, cookie), f.env);
    assert.equal(removed.status, 200);
    assert.equal(published, true);
    const report = await worker.fetch(request("/api/devices/report", "POST", {device_id:"dev_remove",token:"old"}), f.env);
    assert.equal((await report.json()).pairing_required, true);
  } finally { globalThis.fetch = original; }
});
