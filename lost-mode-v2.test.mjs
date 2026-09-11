import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import worker from './worker.js';
import {fixture,request,login} from './test-support.mjs';
import {lostModeParams,normalizeLostMode,prepareWipe,authorizeWipe,applyRepairProgress} from './elfRemote/control-plane.js';

test('丢失模式退出关闭自毁，状态回执和公开结果不返回密码',()=>{
  const p=lostModeParams({version:2,enabled:false,message:'旧文字',password:'Test1234',auto_wipe_enabled:true,timeout_hours:24});
  assert.equal(p.auto_wipe_enabled,false);
  assert.equal(normalizeLostMode({...p,state:'disabled'}).password,undefined);
  for(const value of [0,169,1.5])assert.throws(()=>lostModeParams({...p,timeout_hours:value}));
  const d={task:{id:'one',type:'set_lost_mode',state:'running',params:{version:2}}};
  assert.throws(()=>applyRepairProgress(d,'one','success','',{lost_mode:{enabled:true,state:'enabled',message:'测试'}}));
  assert.equal(d.task.state,'running');
});
test('擦除确认绑定设备且两分钟过期，旧客户端或离线设备不能准备',()=>{
  const now=Date.now(),d={managed_lost_v2:true,managed_wipe_v1:true,managed_lost_safety_v1:true,lost_mode:{revision:"initial",revision_seq:0,state:"disabled"},last_seen:new Date(now).toISOString()};
  const c=prepareWipe(d,'擦除数据',now),params={phrase:'擦除数据',confirmation_id:c.id};
  assert.equal(authorizeWipe(d,params,now+119999),now+120000);
  assert.throws(()=>authorizeWipe(d,params,now+120000));
  assert.throws(()=>authorizeWipe({...d,wipe_confirmation:null},params,now));
  assert.throws(()=>prepareWipe({...d,managed_wipe_v1:false},'擦除数据',now));
  assert.throws(()=>prepareWipe({...d,last_seen:new Date(now-180000).toISOString()},'擦除数据',now));
  assert.throws(()=>prepareWipe(d,'清除数据',now));
});
test('擦除HTTP入口必须先准备确认，确认消耗后不能重复下发，不接受成功假回执',async()=>{
  const token='fixture-wipe-device-token';
  const f=fixture({admin_pass:'fixture-password',remote_devices:[{id:'test',status_only:true,enabled:true,last_seen:new Date().toISOString(),managed_lost_v2:true,managed_wipe_v1:true,managed_lost_safety_v1:true,lost_mode:{revision:"initial",revision_seq:0,state:"disabled"},token_sha256:createHash('sha256').update(token).digest('hex')}]});
  const cookie=await login(f),call=body=>worker.fetch(request('/api/elfremote/task','POST',{device_id:'test',...body},cookie),f.env);
  assert.equal((await call({type:'wipe_data',params:{phrase:'擦除数据',confirmation_id:crypto.randomUUID()}})).status,400);
  const prepared=await (await call({action:'prepare_wipe',phrase:'擦除数据'})).json();assert.equal(prepared.ok,true);
  const payload={id:'wipe-test',type:'wipe_data',params:{phrase:'擦除数据',confirmation_id:prepared.confirmation.id}};
  assert.equal((await call(payload)).status,200);
  const device=f.data.get('remote_devices')[0];assert.equal(device.wipe_confirmation,undefined);assert.equal(device.task.managed_lost_v1,true);
  assert.ok(device.task.expires_at-Date.now()<=120000);
  assert.equal((await call(payload)).status,400);
  device.task.state='running';assert.throws(()=>applyRepairProgress(device,'wipe-test','success','',{}));
});
test('丢失页面只保留锁屏和清除，切换设备后不得继续确认旧设备',async()=>{
  const source=await readFile('devices-client.js','utf8');
  const block=source.slice(source.indexOf('function pageLost('),source.indexOf('function lostRecTable'));
  let device={id:'test',name:'测试设备',managed_lost_v2:true,managed_wipe_v1:true,managed_lost_safety_v1:true,lost_mode:{revision:"initial",revision_seq:0,state:"disabled"}},calls=[];
  const elements={lostWipePhrase:{value:'擦除数据'}};
  const ctx={currentDev:()=>device,esc:s=>String(s),$:id=>elements[id],confirm:()=>true,crypto,Date,alert:()=>{},loadDevices:()=>{},fileApi:async(path,body)=>{calls.push(body);device={...device,id:'other'};return {confirmation:{id:crypto.randomUUID()}};}};
  vm.createContext(ctx);vm.runInContext(block,ctx);
  const html=ctx.pageLost('');
  for(const text of ['失主信息','尚未接通','远程录音','前置录像','远程锁机','fn-live'])assert.ok(!html.includes(text));
  assert.ok(html.includes('自毁程序'));assert.ok(html.includes('擦除数据'));
  await ctx.lostWipe();assert.equal(calls.length,1);assert.equal(calls[0].action,'prepare_wipe');
});
