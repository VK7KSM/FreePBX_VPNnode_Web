import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import source from "./devices-client-source.js";
import vm from "node:vm";

test('丢失模式使用真实回执并将失主文字转义为文本',()=>{
  const context=vm.createContext({adminSession:{check(){}},setTimeout(){},setInterval(){},document:{getElementById:()=>({value:'测试'})}});
  vm.runInContext(source,context);
  context.DEV=[{id:'a',managed_lost_tasks:true,lost_mode:{state:'pending',enabled:true,message:'<x>"'}}];context.selDev='a';
  const html=context.pageLost('');assert.match(html,/等待恢复设置/);assert.doesNotMatch(html,/<x>/);
  let sent;context.enqueueRepair=(type,params)=>{sent={type,params};};context.setLostMode(false);
  assert.equal(sent.type,'set_lost_mode');assert.equal(sent.params.enabled,false);assert.equal(sent.params.message,'');
});

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

test("未接通能力不制造成功记录", () => {
  const alerts=[];
  const context=vm.createContext({alert:value=>alerts.push(value),adminSession:{check(){}},setTimeout(){},setInterval(){}});
  vm.runInContext(source,context);
  const d={id:'a',name:'D22-XX',model_id:'d22',online:true,paired:false};
  context.DEV=[d];context.selDev='a';
  const before=JSON.stringify(context.uiOf());
  for(const name of ['lostRec','lostPhoto','lostVideo','lostTalk','lostLock','lostUnlock']) context[name]();
  assert.equal(JSON.stringify(context.uiOf()),before);
  assert.equal(alerts.length,6);
});

test('警报页面只显示设备实报状态并下发真实任务',()=>{
  const context=vm.createContext({adminSession:{check(){}},setTimeout(){},setInterval(){}});
  vm.runInContext(source,context);
  context.DEV=[{id:'a',alarm:{state:'interrupted',started_at_ms:1000,duration_ms:10000}}];context.selDev='a';
  const html=context.pageAlarm('');
  assert.match(html,/播放中断/);assert.match(html,/停止警报/);
  let type='';context.enqueueRepair=value=>{type=value;};context.alarmPlay();assert.equal(type,'play_alarm');
  assert.equal(context.DEV[0].alarm.state,'interrupted');
  context.locNow();assert.equal(type,'locate_now');
});

