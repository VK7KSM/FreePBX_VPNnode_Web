import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import fs from 'node:fs';
import worker from './worker.js';import {fixture,request,login} from './test-support.mjs';
function countRequests(f){const get=f.env.ELF_DO.get.bind(f.env.ELF_DO);let calls=0;f.env.ELF_DO.get=id=>{const stub=get(id);return {fetch(...args){calls++;return stub.fetch(...args);}}};return ()=>calls;}
test('设备与型号同批返回且只需一次DO请求，注销和伪造会话仍即时拒绝',async()=>{
 const f=fixture(),cookie=await login(f),count=countRequests(f);
 const r=await worker.fetch(request('/api/devices','GET',undefined,cookie),f.env);assert.equal(r.status,200);const b=await r.json();assert.ok(Array.isArray(b.models));assert.ok(Array.isArray(b.devices));assert.equal(count(),1);
 assert.equal((await worker.fetch(request('/api/devices','GET',undefined,'elf_admin=fake'),f.env)).status,401);
 assert.equal((await worker.fetch(request('/api/devices','GET',undefined,cookie,{Origin:'https://wrong.test'}),f.env)).status,403);
 await worker.fetch(request('/api/logout','POST',undefined,cookie),f.env);
 assert.equal((await worker.fetch(request('/api/devices','GET',undefined,cookie),f.env)).status,401);
});
test('额度错误变为可识别503，短时间重复请求不会继续调用DO',async()=>{
 let calls=0;const env={ELF_DO:{idFromName:x=>x,get:()=>({fetch(){calls++;throw Error('Exceeded allowed volume of requests in Durable Objects free tier.');}})}};
 for(let i=0;i<10;i++){const r=await worker.fetch(request('/api/devices'),env);assert.equal(r.status,503);assert.equal((await r.json()).code,'storage_quota_exceeded');assert.ok(Number(r.headers.get('Retry-After'))>0);}
 assert.equal(calls,1);assert.equal((await worker.fetch(request('/devices'),env)).status,200);
});

test('命令和文件结果查询在后台暂停，故障遵循Retry-After，恢复后不重新执行任务',async()=>{
 let now=100000,calls=0,status=503;class Clock extends Date{static now(){return now;}}
 const context=vm.createContext({Date:Clock,URLSearchParams,adminSession:{check(){}},setTimeout(){},setInterval(){},document:{hidden:false,addEventListener(){}},fetch:async()=>{calls++;return {ok:status===200,status,headers:{get:()=> '900'},json:async()=>({ok:true,task:{state:'success'}})};}});
 vm.runInContext(fs.readFileSync('devices-client.js','utf8'),context);const owner={};
 await assert.rejects(context.readWatchedTask(owner,'device','task'));assert.equal(calls,1);
 for(let i=0;i<100;i++){now+=2000;assert.equal(await context.readWatchedTask(owner,'device','task'),null);}assert.equal(calls,1);
 now+=900000;context.document.hidden=true;assert.equal(await context.readWatchedTask(owner,'device','task'),null);assert.equal(calls,1);
 context.document.hidden=false;status=200;assert.equal((await context.readWatchedTask(owner,'device','task')).task.state,'success');assert.equal(calls,2);
 status=404;await assert.rejects(context.readWatchedTask(owner,'device','gone'),e=>e.stopPolling===true);
});

test('任务与上报回执的只读查询复用一次DO鉴权，不接受失效会话',async()=>{
 const f=fixture(),cookie=await login(f),count=countRequests(f);
 for(const path of ['/api/elfremote/tasks?device_id=missing','/api/devices/status-request?device_id=missing']){
  const before=count();await worker.fetch(request(path,'GET',undefined,cookie),f.env);assert.equal(count()-before,1);
  assert.equal((await worker.fetch(request(path,'GET',undefined,'elf_admin=fake'),f.env)).status,401);
 }
});
test('空闲、后台、更新任务和失败退避使用不同轮询节奏',()=>{
 const timers=[],events={};const context=vm.createContext({Date,adminSession:{authenticated:true,check(){}},setTimeout(){},setInterval(fn){timers.push(fn)},document:{hidden:false,addEventListener(name,fn){events[name]=fn;}}});
 vm.runInContext(fs.readFileSync('devices-client.js','utf8'),context);let calls=0;context.loadDevices=()=>calls++;
 context.selFn='update';context.DEV=[];assert.equal(context.devicePollDelay(),30000);context.lastPollAt=Date.now()-5000;timers.at(-1)();assert.equal(calls,0);
 context.DEV=[{update:{state:'downloading'}}];assert.equal(context.devicePollDelay(),3000);timers.at(-1)();assert.equal(calls,1);
 context.document.hidden=true;context.lastPollAt=0;timers.at(-1)();assert.equal(calls,1);
 context.document.hidden=false;context.devicePollFailures=5;assert.equal(context.devicePollDelay(),240000);context.devicePollFailures=20;assert.equal(context.devicePollDelay(),300000);
 context.devicePollRetryAt=Date.now()+900000;context.lastPollAt=Date.now();assert.ok(context.devicePollDelay()>=899000);
});
test('无超时设备的分钟调度不重复保存设备，历史媒体每15分钟清理',async()=>{
 const f=fixture(),count=countRequests(f);f.env.ELF_ARTIFACTS={list:async()=>({objects:[]}),delete:async()=>{}};
 await worker.scheduled({scheduledTime:60000},f.env);assert.equal(count(),2);assert.equal(f.data.has('remote_devices'),false);
 const before=count();await worker.scheduled({scheduledTime:900000},f.env);assert.equal(count()-before,5);
});

test('设备刷新只访问一个接口，同时收到型号；一天空闲轮询上限2880轮',async()=>{
 let now=100000,calls=0;class Clock extends Date{static now(){return now;}}
 const timers=[],ops={querySelectorAll:()=>[],contains:()=>false},nodes={devOps:ops,deviceLoadError:{textContent:''}};
 const context=vm.createContext({Date:Clock,adminSession:{authenticated:true,check(){}},setTimeout(){},setInterval(fn){timers.push(fn)},document:{hidden:false,addEventListener(){},getElementById:id=>nodes[id]},fetch:async url=>{calls++;assert.equal(url,'/api/devices');return {ok:true,json:async()=>({ok:true,devices:[],models:[{id:'model'}]})};}});
 vm.runInContext(fs.readFileSync('devices-client.js','utf8'),context);
 for(const name of ['renderList','updateReportFeedback','renderMap','renderOps'])context[name]=()=>{};
 assert.equal(await context.loadDevices(),true);assert.equal(calls,1);assert.equal(context.MODELS[0].id,'model');
 calls=0;context.loadDevices=()=>calls++;for(let i=0;i<43200;i++){now+=2000;timers.at(-1)();}assert.equal(calls,2880);
});
test('SIP空闲和后台不再每2秒请求，通话时保持及时显示',()=>{
 const timers=[];const context=vm.createContext({Date,adminSession:{authenticated:true,check(){}},setInterval(fn){timers.push(fn)},document:{hidden:false,addEventListener(){}}});
 vm.runInContext(fs.readFileSync('sip-client.js','utf8'),context);let calls=0;context.readSip=()=>calls++;context.sipPollAt=Date.now()-5000;context.ST={active_calls:0};
 assert.equal(context.sipPollDelay(),10000);timers[0]();assert.equal(calls,0);context.ST.active_calls=1;timers[0]();assert.equal(calls,1);
 context.document.hidden=true;timers[0]();assert.equal(calls,1);context.sipPollFailures=8;assert.equal(context.sipPollDelay(),300000);
});
