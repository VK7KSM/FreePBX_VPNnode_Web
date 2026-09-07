import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import source from "./devices-client-source.js";
import vm from "node:vm";

test("不同缩放下近邻标记保持可点选间距，不改真实位置", () => {
  const context=vm.createContext({adminSession:{check(){}},setTimeout(){},setInterval(){}});
  vm.runInContext(source,context);
  for(const scale of [0.01,1,100]) {
    const points=[{id:"a",x:100,y:100},{id:"b",x:100+scale,y:100+scale},{id:"c",x:100,y:100}];
    const before=JSON.stringify(points);
    const placed=context.markerScreenPositions(points);
    assert.equal(JSON.stringify(points),before);
    for(let i=0;i<placed.length;i++) for(let j=i+1;j<placed.length;j++) {
      assert.ok(Math.abs(placed[i].x-placed[j].x)>=180 || Math.abs(placed[i].y-placed[j].y)>=20);
    }
  }
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
