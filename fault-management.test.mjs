import test from 'node:test';import assert from 'node:assert/strict';
import {faultTask,faultPending,faultReceipt,faultArchiveResult,faultArchiveQuery,faultNumber,faultCapacitySummary} from './fault-contract.js';
import {faultHash,faultJson,verifyFaultPackage} from './fault-package.js';
import vm from 'node:vm';import faultClientSource from './fault-client-source.js';
const id='a'.repeat(64),sha='b'.repeat(64),enc=new TextEncoder();
function crc32(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
function zip(entries){const local=[],central=[];let offset=0;
 for(const [name,data] of entries){const n=Buffer.from(name),b=Buffer.from(data),l=Buffer.alloc(30),c=Buffer.alloc(46);l.writeUInt32LE(0x04034b50);l.writeUInt16LE(20,4);l.writeUInt32LE(crc32(b),14);l.writeUInt32LE(b.length,18);l.writeUInt32LE(b.length,22);l.writeUInt16LE(n.length,26);
 c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt32LE(crc32(b),16);c.writeUInt32LE(b.length,20);c.writeUInt32LE(b.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE(offset,42);local.push(l,n,b);central.push(c,n);offset+=l.length+n.length+b.length;}
 const cd=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,cd,end]);}
async function fixture(change=()=>{}){
 const content={'event.json':'{}','state.json':'{"capture":"PARTIAL"}','export-seal.json':'{}','attempt-1/raw.bin':'partial source'};
 const files=await Promise.all(Object.entries(content).map(async([path,value])=>({path,bytes:Buffer.byteLength(value),sha256:await faultHash(Buffer.from(value)),role:path.endsWith('.bin')?'RAW':'METADATA'})));
 const m={schemaVersion:1,kind:'FAULT_EVENT_BUNDLE',eventId:id,scope:'ALL_FROZEN_EVENT_FILES',files,totalBytes:files.reduce((a,f)=>a+f.bytes,0),rawFiles:1,gaps:['PRE_FAULT_CONTINUOUS_LOGS_UNAVAILABLE']};
 const entries=Object.entries(content).map(([n,d])=>['evidence/'+n,Buffer.from(d)]);change(m,entries);const mb=Buffer.from(JSON.stringify(m));entries.unshift(['manifest.json',mb]);const bytes=zip(entries),r={schemaVersion:1,kind:'FAULT_EVENT_EXPORT',state:'EXPORTED',eventId:id,bytes:bytes.length,sha256:await faultHash(bytes),manifestSha256:await faultHash(mb),manifestBytes:mb.length,files:files.length,evidenceBytes:m.totalBytes,exportNumber:1,path:`/data/local/d31-remote/faults/${id}/exports/export-1/bundle.zip`,captureState:'PARTIAL'};
 return {bytes,receipt:r};
}
test('故障包逐项校验与源窗口缺口独立，部分采集允许完整保全',async()=>{const f=await fixture(),p=await verifyFaultPackage(f.bytes,f.receipt,id);assert.equal(p.state,'HOST_PACKAGE_VERIFIED');assert.equal(p.sourceLogComplete,false);assert.equal(p.gapCount,1);assert.equal(p.deviceArchiveExecuted,false);assert.deepEqual(p.archiveArgs,['archive',id,f.receipt.sha256,String(f.receipt.bytes),f.receipt.manifestSha256]);});
test('包摘要正确仍拒绝原件摘要错误、重复、路径越界、漏项和额外条目',async()=>{
 const mutations=[(m,a)=>a[0][1]=Buffer.from('{"wrong":1}'),(m,a)=>a.push(a[0]),m=>m.files[0].path='../outside',m=>m.files.pop(),(m,a)=>a.push(['extra.txt',Buffer.from('x')])];
 for(const mutate of mutations){const f=await fixture(mutate);await assert.rejects(verifyFaultPackage(f.bytes,f.receipt,id));}
});

