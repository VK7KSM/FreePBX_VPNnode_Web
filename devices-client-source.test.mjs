import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import source from "./devices-client-source.js";
import vm from "node:vm";

test("同地点按实际距离分组，显示锚点与缩放无关，不改真实坐标", () => {
  const context=vm.createContext({adminSession:{check(){}},setTimeout(){},setInterval(){}});
  vm.runInContext(source,context);
  const devices=[{id:"a",loc:{source:"gps",lat:0,lng:0}},{id:"b",loc:{source:"gps",lat:8,lng:0}},
    {id:"c",loc:{source:"ip",lat:0,lng:0}},{id:"d",loc:{source:"gps",lat:40,lng:0}}];
  const before=JSON.stringify(devices);
  const groups=context.markerLocationGroups(devices,(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]));
  assert.equal(groups.length,3);
  assert.equal(groups[0].devices.map(d=>d.id).join(","),"a,b");
  assert.equal(JSON.stringify(devices),before);
  assert.equal(JSON.stringify(context.markerLocationGroups(devices.slice().reverse(),(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]))),JSON.stringify(groups));
});

test("devices-client-source 必须与 devices-client.js 逐字一致", () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const raw = fs.readFileSync(path.join(root, "devices-client.js"), "utf8");
  assert.equal(source, raw.replace(/\r\n/g, "\n"));
});

test("远程Shell 含快捷任务，顶栏保留更新客户端，没有修机项", () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const raw = fs.readFileSync(path.join(root, "devices-client.js"), "utf8");
  assert.match(raw, /\["adb", "远程Shell"/);
  assert.match(raw, /\["update", "更新客户端"/);
  assert.equal(raw.includes('["repair"'), false);
  assert.equal(raw.includes("类型化修机"), false);
  assert.equal(/function pageRepair\(/.test(raw), false);
  assert.match(raw, /id="adbCmd"/);
  assert.match(raw, /enqueueRepair/);
  assert.match(raw, /pull_logs/);
  assert.match(raw, /heal_network/);
  assert.match(raw, /restart_adbd/);
  assert.equal(raw.includes("enqueueRepairApk"), false);
  assert.match(raw, /assignUpdate/);
  assert.match(raw, /kv\("elfRemote"/);
  assert.equal(raw.includes('kv("制品哈希"'), false);
  assert.equal(raw.includes('kv("类型"'), false);
  assert.match(raw, /id="taskOut"/);
  assert.equal(/if\s*\(\s*r\.text\s*\)/.test(raw), false);
});
