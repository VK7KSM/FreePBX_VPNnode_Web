import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

const base = new URL(process.env.ELFREMOTE_TEST_URL || "http://127.0.0.1:8791");
if (!["127.0.0.1", "localhost"].includes(base.hostname)) throw new Error("集成写测试仅允许本机隔离 Worker");
let cookie = "";
async function call(path, method = "GET", body, authenticated = true) {
  return fetch(new URL(path, base), { method, headers: { "Content-Type": "application/json", ...(authenticated && cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const auth = await call("/api/login", "POST", { username: "local-test", password: "local-only-test-password" });
assert.equal(auth.status, 200);
cookie = auth.headers.get("set-cookie").split(";")[0];
const token = randomUUID();
const enrolled = await call("/api/devices/enroll", "POST", { token_sha256: createHash("sha256").update(token).digest("hex") }, false);
assert.equal(enrolled.status,200);
const pair = await call("/api/devices/pair", "POST", { code: (await enrolled.json()).code, name: "本地模拟测试机", model_id: "mdl_d22" });
assert.equal(pair.status,200);
const id = (await pair.json()).device.id;
const report = { device_id: id, token, report_id: randomUUID(), reported_at: new Date().toISOString(),
  gps: { lat: 1, lng: 2, at: new Date().toISOString(), acc_m: 10 }, battery: 50, status_only: true };
const [received, renamed] = await Promise.all([
  call("/api/devices/report", "POST", report, false),
  call("/api/devices/update", "POST", { id, name: "并发改名完成" })
]);
assert.equal(received.status,200);
assert.equal(renamed.status,200);
const duplicate = await call("/api/devices/report", "POST", report, false);
assert.equal((await duplicate.json()).duplicate,true);
const listing = await (await call("/api/devices")).json();
const device = listing.devices.find(d => d.id === id);
assert.equal(device.name,"并发改名完成"); assert.equal(device.battery,50);
let records = await (await call("/api/devices/history?device_id="+id)).json();
assert.equal(records.records.length,1);
assert.equal(records.records[0].location.source,"gps");
assert.equal((await call("/api/devices/delete", "POST", { id, confirm: true })).status,200);
records = await (await call("/api/devices/history?device_id="+id)).json();
assert.equal(records.records.length,1);
assert.equal((await call("/api/devices/report", "POST", report, false)).status,404);
assert.equal((await call("/api/logout","POST")).status,200);
assert.equal((await call("/api/devices")).status,401);
console.log("本地 Worker：配对、并发改名与上报、历史去重、解除配对保留历史及退出检查全部通过");
