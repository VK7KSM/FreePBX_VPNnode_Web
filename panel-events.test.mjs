import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {PanelEvents,panelRefreshDelay} from './panel-events.js';
import {panelEventsSource} from './panel-events-client.js';
import {nextContactChange,recoveryContact} from './report-recovery.js';
import worker from './worker.js';
import {fixture,request,login} from './test-support.mjs';

function attach(f){
  const messages=[],socket={send:data=>messages.push(data),close(){}};
  f.store.ctx.getWebSockets=tag=>{assert.equal(tag,'panel-events');return [socket];};
  return messages;
}
test('事务提交只通知一次，回滚与无关写入不通知，坏连接不破坏保存',async()=>{
  const f=fixture(),messages=attach(f);
  await f.store.events.transaction(async s=>{await s.put('remote_devices',[]);await s.put('remote_device_models',[]);});
  assert.deepEqual(messages,['{"type":"changed"}']);
  await assert.rejects(f.store.events.transaction(async s=>{await s.put('remote_devices',[{id:'rollback'}]);throw Error('rollback');}));
  assert.deepEqual(f.data.get('remote_devices'),[]);assert.equal(messages.length,1);
  await f.store.events.transaction(s=>s.put('report_recovery_run',{}));assert.equal(messages.length,1);
  f.store.ctx.getWebSockets=()=>[{send(){throw Error('closed');},close(){throw Error('closed');}}];
  await f.store.events.transaction(s=>s.put('remote_devices',[{id:'saved'}]));assert.equal(f.data.get('remote_devices')[0].id,'saved');
});
test('批量写入和删除同样通知，自动心跳及休眠附件不包含会话数据',async()=>{
  let sent=0,attachment,tags,pair;
  const previous=globalThis.WebSocketRequestResponsePair;
  globalThis.WebSocketRequestResponsePair=class{constructor(...args){this.args=args;}};
  try{
    const ctx={setWebSocketAutoResponse:p=>pair=p,acceptWebSocket(s,t){tags=t;},getWebSockets:()=>[socket],storage:{transaction:fn=>fn({put:async()=>{},delete:async()=>true})}};
    const socket={send(){sent++;},serializeAttachment:a=>attachment=a,deserializeAttachment:()=>attachment,close:code=>assert.equal(code,1008)};
    const events=new PanelEvents(ctx);events.accept(socket);
    assert.deepEqual(pair.args,['panel:ping','panel:pong']);assert.deepEqual(tags,['panel-events']);assert.deepEqual(attachment,{kind:'panel-events'});
    await events.transaction(async s=>{await s.put({remote_devices:[],remote_enrolls:{}});await s.delete(['remote_device_models']);});assert.equal(sent,2);
    events.message(socket,'panel:ping');assert.equal(sent,3);events.message(socket,'not-a-command');
  }finally{globalThis.WebSocketRequestResponsePair=previous;}
});
test('真实注册、报告和型号保存通知，连续读列表与空推送同步不会形成刷新循环',async()=>{
  const f=fixture(),cookie=await login(f),messages=attach(f),token='fixture-device';
  const call=(path,body,auth)=>worker.fetch(request(path,body?'POST':'GET',body,auth),f.env);
  const enrolled=await (await call('/api/devices/enroll',{token,token_sha256:createHash('sha256').update(token).digest('hex'),device_name:'测试设备',model_hint:'D22'})).json();
  assert.ok(messages.length);messages.length=0;
  const report=await call('/api/devices/report',{device_id:enrolled.device_id,token,network:'wifi',status_only:true,report_id:'fixture-report',reported_at:new Date().toISOString(),battery:80});
  assert.equal(report.status,200);assert.equal(messages.length,1);messages.length=0;
  for(let i=0;i<3;i++){
    assert.equal((await call('/api/devices',undefined,cookie)).status,200);
    assert.equal((await call('/api/devices/push-sync',{device_id:enrolled.device_id,token})).status,200);
  }
  assert.equal(messages.length,0);
  assert.equal((await call('/api/device-models',{name:'测试型号'},cookie)).status,200);assert.equal(messages.length,1);
  assert.equal((await call('/api/device-models',{action:'delete',id:'missing'},cookie)).status,404);assert.equal(messages.length,1);
});
test('通知入口验证会话、来源和升级协议，注销后不能重新订阅',async()=>{
  const f=fixture(),cookie=await login(f);
  const call=(auth,headers={},method='GET')=>worker.fetch(request('/api/devices/events',method,undefined,auth,headers),f.env);
  assert.equal((await call()).status,401);assert.equal((await call('elf_admin=fake')).status,401);
  assert.equal((await call(cookie,{Origin:'https://other.test',Upgrade:'websocket'})).status,403);
  assert.equal((await call(cookie)).status,426);
  await worker.fetch(request('/api/logout','POST',{},cookie),f.env);assert.equal((await call(cookie)).status,401);
});
test('在线状态到期按Wi-Fi、蜂窝、控制连接与补拉窗口刷新，不等待五分钟兜底',()=>{
  const at=Date.parse('2026-09-11T00:00:00Z'),iso=new Date(at).toISOString();
  for(const network of ['wifi','ethernet','cellular']){
    const d={last_seen:iso,status_only:true,network};
    assert.equal(nextContactChange(d,at),at+120001);
    const due=at+(network==='cellular'?3600000:900000)+90001;
    assert.equal(nextContactChange(d,at+120001),due);
    assert.equal(panelRefreshDelay([d],[],due-10000),10000);
    assert.equal(recoveryContact(d,due).state,'report_overdue');
    assert.equal(nextContactChange(d,due),null);
    d.report_probe={baseline:iso,attempts:1,state:'checking',received:true};
    assert.equal(recoveryContact(d,due).state,'awaiting_full_report');
    assert.equal(nextContactChange(d,due),due-1+360000);
  }
  assert.equal(nextContactChange({last_seen:iso},at),at+120001);
  assert.equal(panelRefreshDelay([{last_seen:'invalid'}],[],at),300000);
  assert.equal(panelRefreshDelay([{task:{state:'running',expires_at:at+4000}}],[],at),4000);
  assert.equal(panelRefreshDelay([{update:{state:'downloading',expires_at:at+5000}}],[],at),5000);
  assert.equal(panelRefreshDelay([],[{expires_at:new Date(at+6000).toISOString()}],at),6000);
});

