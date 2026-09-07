import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import source from "./devices-client-source.js";
import vm from "node:vm";

test("Wi-Fi 扫描使用真实任务，名称只作为文本且选择保持原文",()=>{
  const context=vm.createContext({adminSession:{check(){}},setTimeout(){},setInterval(){}});
  vm.runInContext(source,context);
  const ssid="fixture');alert(1);//<x>";
  context.DEV=[{id:'a',wifi_scan:{sampled_at_ms:1000,networks:[{ssid,rssi:-40,sec:'WPA3'}]}}];
  context.selDev='a';context.renderOps=()=>{};
  const html=context.pageWifi('');
  assert.match(html,/onclick="wifiPickIndex\(0\)"/);
  assert.doesNotMatch(html,/<x>/);
  assert.doesNotMatch(html,/onclick="wifiPick\(/);
  context.wifiPickIndex(0);assert.equal(context.uiOf().wifiSel,ssid);
  let requested='';context.enqueueRepair=type=>{requested=type;};
  context.wifiScan();assert.equal(requested,'scan_wifi');
  context.DEV[0].wifi_scan.networks=[];
  assert.match(context.pageWifi(''),/本次扫描未发现可显示的网络/);
  assert.doesNotMatch(context.pageWifi(''),/等待设备上报周围 Wi-Fi/);
});

test("列表状态只显示一处，只有等待上报可触发拉取，自动报告清除旧错误",async()=>{
  const box={innerHTML:''};
  const context=vm.createContext({document:{getElementById:()=>box},adminSession:{check(){}},setTimeout(){},setInterval(){}});
  vm.runInContext(source,context);
  const d={id:'a',name:'测试机',last_seen:'one',update:{state:'wait_health',label:'等待健康确认'}};
  context.DEV=[d];let calls=0;context.requestDeviceStatus=()=>{calls++;return true;};
  context.renderList();
  assert.equal((box.innerHTML.match(/等待健康确认<\/span>/g)||[]).length,1);
  assert.doesNotMatch(box.innerHTML,/等待上报信息/);
  assert.match(box.innerHTML,/role="status" tabindex="-1"/);
  assert.equal(context.requestListedDeviceStatus('a'),false);
  d.update.state='success';
  assert.equal(context.deviceListStatus(d),'等待上报信息');
  await context.requestListedDeviceStatus('a');assert.equal(calls,1);
  for(const state of ['等待设备领取','等待完整上报','拉取超时','拉取失败']){
    context.STATUS.a=state;assert.equal(context.requestListedDeviceStatus('a'),false);
  }
  context.STATUS_SEEN.a='one';context.reconcileReportStatus(d);assert.equal(context.STATUS.a,'拉取失败');
  d.last_seen='two';context.reconcileReportStatus(d);assert.equal(context.deviceListStatus(d),'等待上报信息');
  d.task={state:'running',type_label:'拉取日志',label:'执行中'};
  assert.equal(context.requestListedDeviceStatus('a'),false);
  d.task=null;d.contact_state='report_overdue';assert.equal(context.requestListedDeviceStatus('a'),false);
  d.contact_state='recent_contact';d.enabled=false;assert.equal(context.requestListedDeviceStatus('a'),false);
  assert.equal(calls,1);
});

test("设备组合筛选不改变原列表，未接通能力不制造成功记录", () => {
  const alerts=[];
  const context=vm.createContext({alert:value=>alerts.push(value),adminSession:{check(){}},setTimeout(){},setInterval(){}});
  vm.runInContext(source,context);
  const d={id:'a',name:'D22-XX',model_id:'d22',online:true,paired:false};
  context.DEV=[d];context.selDev='a';
  context.LIST_FILTER={text:'xx',model:'d22',state:'unpaired'};
  assert.equal(context.matchesDevice(d),true);
  context.LIST_FILTER.state='offline';assert.equal(context.matchesDevice(d),false);
  const before=JSON.stringify(context.uiOf());
  for(const name of ['wifiConnect','contactAdd','contactDel','alarmPlay','lostRec','lostPhoto','lostVideo','lostTalk','lostLock','lostUnlock']) context[name]();
  assert.equal(JSON.stringify(context.uiOf()),before);
  assert.equal(alerts.length,10);
});

test("历史查询切设备不串台，翻页保持范围，修改范围重新查询", async () => {
  let resolveResponse, requested;
  const context=vm.createContext({URLSearchParams,adminSession:{check(){}},setTimeout(){},setInterval(){},
    fetch(url){requested=url;return new Promise(resolve=>{resolveResponse=resolve;});}});
  vm.runInContext(source,context);
  context.renderOps=()=>{};
  context.DEV=[{id:"a"},{id:"b"}];context.selDev="a";
  const state=context.historyState();
  state.from="2026-09-01T00:00";state.to="2026-09-02T00:00";
  const first=context.queryHistory(false);
  context.selDev="b";
  resolveResponse({ok:true,json:async()=>({ok:true,records:[{report_id:"one"}],next_cursor:"next"})});
  await first;
  assert.equal(context.historyState().rows.length,0);
  assert.equal(state.rows[0].report_id,"one");
  context.selDev="a";
  const second=context.queryHistory(true);
  assert.equal(new URL(requested,"https://example.test").searchParams.get("cursor"),"next");
  resolveResponse({ok:true,json:async()=>({ok:true,records:[{report_id:"two"}],next_cursor:null})});
  await second;
  assert.equal(state.rows.length,2);
  state.to="2026-09-03T00:00";
  const third=context.queryHistory(true);
  assert.equal(new URL(requested,"https://example.test").searchParams.has("cursor"),false);
  resolveResponse({ok:false,json:async()=>({ok:false,msg:"测试错误"})});
  await third;
  assert.equal(state.error,"测试错误");assert.equal(state.loading,false);
});

test("远程定位失败不制造历史，流量缺失不伪装为零", async () => {
  const context=vm.createContext({adminSession:{check(){}},setTimeout(){},setInterval(){}});
  vm.runInContext(source,context);
  context.DEV=[{id:"a"}];context.selDev="a";context.renderOps=()=>{};
  context.requestDeviceStatus=async()=>false;
  await context.locNow();
  assert.equal(context.historyState().rows.length,0);
  assert.ok(context.historyState().error);
  assert.match(context.trafficHtml(null),/暂无有效计量/);
  assert.doesNotMatch(context.trafficHtml(null),/0\.0 KiB/);
});

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
