import test from 'node:test';import assert from 'node:assert/strict';
import {faultTask,faultPending,faultReceipt,faultArchiveResult,faultArchiveQuery,faultNumber} from './fault-contract.js';
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