function browser(){
  let now=100000,id=0,active=true,allowed=true,calls=0,refresh=()=>{calls++;};
  const timers=new Map(),sockets=[];
  class Clock extends Date{static now(){return now;}}
  class Socket{
    constructor(){this.readyState=1;this.sent=[];sockets.push(this);}
    send(data){this.sent.push(data);}
    close(){this.readyState=3;}
    message(data){this.onmessage?.({data});}
  }
  const context=vm.createContext({Date:Clock,Math,window:{},location:{origin:'https://example.test'},WebSocket:Socket,
    setTimeout(fn,delay){timers.set(++id,{fn,at:now+delay});return id;},clearTimeout(i){timers.delete(i);}});
  vm.runInContext(panelEventsSource,context);
  const controller=context.window.createPanelEvents({active:()=>active,allowed:()=>allowed,refresh:()=>refresh()});
  const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
  return {context,controller,sockets,timers,calls:()=>calls,setActive:v=>active=v,setAllowed:v=>allowed=v,setRefresh:fn=>refresh=fn,flush,
    async advance(ms){now+=ms;for(const [i,t] of [...timers])if(t.at<=now){timers.delete(i);t.fn();}await flush();},now:()=>now};
}
test('建立连接先同步，突发通知合并，读取中收到变化不会丢失',async()=>{
  const b=browser();b.controller.tick();const s=b.sockets[0];s.message('{"type":"ready"}');
  for(let i=0;i<20;i++)s.message('{"type":"changed"}');
  await b.advance(200);assert.equal(b.calls(),1);assert.equal(b.controller.connected(),true);
  let finish,calls=0;b.setRefresh(()=>{calls++;return calls===1?new Promise(r=>finish=r):undefined;});
  s.message('{"type":"changed"}');await b.advance(200);s.message('{"type":"changed"}');await b.advance(200);assert.equal(calls,1);
  finish();await b.flush();await b.advance(200);assert.equal(calls,2);
});
test('故障退避不请求也不反复建计时器，后台断开，恢复连接重新同步',async()=>{
  const b=browser();b.setAllowed(false);b.controller.tick();assert.equal(b.sockets.length,0);
  b.setAllowed(true);b.controller.tick();const s=b.sockets[0];s.message('{"type":"ready"}');await b.advance(200);
  b.setAllowed(false);s.message('{"type":"changed"}');for(let i=0;i<30;i++){await b.advance(2000);b.controller.tick();}
  assert.equal(b.calls(),1);assert.equal(b.timers.size,0);
  b.setAllowed(true);b.controller.tick();await b.advance(200);assert.equal(b.calls(),2);
  b.setActive(false);b.controller.tick();assert.equal(s.readyState,3);assert.equal(b.controller.connected(),false);
  b.setActive(true);b.controller.tick();assert.equal(b.sockets.length,2);b.sockets[1].message('{"type":"ready"}');await b.advance(200);assert.equal(b.calls(),3);
});
test('心跳不产生HTTP，失联及握手超时回到断线模式并有界重连',async()=>{
  const b=browser();b.controller.tick();const s=b.sockets[0];s.message('{"type":"ready"}');await b.advance(200);
  await b.advance(45000);b.controller.tick();assert.deepEqual(s.sent,['panel:ping']);assert.equal(b.calls(),1);
  await b.advance(46000);b.controller.tick();assert.equal(b.controller.connected(),false);assert.equal(s.readyState,3);
  b.controller.tick();assert.equal(b.sockets.length,1);await b.advance(6000);b.controller.tick();assert.equal(b.sockets.length,2);
  await b.advance(16000);b.controller.tick();assert.equal(b.sockets[1].readyState,3);
});
test('已连接的静置页面一天只做288次兜底读取，断线保留原查询及真实任务刷新',()=>{
  const b=browser(),timers=[];
  Object.assign(b.context,{adminSession:{authenticated:true,check(){}},setInterval:fn=>timers.push(fn),document:{hidden:false,addEventListener(){}}});
  vm.runInContext(fs.readFileSync('devices-client.js','utf8'),b.context);
  let calls=0;b.context.panelEvents={tick(){},connected:()=>true};b.context.lastPollAt=b.now();b.context.deviceRefreshAt=b.now()+300000;
  b.context.loadDevices=()=>{calls++;b.context.deviceRefreshAt=b.now()+300000;};
  // 独立同步时钟，纯本地循环不产生网络请求。
  let now=b.now();b.context.Date.now=()=>now;
  b.context.loadDevices=()=>{calls++;b.context.deviceRefreshAt=now+300000;};
  for(let i=0;i<43200;i++){now+=2000;timers.at(-1)();}assert.equal(calls,288);
  b.context.panelEvents.connected=()=>false;assert.equal(b.context.devicePollDelay(),30000);
  b.context.DEV=[{task:{state:'running'}}];assert.equal(b.context.devicePollDelay(),3000);
  b.context.panelEvents.connected=()=>true;b.context.deviceRefreshAt=now+1000;assert.equal(b.context.devicePollDelay(),1000);
});
