import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import worker from "./worker.js";
import { fixture, request, login } from "./test-support.mjs";
import { pickLocation } from "./remote-location.js";

const token = "test-device-token";
const hash = createHash("sha256").update(token).digest("hex");

test('未来设备时间保留原件但不冻结最新报告，已有未来状态自动恢复',async()=>{
  const f=setup(),c=await login(f);
  const future='2098-01-01T00:00:00Z';
  await report(f,'future',future,null,{battery:10});
  const saved=f.data.get('remote_devices')[0];
  assert.ok(Date.parse(saved.last_reported_at)<=Date.now());
  await report(f,'corrected',new Date().toISOString(),null,{battery:90});
  assert.equal(f.data.get('remote_devices')[0].battery,90);
  const rows=(await history(f,c)).records;
  const record=rows.find(r=>r.report_id==='future');
  assert.equal(record.reported_at,'2098-01-01T00:00:00.000Z');
  assert.equal(record.timeline_at,record.received_at);
  const legacy=f.data.get('remote_devices');legacy[0].last_reported_at=future;f.data.set('remote_devices',legacy);
  await report(f,'legacy-recovery',new Date().toISOString(),null,{battery:80});
  assert.equal(f.data.get('remote_devices')[0].battery,80);
});
const traffic = { available: true, scope: "application_uid", source: "qtaguid_uid",
  started_at_ms: 1000, sampled_at_ms: 2000, covered_ms: 1000, gaps: 0,
  rx_bytes: 123, tx_bytes: 456, interfaces: { wlan0: { rx_bytes: 123, tx_bytes: 456 } } };

test("流量进入现有设备与历史查询，重试去重，补报不覆盖新计量", async () => {
  const f=setup(),c=await login(f);
  assert.equal((await report(f,"traffic-new","2026-09-07T02:00:00Z",null,{traffic})).status,200);
  assert.equal((await report(f,"traffic-new","2026-09-07T02:00:00Z",null,{traffic})).status,200);
  await report(f,"traffic-old","2026-09-07T01:00:00Z",null,{traffic:{available:false,reason:"uid_counter_unsupported"}});
  const devices=await (await worker.fetch(request("/api/devices","GET",undefined,c),f.env)).json();
  assert.deepEqual(devices.devices[0].traffic,traffic);
  const rows=(await history(f,c)).records;
  assert.equal(rows.length,2); assert.deepEqual(rows[1].traffic,traffic);
  assert.equal((await report(f,"traffic-new","2026-09-07T02:00:00Z",null,{traffic:{...traffic,gaps:1}})).status,400);
});

test("流量拒绝负数、非整数、超界及不一致总量，失败不留下历史", async () => {
  const f=setup(),c=await login(f);
  for (const value of [false, {}, {...traffic,rx_bytes:-1}, {...traffic,covered_ms:0.5},
    {...traffic,tx_bytes:Number.MAX_SAFE_INTEGER+1}, {...traffic,rx_bytes:124},
    {...traffic,interfaces:{bad:{rx_bytes:0,tx_bytes:0}}}, {available:false,reason:"arbitrary"}]) {
    assert.equal((await report(f,"invalid","2026-09-07T02:00:00Z",null,{traffic:value})).status,400);
  }
  assert.equal((await history(f,c)).records.length,0);
});
function setup() {
  return fixture({ admin_pass: "fixture-password", remote_devices: [{ id: "dev_test", name: "测试机", enabled: true, token_sha256: hash }],
    remote_device_models: [{ id: "mdl_d22", name: "D22" }] });
}
function report(f, id, at, gps = null, extra = {}) {
  return worker.fetch(request("/api/devices/report", "POST", { device_id: "dev_test", token, report_id: id, reported_at: at,
    gps, status_only: true, network: "wifi", ...extra }, undefined, { "CF-Connecting-IP": "192.0.2.1" }), f.env);
}
async function history(f,c,query="") {
  const r = await worker.fetch(request("/api/devices/history?device_id=dev_test&to=2099-01-01T00:00:00Z" + query,"GET",undefined,c),f.env);
  assert.equal(r.status,200); return r.json();
}

test("同地点不同次上报均保存，重试去重，来源时间/IP 保留", async () => {
  const f=setup(), c=await login(f);
  const gps={lat:1,lng:2,acc_m:8000,at:"2026-09-07T01:00:00Z"};
  for(const id of ["a","b","a"]) assert.equal((await report(f,id,"2026-09-07T01:01:00Z",gps)).status,200);
  const rows=(await history(f,c)).records;
  assert.equal(rows.length,2);
  assert.equal(rows[0].sample_at,"2026-09-07T01:00:00.000Z");
  assert.equal(rows[0].location.acc_m,8000);
  assert.equal(rows[0].ip,"192.0.2.1");
  assert.notEqual(rows[0].received_at,rows[0].reported_at);
  assert.equal(JSON.stringify(rows).includes(token),false);
});