// 目录和请求均为离线替身；锁实现真实持有/竞争语义，不无条件授予。
function mutex(){const held=new Set();return {async request(name,options,fn){if(held.has(name)){assert.equal(options.ifAvailable,true);return fn(null);}held.add(name);try{return await fn({name});}finally{held.delete(name);}}};}
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function workflowHarness({disk=new Map(),locks=mutex(),hooks={},fetcher,deviceId='synthetic'}={}){
 const calls=[],device={id:deviceId,model_id:'mdl_d31',enabled:true,managed_exec_tasks:true,managed_file_return:true,app_version:'1.28-test'};
 const directory={async getFileHandle(name,options={}){await hooks.handle?.(name,options);if(!disk.has(name)&&!options.create){await hooks.missing?.(name);const error=Error('missing');error.name='NotFoundError';throw error;}
  return {async getFile(){await hooks.read?.(name);const bytes=disk.get(name)||new Uint8Array();return {size:bytes.length,async arrayBuffer(){return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);}};},async createWritable(){let next;return {async write(bytes){next=typeof bytes==='string'?enc.encode(bytes):new Uint8Array(bytes);await hooks.write?.(name,next);},async close(){await hooks.close?.(name,next);disk.set(name,next);},async abort(){}};}};
 }};
 const window={currentDev:()=>device,renderOps(){},showDirectoryPicker:async()=>{await hooks.picker?.();return directory;}};
 const fetch=async(url,options={})=>{calls.push({url,options});if(url==='/api/devices')return Response.json({ok:true,devices:[device]});if(fetcher)return fetcher(url,options);throw Error('offline stop');};
 const context=vm.createContext({window,showDirectoryPicker:window.showDirectoryPicker,navigator:{locks},crypto,TextEncoder,TextDecoder,DataView,Uint8Array,URLSearchParams,Date,performance,AbortSignal,fetch,setTimeout});vm.runInContext(faultClientSource,context);
 return {ui:window.ElfFaults,disk,calls,device};
}
function downloadState(f){return {schemaVersion:1,target:{deviceId:'synthetic',expectedVersion:'1.28-test'},tasks:{},activeApk:'/data/local/d31-remote/releases/'+sha+'/remote.apk',events:{[id]:{eventId:id,phase:'DOWNLOAD',tasks:{getFile:{request:{id:'existing-get-file'}}},query:{state:{phase:'PARTIAL'}},receipt:f.receipt,bundle:'existing.zip'}},cursor:''};}
function writeState(disk,state){disk.set('fault-web-state.json',enc.encode(JSON.stringify(state)));}
function readState(disk){return JSON.parse(new TextDecoder().decode(disk.get('fault-web-state.json')));}
function downloadFetch(f,disk){return async url=>{assert.ok(url.startsWith('/api/elfremote/file-return?'));const state=readState(disk);assert.notEqual(state.events[id].bundle,'existing.zip','新尝试名称必须在请求前持久化');if(url.includes('download=1'))return new Response(f.bytes);return Response.json({ok:true,file:{state:'ready',device_id:'synthetic',task_id:'existing-get-file',size:f.receipt.bytes,sha256:f.receipt.sha256}});};}

