import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";
import { fixture, request, login } from "./test-support.mjs";

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
