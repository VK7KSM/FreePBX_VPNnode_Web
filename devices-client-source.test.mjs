import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import source from "./devices-client-source.js";
import vm from "node:vm";
import crypto from "node:crypto";

test('文件列表名称只作为文字，点击用索引，切设备后不覆盖当前文件页',()=>{
  const context=vm.createContext({adminSession:{check(){}},setTimeout(){},setInterval(){},document:{getElementById:()=>({})}});
  vm.runInContext(source,context);
  const state={device_id:'first',path:'/sdcard',selected:0,entries:[{name:"file');alert(1);//<x>",directory:false,bytes:0}]};
  const html=context.fileManagerRows(state);
  assert.match(html,/fileManagerPick\(0\)/);assert.doesNotMatch(html,/<x>/);assert.doesNotMatch(html,/onclick="[^\"]*alert/);
  context.selFn='files';context.selDev='second';assert.equal(context.fileManagerVisible(state),false);
  context.selDev='first';assert.ok(context.fileManagerVisible(state));
  context.selFn='adb';assert.equal(context.fileManagerVisible(state),false);
  assert.equal(context.fileManagerChild({path:'/'},'test'),'/test');
});

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
 context.SYSTEM_TAB='语言与时间';assert.match(context.pageSystem(''),/请更新客户端后使用/);
 context.DEV[0].managed_system_settings=true;
 context.DEV[0].system_settings={time:{sampled_at:1,locale:'zh-CN',locales:['zh-CN','en-AU'],timezone:'Australia/Sydney',auto_time:true,auto_time_zone:true}};
 assert.match(context.pageSystem(''),/自动时间/);
 assert.match(context.pageSystem(''),/id="setting-timezone" disabled/);
 assert.doesNotMatch(context.pageSystem(''),/type="checkbox"/);
 context.DEV[0].system_settings.time.timezones=['Australia/Sydney','UTC'];
 const compatible=context.pageSystem('');assert.match(compatible,/value="UTC"/);assert.match(compatible,/value="Australia\/Sydney"/);assert.doesNotMatch(compatible,/value="America\/New_York"/);
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
 assert.equal(context.FN_ITEMS[5][0],'files');assert.equal(context.FN_ITEMS[5][1],'文件管理');
 const shell=context.pageAdb('');assert.doesNotMatch(shell,/onclick="openSendFile/);assert.match(shell,/monitor-grid/);assert.match(shell,/id="taskOut"/);assert.match(shell,/id="adbTerm"/);
});