test('新目录初始化持锁；并发页面不能用迟到的不存在结果覆盖持久任务',async()=>{
 const disk=new Map(),locks=mutex(),entered=deferred(),release=deferred();let missing=0;
 const first=workflowHarness({disk,locks,hooks:{missing:async name=>{if(name==='fault-web-state.json'&&++missing===1){entered.resolve();await release.promise;}}}});
 const pending=first.ui.choose();await entered.promise;
 const second=workflowHarness({disk,locks});await second.ui.choose();assert.match(second.ui.page(),/另一个页面/);assert.equal(disk.size,0);
 release.resolve();await pending;await first.ui.scan();const original=readState(disk).tasks.active.request.id;
 await second.ui.choose();assert.equal(readState(disk).tasks.active.request.id,original);assert.match(second.ui.page(),/已恢复/);
});
test('不同设备误选同一新目录也互斥，已有身份不被覆盖',async()=>{
 const disk=new Map(),locks=mutex(),entered=deferred(),release=deferred();
 const a=workflowHarness({disk,locks,hooks:{missing:async()=>{entered.resolve();await release.promise;}}}),b=workflowHarness({disk,locks,deviceId:'other-synthetic'});
 const selecting=a.ui.choose();await entered.promise;await b.ui.choose();assert.match(b.ui.page(),/另一个页面/);release.resolve();await selecting;
 const before=disk.get('fault-web-state.json');await b.ui.choose();assert.match(b.ui.page(),/其他目标/);assert.deepEqual(disk.get('fault-web-state.json'),before);
});
test('完整本机包先恢复并逐项验包，服务器404或503均不查询暂存也不重建任务',async()=>{
 for(const status of [404,503]){const f=await fixture(),disk=new Map([['existing.zip',f.bytes]]);writeState(disk,downloadState(f));const h=workflowHarness({disk,fetcher:async()=>Response.json({ok:false,msg:'暂存不可用'},{status})});await h.ui.choose();h.ui.select(id);await h.ui.transfer();assert.equal(readState(disk).events[id].phase,'ARCHIVE');assert.equal(h.calls.length,1);assert.equal(h.calls[0].url,'/api/devices');assert.match(h.ui.page(),/逐项校验通过/);}
});
test('整包摘要匹配也仍核验内部条目，不能把完整下载冒充验包完成',async()=>{
 const f=await fixture((m,entries)=>entries[0][1]=Buffer.from('wrong source')),disk=new Map([['existing.zip',f.bytes]]);writeState(disk,downloadState(f));const h=workflowHarness({disk});await h.ui.choose();h.ui.select(id);await h.ui.transfer();assert.equal(readState(disk).events[id].phase,'VERIFY');assert.equal(readState(disk).events[id].proof,undefined);assert.equal(h.calls.length,1);
});
test('异常本机原包保留，新尝试先落盘名称再下载，刷新后仍显示异常原件',async()=>{
 const f=await fixture(),old=enc.encode('damaged original'),disk=new Map([['existing.zip',old]]);writeState(disk,downloadState(f));const h=workflowHarness({disk,fetcher:downloadFetch(f,disk)});await h.ui.choose();h.ui.select(id);await h.ui.transfer();const ev=readState(disk).events[id];assert.equal(ev.phase,'ARCHIVE');assert.notEqual(ev.bundle,'existing.zip');assert.deepEqual(disk.get('existing.zip'),old);assert.equal(ev.retainedAttempts[0].name,'existing.zip');assert.deepEqual(disk.get(ev.bundle),new Uint8Array(f.bytes));
 const restored=workflowHarness({disk});await restored.ui.choose();restored.ui.select(id);assert.match(restored.ui.page(),/异常原包已保留/);assert.match(restored.ui.page(),/existing.zip/);
});
test('网络或写入失败保留原任务、异常原包和已持久化的新尝试名称',async()=>{
 for(const failure of ['network','write']){const f=await fixture(),old=enc.encode('damaged original'),disk=new Map([['existing.zip',old]]);const state=downloadState(f);writeState(disk,state);
  const h=workflowHarness({disk,fetcher:failure==='network'?async()=>Response.json({ok:false},{status:503}):downloadFetch(f,disk),hooks:{write:async name=>{if(failure==='write'&&name.endsWith('.zip'))throw Error('write failed');}}});await h.ui.choose();h.ui.select(id);await h.ui.transfer();const ev=readState(disk).events[id];assert.equal(ev.phase,'DOWNLOAD');assert.notEqual(ev.bundle,'existing.zip');assert.deepEqual(ev.tasks,state.events[id].tasks);assert.deepEqual(disk.get('existing.zip'),old);assert.equal(disk.has(ev.bundle),false);assert.equal(ev.retainedAttempts.length,1);
 }
});
test('目录取消、权限拒绝及超大本机文件阻断操作，不当作缺失自动覆盖',async()=>{
 for(const mode of ['cancel','denied','oversize']){const f=await fixture(),disk=new Map([['existing.zip',mode==='oversize'?new Uint8Array(8388609):f.bytes]]);writeState(disk,downloadState(f));const before=disk.get('fault-web-state.json');
  const h=workflowHarness({disk,hooks:{picker:async()=>{if(mode==='cancel'){const er=Error('cancel');er.name='AbortError';throw er;}},read:async name=>{if(mode==='denied'&&name==='existing.zip'){const er=Error('permission denied');er.name='NotAllowedError';throw er;}}}});await h.ui.choose();h.ui.select(id);await h.ui.transfer();assert.deepEqual(disk.get('fault-web-state.json'),before);assert.equal(h.calls.filter(c=>c.url!=='/api/devices').length,0);assert.match(h.ui.page(),mode==='cancel'?/先选择/:mode==='denied'?/permission denied/:/超过允许大小/);
 }
});
test('持续采集容量区分在途、待归档与保留预算，旧合同及缺失风险不补零',()=>{
 const lines=faultCapacitySummary({admissionPolicy:'IN_FLIGHT_AND_RETAINED_BUDGETS',collectingEvents:2,maxCollectingEvents:32,awaitingArchiveEvents:38,activeEvents:40,retainedEvents:90,maxRetainedEvents:128,retainedBytes:123,maxArchiveBytes:999,continuationAction:'HOST_VERIFY_EXPORT_AND_ACK_OR_RETAINED_CAPACITY_REVIEW',uncollectedSourcesMayExpire:true,admissionBlockedBy:['COLLECTING_EVENT_LIMIT','EXPORT_HEADROOM_LIMIT']}).join('\n');
 assert.match(lines,/采集中 2 \/ 32/);assert.match(lines,/采完待归档 38/);assert.match(lines,/未归档合计 40/);assert.match(lines,/保留 90 \/ 128/);assert.match(lines,/未采集源可能过期：是/);assert.match(lines,/不释放保留数量或原件字节/);assert.match(lines,/导出预留空间不足/);
 const old=faultCapacitySummary({activeEvents:3,maxActiveEvents:32,admissionPolicy:'UNARCHIVED_EVENT_LIMIT',continuationAction:'NONE'}).join('\n');assert.match(old,/未归档 3 \/ 32/);assert.match(old,/未采集源可能过期：未知/);assert.match(faultCapacitySummary({collectingEvents:-1}).join('\n'),/采集中 未知/);
});
test('重复JSON键和损坏ZIP均拒绝，空白解析正常',async()=>{assert.throws(()=>faultJson(enc.encode('{"a":1,"a":2}')),/重复/);assert.throws(()=>faultJson(enc.encode('{"a":{"x":0,"x":1}}')),/重复/);assert.deepEqual(faultJson(enc.encode(' {"a": [true, null, -2.5]} ')),{a:[true,null,-2.5]});const f=await fixture();f.bytes[35]^=1;f.receipt.sha256=await faultHash(f.bytes);await assert.rejects(verifyFaultPackage(f.bytes,f.receipt,id));});
test('持久意图先写再查询，网络中断恢复仅使用原号，不创建第二个任务',async()=>{
 const state={target:{deviceId:'synthetic'}},events=[],uuid='00000000-0000-4000-8000-000000000000';let first=true;
 const args={state,key:'export',type:'root_exec',params:{command:'safe'},save:async()=>events.push('save'),uuid:()=>uuid,now:()=>1000,request:async(route,body)=>{events.push(body?'send':'query');if(!body)return null;if(first){first=false;throw Error('network');}return {task:{id:body.id,type:body.type,state:'success',result:{exit_code:0,text:'{"done":true}'}}};}};
 await assert.rejects(faultTask(args),/network/);const original=structuredClone(state.tasks.export.request);assert.equal(events[0],'save');assert.deepEqual(await faultTask(args),{done:true});assert.deepEqual(state.tasks.export.request,original);assert.deepEqual(events,['save','query','send','query','send','save']);
});
test('未知任务查询、过期原号、错设备参数、截断结果均阻断补交',async()=>{
 const common={key:'x',type:'root_exec',params:{command:'safe'},save:async()=>{},uuid:()=> '00000000-0000-4000-8000-000000000000',now:()=>1000};let sends=0;
 const state={target:{deviceId:'synthetic'}};await assert.rejects(faultTask({...common,state,request:async()=>{throw Error('unknown');}}),/unknown/);
 await assert.rejects(faultTask({...common,state,now:()=>1000000,request:async(r,b)=>{if(b)sends++;return null;}}),/过期/);assert.equal(sends,0);
 await assert.rejects(faultTask({...common,state,params:{command:'other'},request:async()=>null}),/不符/);
 await assert.rejects(faultTask({...common,state,request:async()=>({task:{id:state.tasks.x.request.id,type:'root_exec',state:'success',result:{truncated:true}}})}),/截断/);
});
test('待办分页不把未核验归档字段当完成；归档必须原件保留且独立查询绑定同包',()=>{
 const page={kind:'FAULT_PENDING_INDEX',events:[{eventId:id,archiveState:'ACK_RECORDED_UNVERIFIED'}],hasMore:false};assert.equal(faultPending(page).events.length,1);assert.equal(faultNumber(-1),'未知');assert.throws(()=>faultPending({...page,hasMore:true,nextAfter:'bad'}));
 const r={eventId:id,bytes:12,sha256:sha,manifestSha256:sha};assert.throws(()=>faultArchiveResult({...r,state:'ARCHIVED',originalsDeleted:true,releasedBytes:12,activeSlotReleased:true},r));assert.throws(()=>faultArchiveQuery({eventId:id,export:{archived:true,state:'EXPORTED',receipt:{...r,sha256:'c'.repeat(64)}}},r));
});
test('浏览器真实入口完成导出、取回、逐项验包和独立归档；刷新后原件丢失阻断归档',async()=>{
 const f=await fixture(),disk=new Map(),tasks=new Map();let archived=false,sends=0;
 const device={id:'synthetic',model_id:'mdl_d31',enabled:true,managed_exec_tasks:true,managed_file_return:true,app_version:'1.23.2-candidate'};
 const directory={async getFileHandle(name,options={}){if(!disk.has(name)&&!options.create){const er=Error('missing');er.name='NotFoundError';throw er;}return {async getFile(){const bytes=disk.get(name)||new Uint8Array();return {size:bytes.length,async arrayBuffer(){return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);}};},async createWritable(){let next;return {async write(b){next=typeof b==='string'?enc.encode(b):new Uint8Array(b);},async close(){disk.set(name,next);},async abort(){}};}};}};
 const fetcher=async(url,options={})=>{
  if(url==='/api/devices')return Response.json({ok:true,devices:[device]});
  if(url.startsWith('/api/elfremote/tasks?')){const task=tasks.get(new URL('https://x'+url).searchParams.get('task_id'));return Response.json(task?{ok:true,task}:{ok:false,msg:'未找到该任务'},{status:task?200:404});}
  if(url==='/api/elfremote/task'){const req=JSON.parse(options.body);sends++;let result;
   if(req.type==='get_file')result={action:'uploaded',bytes:f.receipt.bytes,sha256:f.receipt.sha256};
   else {let value;if(req.params.command.startsWith('cat '))value={versionName:device.app_version,path:'/data/local/d31-remote/releases/'+sha+'/remote.apk'};
    else if(req.params.command.includes(' pending '))value={kind:'FAULT_PENDING_INDEX',events:[{eventId:id,category:'BOOT',phase:'PARTIAL',captureState:'PARTIAL',exportState:'NONE',archiveState:'ACK_RECORDED_UNVERIFIED'}],hasMore:false,nextAfter:id};
    else if(req.params.command.includes(' export '))value=f.receipt;
    else if(req.params.command.includes(' archive ')){archived=true;value={...f.receipt,state:'ARCHIVED',originalsDeleted:false,releasedBytes:0,activeSlotReleased:true};}
    else value={eventId:id,state:{phase:'PARTIAL'},export:{state:'EXPORTED',archived,receipt:f.receipt}};
    result={exit_code:0,text:JSON.stringify(value)};
   }const task={id:req.id,type:req.type,state:'success',result};tasks.set(req.id,task);return Response.json({ok:true,task});
  }
  if(url.startsWith('/api/elfremote/file-return?')){if(url.includes('download=1'))return new Response(f.bytes);const taskId=new URL('https://x'+url).searchParams.get('task_id');return Response.json({ok:true,file:{state:'ready',device_id:device.id,task_id:taskId,size:f.receipt.bytes,sha256:f.receipt.sha256}});}
  throw Error('unexpected request');
 };
 const boot=()=>{const window={currentDev:()=>device,renderOps(){},showDirectoryPicker:async()=>directory};const c=vm.createContext({window,showDirectoryPicker:window.showDirectoryPicker,navigator:{locks:{request:async(n,o,fn)=>fn({})}},crypto,TextEncoder,TextDecoder,DataView,Uint8Array,URLSearchParams,Date,performance,AbortSignal,fetch:fetcher,setTimeout});vm.runInContext(faultClientSource,c);return window.ElfFaults;};
 let ui=boot();await ui.choose();await ui.scan();ui.select(id);await ui.query();await ui.transfer();assert.equal(archived,false);assert.match(ui.page(),/逐项校验通过/);
 const state=JSON.parse(new TextDecoder().decode(disk.get('fault-web-state.json'))),bundle=state.events[id].bundle,bytes=disk.get(bundle);disk.delete(bundle);
 ui=boot();await ui.choose();ui.select(id);const before=sends;await ui.archive();assert.equal(archived,false);assert.equal(sends,before);assert.match(ui.page(),/missing/);
 disk.set(bundle,bytes);await ui.archive();assert.equal(archived,true);assert.match(ui.page(),/归档已独立确认/);const count=sends;await ui.archive();assert.equal(sends,count);
});
