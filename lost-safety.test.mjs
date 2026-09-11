import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import worker from './worker.js';
import {fixture,request,login} from './test-support.mjs';
import {enqueueRepairTask,applyRepairProgress,prepareWipe,authorizeWipe,mergeLostMode} from './elfRemote/control-plane.js';
import {pushState,statusNotification} from './push-control.js';

const now=Date.now(),revision=crypto.randomUUID();
const mode={version:2,state:'disabled',enabled:false,auto_wipe_enabled:false,locked:false,restored:true,timeout_hours:24,deadline_at:0,wipe_state:'idle',revision,revision_seq:2};
const params={version:2,enabled:false,auto_wipe_enabled:false,timeout_hours:24};
function device(){return {id:'fixture-device',enabled:false,status_only:true,managed_lost_tasks:true,managed_lost_v2:true,managed_lost_safety_v1:true,managed_wipe_v1:true,last_seen:new Date(now).toISOString(),lost_mode:{...mode},task:{id:'ordinary',type:'send_file',state:'running',expires_at:now+86400000}};}
test('退出独立入队且保留正在传输的普通任务',async()=>{
  const d=device(),ordinary=structuredClone(d.task);
  const outcome=await enqueueRepairTask(d,{id:'exit',type:'set_lost_mode',params},now);
  assert.equal(outcome.ok,true);assert.equal(d.safety_task.id,'exit');assert.deepEqual(d.task,ordinary);
  assert.equal((await enqueueRepairTask(d,{id:'exit',type:'set_lost_mode',params},now)).duplicate,true);
});
test('错误退出回执不能伪装成功，旧报告不能覆盖本地取消的新策略',async()=>{
  for(const override of [{enabled:true,state:'enabled',message:'测试'},{auto_wipe_enabled:true},{deadline_at:1},{restored:false},{wipe_state:'started'},{revision_seq:undefined},{auto_wipe_enabled:undefined}]){
    const d=device();await enqueueRepairTask(d,{id:'exit',type:'set_lost_mode',params},now);d.safety_task.state='running';
    assert.throws(()=>applyRepairProgress(d,'exit','success','',{lost_mode:{...mode,...override}},now));assert.equal(d.safety_task.state,'running');
  }
  const d=device();await enqueueRepairTask(d,{id:'exit',type:'set_lost_mode',params},now);d.safety_task.state='running';
  applyRepairProgress(d,'exit','success','',{lost_mode:mode},now);assert.equal(d.safety_task.state,'success');
  mergeLostMode(d,{...mode,revision_seq:1,state:'enabled',enabled:true},now+1000);assert.equal(d.lost_mode.enabled,false);
  mergeLostMode(d,{version:2,state:'unknown'},now+2000);assert.equal(d.lost_mode.state,'unknown');assert.equal(d.lost_mode.revision,revision);
});
test('关闭自毁保持丢失锁屏，安全回执必须证明清除调度取消',async()=>{
  const d=device(),cancel={...params,enabled:true,cancel_auto:true};
  assert.equal((await enqueueRepairTask(d,{id:'cancel',type:'set_lost_mode',params:cancel},now)).ok,true);d.safety_task.state='running';
  applyRepairProgress(d,'cancel','success','',{lost_mode:{...mode,enabled:true,state:'enabled',message:'测试',locked:true,restored:false}},now);
  assert.equal(d.lost_mode.enabled,true);assert.equal(d.lost_mode.auto_wipe_enabled,false);
});
test('停用设备仍能收到安全推送且不下发普通任务，旧通知不吞掉新退出',async()=>{
  const d=device(),token='fixture-device-secret';d.token_sha256=createHash('sha256').update(token).digest('hex');
  await enqueueRepairTask(d,{id:'exit',type:'set_lost_mode',params},now);
  const data=new Map(),storage={get:async k=>data.get(k),put:async(k,v)=>data.set(k,v)};
  const rpc=(action,body)=>pushState(storage,new Request('https://unit/__push/'+action,{method:'POST',body:JSON.stringify({device_id:d.id,...body})}),async()=>[d],now);
  const prepared=await (await rpc('prepare',{})).json();assert.equal(statusNotification(prepared.request).managed_safety,true);
  const synced=await (await rpc('sync',{token})).json();assert.equal(synced.managed_safety_task.id,'exit');assert.equal(synced.managed_task,undefined);
  d.safety_task.id='exit-new';const next=await(await rpc('prepare',{})).json();assert.notEqual(next.request.request_id,prepared.request.request_id);assert.equal(next.should_publish,true);
  assert.equal((await rpc('sync',{token:'wrong'})).status,401);
});
test('HTTP安全退出可用于停用设备，普通任务继续被拒绝',async()=>{
  const d=device(),f=fixture({admin_pass:'fixture-password',remote_devices:[d]}),cookie=await login(f);
  const call=body=>worker.fetch(request('/api/elfremote/task','POST',{device_id:d.id,...body},cookie),f.env);
  assert.equal((await call({type:'set_lost_mode',params})).status,200);
  assert.equal(f.data.get('remote_devices')[0].task.id,'ordinary');
  assert.equal((await call({type:'root_exec',params:{command:'true'}})).status,409);
});
test('未知或旧策略不能授权擦除，退出后先前确认作废',()=>{
  const d=device();const c=prepareWipe(d,'擦除数据',now);d.lost_mode={...mode,revision:crypto.randomUUID()};
  assert.throws(()=>authorizeWipe(d,{phrase:'擦除数据',confirmation_id:c.id},now));
  assert.throws(()=>prepareWipe({...d,managed_lost_safety_v1:false},'擦除数据',now));
  assert.throws(()=>prepareWipe({...d,lost_mode:{state:'unknown'}},'擦除数据',now));
});
test('网页取消自毁不乐观显示成功，停用时退出仍可点击',async()=>{
  const s=await readFile('devices-client.js','utf8'),d={...device(),lost_mode:{...mode,enabled:true,state:'enabled',auto_wipe_enabled:true}};
  const calls=[],ctx={currentDev:()=>d,esc:String,Date,alert:()=>{},renderOps:()=>{},enqueueRepair:async(type,p)=>calls.push(p)};
  vm.createContext(ctx);vm.runInContext(s.slice(s.indexOf('function pageLost('),s.indexOf('function lostRecTable')),ctx);
  vm.runInContext(s.slice(s.indexOf('async function lostAutoChanged('),s.indexOf('function lostVideo(')),ctx);
  const html=ctx.pageLost(' disabled');assert.match(html,/onclick="setLostMode\(false\)">退出/);
  const box={checked:false};await ctx.lostAutoChanged(box);assert.equal(box.checked,true);assert.equal(calls[0].cancel_auto,true);
});