test('通信录显示真实号码，操作传递稳定编号且不提前伪造修改',()=>{
  const fields={cName:{value:'测试'},cPhone:{value:'000'},wifiSsid:{value:'fixture'},wifiPw:{value:'fixture-pass'}};
  const context=vm.createContext({document:{getElementById:id=>fields[id]},prompt:(_,v)=>v,adminSession:{check(){}},setTimeout(){},setInterval(){}});
  vm.runInContext(source,context);
  context.DEV=[{id:'a',contacts:{sampled_at_ms:1000,items:[{id:42,name:'<x>',phone:'000'}]}}];context.selDev='a';
  assert.doesNotMatch(context.pageContacts(''),/<x>/);
  const sent=[];context.enqueueRepair=(type,params)=>sent.push({type,params});
  context.contactRefresh();context.contactAdd();context.contactEdit(0);context.contactDel(0);context.wifiConnect();
  assert.equal(sent[0].type,'contacts_read');assert.equal(sent[2].params.id,42);assert.equal(sent[3].params.id,42);
  assert.equal(sent[4].params.password,'fixture-pass');assert.equal(context.DEV[0].contacts.items.length,1);
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
  const errors=[];
  const context=vm.createContext({alert:v=>errors.push(v),fetch:async()=>{throw new Error('offline');},adminSession:{check(){}},setTimeout(){},setInterval(){}});
  vm.runInContext(source,context);
  context.DEV=[{id:"a"}];context.selDev="a";context.renderOps=()=>{};
  await context.locNow();
  assert.equal(context.historyState().rows.length,0);
  assert.match(errors[0],/下发失败/);
  assert.match(context.dailyTrafficHtml(null),/无数据/);
  assert.doesNotMatch(context.dailyTrafficHtml(null),/0\.0 KiB/);
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

test("远程ADB 含快捷任务，顶栏保留更新客户端，没有修机项", () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const raw = fs.readFileSync(path.join(root, "devices-client.js"), "utf8");
  assert.match(raw, /\["adb", "远程终端"/);
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
  assert.match(raw, /kv\("客户端版本"/);
  assert.equal(raw.includes('kv("制品哈希"'), false);
  assert.equal(raw.includes('kv("类型"'), false);
  assert.match(raw, /id="taskOut"/);
  assert.equal(/if\s*\(\s*r\.text\s*\)/.test(raw), false);
});

test('今日流量使用KB，无数据不冒充零；系统配置保留原Wi-Fi入口',()=>{
 const context=vm.createContext({adminSession:{check(){}},setTimeout(){},setInterval(){}});
 vm.runInContext(source,context);context.DEV=[{id:'a'}];context.selDev='a';
 assert.equal(context.trafficBytes(1234),'1.2 KB');
 assert.equal(context.dailyTrafficHtml(null),'无数据');
 assert.doesNotMatch(context.dailyTrafficHtml({available:true,rx_bytes:1000,tx_bytes:2000,estimated:true}),/估算|KiB/);
 assert.match(context.pageSystem(''),/wifiScan/);
 context.SYSTEM_TAB='语言与时间';assert.match(context.pageSystem(''),/自动时间/);
 assert.doesNotMatch(context.pageSystem(''),/type="checkbox"/);
});
test('流量历史过期请求不覆盖新的范围，柱子选择显示收发明细',async()=>{
 const nodes={trafficFrom:{value:'2026-09-01'},trafficTo:{value:'2026-09-08'},trafficChart:{innerHTML:''},trafficY:{innerHTML:''},trafficDetail:{textContent:''}};
 const pending=[];
 const context=vm.createContext({URLSearchParams,adminSession:{check(){}},setTimeout(){},setInterval(){},document:{getElementById:id=>nodes[id],querySelectorAll:()=>[]},fetch:()=>new Promise(resolve=>pending.push(resolve))});
 vm.runInContext(source,context);
 context.TRAFFIC_HISTORY={id:'a',seq:0,days:[]};
 const first=context.loadTrafficHistory();nodes.trafficFrom.value='2026-09-08';const second=context.loadTrafficHistory();
 const row={date:'2026-09-08',available:true,rx_bytes:1000,tx_bytes:2000};
 pending[1]({ok:true,json:async()=>({ok:true,days:[row]})});await second;
 pending[0]({ok:true,json:async()=>({ok:true,days:[]})});await first;
 assert.equal(context.TRAFFIC_HISTORY.days.length,1);
 assert.match(nodes.trafficDetail.innerHTML,/2026-09-08.*traffic-rx-text.*接收 1.0 KB.*traffic-tx-text.*发送 2.0 KB.*总计 3.0 KB/);
});

test('所有功能页均可渲染，型号名称转义且操作使用当前条目',()=>{
 const context=vm.createContext({adminSession:{check(){}},setTimeout(){},setInterval(){}});
 vm.runInContext(source,context);
 context.DEV=[{id:'fixture',enabled:true,managed_lost_tasks:true}];context.selDev='fixture';
 context.MODELS=[{id:'m',name:'<script>测试</script>',note:'<img>'}];
 for(const item of context.FN_ITEMS){context.selFn=item[0];assert.doesNotThrow(()=>context.fnPageHtml(),item[1]);}
 const html=context.pageModel();assert.doesNotMatch(html,/<script>|<img>/);assert.match(html,/editModel\(MODELS\[0\]\.id\)/);
 const shell=context.pageAdb('');assert.match(shell,/monitor-grid/);assert.match(shell,/id="taskOut"/);assert.match(shell,/id="adbTerm"/);
});

test('ADB通道未实现时不伪造连接成功，按钮在终端标题内且维护操作在输出之后',()=>{
 const context=vm.createContext({adminSession:{check(){}},setTimeout(){},setInterval(){}});
 vm.runInContext(source,context);context.DEV=[{id:'fixture'}];context.selDev='fixture';context.renderOps=()=>{};
 context.adbConnect();assert.equal(context.uiOf().adb.connected,false);
 const html=context.pageAdb('');assert.match(html,/连接未建立/);assert.match(html,/monitor-heading.*连接ADB/);
 assert.doesNotMatch(html,/断开ADB/);assert.ok(html.indexOf('id="taskOut"')<html.indexOf("enqueueRepair"));
 context.uiOf().adb.connected=true;assert.match(context.pageAdb(''),/断开ADB/);
 context.adbDisconnect();assert.equal(context.uiOf().adb.connected,false);
});

test('维护按钮遵循能力和任务占用，历史成功不冒充本次结果',()=>{
 const context=vm.createContext({adminSession:{check(){}},setTimeout(){},setInterval(){}});
 vm.runInContext(source,context);
 const d={id:'fixture',enabled:true,status_only:true,managed_log_tasks:true,task:{id:'old',state:'success',label:'成功'}};
 context.DEV=[d];context.selDev=d.id;
 assert.equal(context.maintenanceAvailable(d,'pull_logs'),true);
 assert.equal(context.maintenanceAvailable(d,'reboot'),false);
 assert.doesNotMatch(context.pageAdb(''),/class="maintenance-status/);
 d.task={id:'new',state:'running',expires_at:Date.now()+60000};assert.equal(context.maintenanceAvailable(d,'pull_logs'),false);
 d.task.expires_at=Date.now()-1000;assert.equal(context.maintenanceAvailable(d,'pull_logs'),true);
 context.MAINTENANCE_RUN.fixture={id:'new'};d.task.state='success';d.task.label='成功';
 assert.match(context.pageAdb(''),/maintenance-status maintenance-success/);
 d.enabled=false;assert.equal(context.maintenanceAvailable(d,'pull_logs'),false);
 context.MAINTENANCE_RUN.fixture={pending:true};d.enabled=true;assert.equal(context.maintenanceAvailable(d,'pull_logs'),false);
});

test('已发布版本按编号降序，默认最新，手动选择不被重绘覆盖',async()=>{
 const context=vm.createContext({adminSession:{check(){}},setTimeout(){},setInterval(){},fetch:async()=>({ok:true,json:async()=>({ok:true,releases:[{versionCode:9,versionName:'旧版'},{versionCode:95,versionName:'新版'}]})})});
 vm.runInContext(source,context);context.DEV=[{id:'fixture'}];context.selDev='fixture';context.renderOps=()=>{};
 await context.loadReleases();assert.equal(context.RELEASES[0].versionCode,95);assert.equal(context.selectedRelease().versionCode,95);
 assert.match(context.pageUpdate(''),/<option value="95" selected>/);
 context.uiOf().releaseVersion='9';assert.equal(context.selectedRelease().versionCode,9);
 assert.match(context.pageUpdate(''),/<option value="9" selected>/);
 context.fetch=async()=>({ok:false});await context.loadReleases();
 assert.match(context.pageUpdate(''),/版本读取失败/);assert.match(context.pageUpdate(''),/assignUpdate\(\)" disabled/);
});