test("无 GPS 仍有记录；补报不覆盖较新状态；分页无遗漏", async () => {
  const f=setup(),c=await login(f);
  await report(f,"new","2026-09-07T02:00:00Z",null,{battery:60});
  await report(f,"old","2026-09-07T01:00:00Z",null,{battery:80});
  assert.equal(f.data.get("remote_devices")[0].battery,60);
  const first=await history(f,c,"&limit=1");
  assert.equal(first.records[0].report_id,"old");
  assert.equal(first.records[0].location,null);
  const second=await history(f,c,"&limit=1&cursor="+encodeURIComponent(first.next_cursor));
  assert.equal(second.records[0].report_id,"new");
  assert.equal(second.next_cursor,null);
});

test("低频状态模式随新报告保存，旧补报不回退模式，管理员可查联系状态", async () => {
  const f=setup(),c=await login(f);
  await report(f,"mode-new","2026-09-07T02:00:00Z");
  await report(f,"mode-old","2026-09-07T01:00:00Z",null,{status_only:false});
  assert.equal(f.data.get("remote_devices")[0].status_only,true);
  const response=await (await worker.fetch(request("/api/devices","GET",undefined,c),f.env)).json();
  assert.equal(response.devices[0].contact_state,"recent_contact");
  assert.ok(response.devices[0].report_due_at);
});

test("并发上报与改名不丢字段，状态模式不领取或更改旧维护任务", async () => {
  const f=setup(),c=await login(f);
  const d=f.data.get("remote_devices")[0];
  d.task={id:"old-task",state:"pending",type:"reboot",expires_at:"2000-01-01T00:00:00Z"};
  const task=structuredClone(d.task);
  const results=await Promise.all([
    report(f,"parallel","2026-09-07T03:00:00Z",null,{battery:44}),
    worker.fetch(request("/api/devices/update","POST",{id:"dev_test",name:"新名称"},c),f.env)
  ]);
  for(const r of results) assert.equal(r.status,200);
  const response=await results[0].json();
  assert.equal(response.task,undefined); assert.equal(response.update,undefined);
  const saved=f.data.get("remote_devices")[0];
  assert.equal(saved.battery,44); assert.equal(saved.name,"新名称"); assert.deepEqual(saved.task,task);
});

test("上报保存中途失败会整体回滚，不能返回成功或留下半条历史", async () => {
  const f=setup();
  const originalPut=f.storage.put;
  f.storage.put=async(k,v)=>{ if(k==="remote_devices")throw new Error("模拟写入失败"); return originalPut(k,v); };
  assert.notEqual((await report(f,"broken","2026-09-07T01:00:00Z")).status,200);
  assert.equal([...f.data.keys()].some(k=>k.startsWith("history/")),false);
  assert.equal([...f.data.keys()].some(k=>k.startsWith("history-id/")),false);
  assert.equal(f.data.get("remote_devices")[0].last_seen,undefined);
});

test("解除配对保留历史，旧令牌及旧配对码不能恢复设备", async () => {
  const f=setup(),c=await login(f);
  f.data.set("remote_enrolls",{"123456":{paired:true,device_id:"dev_test",expires_at:"2099-01-01T00:00:00Z",token_sha256:hash}});
  await report(f,"before-delete","2026-09-07T01:00:00Z");
  assert.equal((await worker.fetch(request("/api/devices/delete","POST",{id:"dev_test",confirm:true},c),f.env)).status,200);
  assert.equal((await history(f,c)).records.length,1);
  assert.equal((await report(f,"after-delete","2026-09-07T02:00:00Z")).status,404);
  assert.equal((await worker.fetch(request("/api/devices/pair","POST",{code:"123456",model_id:"mdl_d22"},c),f.env)).status,409);
  assert.deepEqual(f.data.get("remote_devices"),[]);
});

test("历史受登录保护，坏凭据与错误查询不写入记录", async () => {
  const f=setup(),c=await login(f);
  assert.equal((await worker.fetch(request("/api/devices/history?device_id=dev_test"),f.env)).status,401);
  assert.equal((await report(f,"bad","2026-09-07T01:00:00Z",null,{token:"bad"})).status,401);
  assert.equal((await history(f,c)).records.length,0);
  assert.equal((await worker.fetch(request("/api/devices/history?device_id=dev_test&from=bad","GET",undefined,c),f.env)).status,400);
  await report(f,"same-id","2026-09-07T01:00:00Z");
  assert.equal((await report(f,"same-id","2026-09-07T02:00:00Z")).status,400);
  assert.equal((await history(f,c)).records.length,1);
});

test("无编号旧客户端仍可上报，空坐标和越界点不落到地图原点", async () => {
  const f=setup();
  const r=await worker.fetch(request("/api/devices/report","POST",{device_id:"dev_test",token}),f.env);
  assert.equal(r.status,200);
  assert.equal([...f.data.values()].filter(v=>v?.legacy_report===true).length,1);
  assert.equal(pickLocation({gps:{lat:null,lng:null}},null),null);
  assert.equal(pickLocation({gps:{lat:91,lng:20}},null),null);
});