test('左侧通用终端与右侧ADB保持独立，root能力不冒充ADB连接',()=>{
 const context=vm.createContext({adminSession:{check(){}},setTimeout(){},setInterval(){}});
 vm.runInContext(source,context);context.DEV=[{id:'fixture'}];context.selDev='fixture';context.renderOps=()=>{};
 context.adbConnect();assert.equal(context.uiOf().adb.connected,false);
 const html=context.pageAdb(''),panels=html.split('</section>');
 assert.match(panels[0],/通用终端/);assert.match(panels[0],/id="shellCmd"/);assert.match(panels[0],/enqueueRepair/);
 assert.match(panels[1],/ADB终端/);assert.match(panels[1],/连接ADB/);assert.doesNotMatch(panels[1],/shellSend/);
 context.DEV[0].managed_exec_tasks=true;
 const ready=context.pageAdb('');assert.match(ready,/onclick="shellSend\(\)"[^>]*>发送/);
 assert.match(ready,/ADB 未连接/);assert.equal(context.uiOf().adb.connected,false);
 context.commandResult(context.uiOf(),{id:'test',state:'success',detail:'成功',result:{text:'GENERAL_ONLY',exit_code:0}});
 const result=context.pageAdb('').split('</section>');assert.match(result[0],/GENERAL_ONLY/);assert.doesNotMatch(result[1],/GENERAL_ONLY/);
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
 const context=vm.createContext({URLSearchParams,adminSession:{check(){}},setTimeout(){},setInterval(){},fetch:async()=>({ok:true,json:async()=>({ok:true,releases:[{versionCode:9,versionName:'旧版'},{versionCode:95,versionName:'新版'}]})})});
 vm.runInContext(source,context);context.DEV=[{id:'fixture',can_update:true}];context.selDev='fixture';context.renderOps=()=>{};
 await context.loadReleases();assert.equal(context.RELEASES[0].versionCode,95);assert.equal(context.selectedRelease().versionCode,95);
 assert.match(context.pageUpdate(''),/<option value="95" selected>/);
 context.uiOf().releaseVersion='9';assert.equal(context.selectedRelease().versionCode,9);
 assert.match(context.pageUpdate(''),/<option value="9" selected>/);
 context.fetch=async()=>({ok:false});await context.loadReleases();
 assert.match(context.pageUpdate(''),/版本读取失败/);assert.match(context.pageUpdate(''),/assignUpdate\(\)" disabled/);
});

test('更新检查区分新旧和未知版本，快捷更新总是指定最新版',()=>{
 const requests=[];
 const context=vm.createContext({crypto,adminSession:{check(){}},setTimeout(){},setInterval(){},fetch:(url,options)=>{requests.push(JSON.parse(options.body));return new Promise(()=>{});}});
 vm.runInContext(source,context);context.DEV=[{id:'fixture',can_update:true,update_channel:'d22',app_version:'0.1.9'}];context.selDev='fixture';context.RELEASE_DEVICE='fixture';context.RELEASE_STATE='ready';
 context.RELEASES=[{versionCode:95,versionName:'0.1.94-production-lost-mode'},{versionCode:10,versionName:'0.1.9'}];context.uiOf().releaseVersion=10;
 assert.match(context.pageUpdate(''),/新的软件版本.*assignUpdate\(95\)/);
 context.assignUpdate(95);assert.equal(requests[0].versionCode,95);
 for(const version of ['0.1.94-production-lost-mode','0.1.94','0.1.100']){context.DEV[0].app_version=version;assert.match(context.pageUpdate(''),/当前版本即最新版本/);}
 context.DEV[0].app_version='未知';assert.match(context.pageUpdate(''),/无法识别/);assert.doesNotMatch(context.pageUpdate(''),/当前版本即最新版本/);
 context.DEV[0].app_version='0.1.9';context.DEV[0].update={state:'downloading'};
 assert.match(context.pageUpdate(''),/assignUpdate\(95\)" disabled/);context.assignUpdate(95);assert.equal(requests.length,1);
 assert.match(context.updateProgress({state:'success',target:'0.1.80',detail:'health-ok'}),/最近一次更新.*0.1.80.*运行正常/);
 assert.doesNotMatch(context.updateProgress({state:'success',detail:'health-ok'}),/health-ok/);
 assert.match(context.updateProgress({state:'rejected',detail:'hash-mismatch'}),/安装包校验不通过/);
});

test('安装进展与结果分列，过期进展不猜测下载中断，结果包含悉尼时间',()=>{
 const context=vm.createContext({adminSession:{check(){}},setTimeout(){},setInterval(){}});
 vm.runInContext(source,context);context.DEV=[{id:'fixture',update:{state:'success',completed_at:'2026-09-08T00:00:00Z'}}];context.selDev='fixture';
 const html=context.pageUpdate('');assert.match(html,/安装进展<\/div>.*安装结果<\/div>/);assert.doesNotMatch(html,/安装进展与结果/);
 assert.match(context.installationProgress({state:'downloading',updated_at:new Date(1000).toISOString()},1001),/^下载中$/);
 const stale=context.installationProgress({state:'downloading',updated_at:new Date(1000).toISOString()},62000);
 assert.match(stale,/尚未收到后续进展/);assert.doesNotMatch(stale,/中断|失败/);
 assert.match(context.installationResult(context.DEV[0].update),/成功.*2026\/9\/8 10:00:00/);
 assert.match(context.installationResult({state:'success'}),/时间未记录/);
 assert.match(context.installationResult({state:'rejected',detail:'hash-mismatch'}),/失败.*安装包校验不通过/);
 assert.match(context.installationResult({state:'installing',detail:'install-fail'}),/失败/);
 assert.match(context.installationResult({state:'downloading'}),/等待安装结果/);
});

test('充电时电池显示闪电和充电中文字，未充电与旧报告不误显示',()=>{
  const context=vm.createContext({adminSession:{check(){}},setTimeout(){},setInterval(){}});
  vm.runInContext(source,context);
  assert.equal(context.batteryText({battery:100,charging:true}),'100% · 充电中');
  assert.match(context.battHtml(100,true),/mbatt-bolt/);
  for(const charging of [false,null,undefined]) {
    assert.equal(context.batteryText({battery:100,charging}),'100%');
    assert.doesNotMatch(context.battHtml(100,charging),/mbatt-bolt|充电中/);
  }
});


test('系统分类快速切换只补读最后选择，停用设备不能下发设置',async()=>{
 const context=vm.createContext({crypto,URLSearchParams,adminSession:{check(){}},setTimeout(){},setInterval(){}});vm.runInContext(source,context);
 context.DEV=[{id:'fixture',managed_system_settings:true,enabled:true}];context.selDev='fixture';context.selFn='wifi';context.SYSTEM_TAB='声音与显示';context.renderOps=()=>{};
 const requests=[];let release;context.fileApi=async(url,body)=>{
  if(body){requests.push(body.params.group);return {task:{id:String(requests.length)}};}
  if(requests.length===1)await new Promise(r=>release=r);
  return {task:{state:'success',result:{text:JSON.stringify({group:requests.at(-1),sampled_at:1})}}};
 };
 const first=context.runSystemSettings({group:'sound',action:'read'});await new Promise(resolve=>setImmediate(resolve));assert.equal(typeof release,'function',context.systemSettingsState().message);
 context.selectSystemTab('语言与时间');context.selectSystemTab('网络与连接');assert.deepEqual(requests,['sound']);release();await first;
 for(let i=0;i<15&&context.systemSettingsState().pending;i++)await Promise.resolve();assert.deepEqual(requests,['sound','network']);
 assert.equal(context.systemSettingsState().pending,false);assert.equal(context.DEV[0].system_settings.network.group,'network');
 context.DEV[0].enabled=false;await context.runSystemSettings({group:'network',action:'set',key:'bluetooth',value:true});assert.equal(requests.length,2);
});

test('切换机型时旧发布请求不能覆盖新设备，未启用更新器不能下发',async()=>{
 const pending=new Map(),sent=[];
 const context=vm.createContext({crypto,URLSearchParams,adminSession:{check(){}},setTimeout(){},setInterval(){},fetch:(url,options)=>{
  if(options){sent.push(JSON.parse(options.body));return new Promise(()=>{});}
  return new Promise(resolve=>pending.set(new URL('https://test'+url).searchParams.get('device_id'),resolve));
 }});vm.runInContext(source,context);context.renderOps=()=>{};
 context.DEV=[{id:'d22',can_update:true,update_channel:'d22'},{id:'d31',can_update:false,update_channel:'d31'}];context.selDev='d22';
 const old=context.loadReleases();context.selDev='d31';const current=context.loadReleases();
 pending.get('d31')({ok:true,json:async()=>({ok:true,releases:[{versionCode:68,versionName:'D31版'}]})});await current;
 pending.get('d22')({ok:true,json:async()=>({ok:true,releases:[{versionCode:999,versionName:'D22版'}]})});await old;
 assert.equal(context.RELEASE_DEVICE,'d31');assert.equal(context.RELEASES[0].versionCode,68);
 assert.doesNotMatch(context.pageUpdate(''),/D22版/);assert.match(context.pageUpdate(''),/尚未启用客户端更新/);
 context.assignUpdate(68);assert.equal(sent.length,0);context.DEV[1].can_update=true;context.assignUpdate(68);
 assert.equal(sent.length,1);assert.equal(sent[0].channel,'d31');assert.equal(sent[0].device_id,'d31');
});
