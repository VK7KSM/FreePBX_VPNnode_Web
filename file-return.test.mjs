import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import worker from './worker.js';import {fixture,request,login} from './test-support.mjs';import {FILE_CHUNK} from './file-transfer.js';import {cleanupReturns,returnParams} from './file-return.js';
const sha=b=>createHash('sha256').update(b).digest('hex');
function setup(){const token='return-fixture-token',f=fixture({admin_pass:'fixture-password',remote_devices:[{id:'lab',enabled:true,status_only:true,managed_file_return:true,token_sha256:sha(token)}]}),objects=new Map();
 f.env.ELF_ARTIFACTS={async put(k,s,o){const b=Buffer.from(await new Response(s).arrayBuffer());assert.equal(sha(b),o.sha256);objects.set(k,b);},async get(k,o){let b=objects.get(k);if(!b)return null;if(o?.range)b=b.subarray(o.range.offset,o.range.offset+o.range.length);return {body:new Response(b).body};},async list({prefix}){return {objects:[...objects.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key})),truncated:false};},async delete(keys){for(const k of keys)objects.delete(k);}};return {...f,objects,token};}
test('取回文件跨分块下载、Range、断点重试与完整结果核验',async()=>{
 const f=setup(),c=await login(f),job={device_id:'lab',id:'return-one',type:'get_file',params:{path:'/sdcard/测试文件.bin'}};
 const admin=(path,b)=>worker.fetch(request(path,b?'POST':'GET',b,c),f.env);
 assert.equal((await admin('/api/elfremote/task',job)).status,200);
 const path='/api/elfremote/file-return?device_id=lab&task_id=return-one',post=(b,token=f.token)=>worker.fetch(request(path,'POST',b,null,{Authorization:'Bearer '+token}),f.env);
 const data=Buffer.alloc(FILE_CHUNK+7,42);data[data.length-1]=99;
 assert.equal((await post({action:'init',size:data.length,sha256:sha(data)},'bad')).status,401);
 assert.equal((await post({action:'admin'})).status,400);
 assert.equal((await post({action:'init',size:data.length,sha256:sha(data)})).status,200);
 assert.equal((await post({action:'complete'})).status,400);
 const progress=(state,result)=>worker.fetch(request('/api/elfremote/task-progress','POST',{device_id:'lab',task_id:job.id,token:f.token,state,result}),f.env);
 await progress('claimed');await progress('running');assert.equal((await progress('success',{action:'uploaded',bytes:data.length,sha256:sha(data)})).status,409);
 for(let i=0;i<2;i++){const b=data.subarray(i*FILE_CHUNK,(i+1)*FILE_CHUNK),put=()=>worker.fetch(new Request('https://example.test'+path+'&part='+i+'&sha256='+sha(b),{method:'PUT',headers:{Authorization:'Bearer '+f.token,'Content-Length':String(b.length)},body:b}),f.env);assert.equal((await put()).status,200);assert.equal((await put()).status,200);}
 assert.equal(f.objects.size,2);assert.equal((await post({action:'complete'})).status,200);assert.equal((await progress('success',{action:'uploaded',bytes:data.length,sha256:sha(data)})).status,200);
 assert.equal((await worker.fetch(request(path+'&download=1'),f.env)).status,401);
 const download=await admin(path+'&download=1');assert.equal(download.headers.get('content-length'),String(data.length));assert.equal(sha(Buffer.from(await download.arrayBuffer())),sha(data));
 const range=await worker.fetch(request(path+'&download=1','GET',undefined,c,{Range:`bytes=${FILE_CHUNK-3}-${FILE_CHUNK+3}`}),f.env);assert.equal(range.status,206);assert.deepEqual(Buffer.from(await range.arrayBuffer()),data.subarray(FILE_CHUNK-3,FILE_CHUNK+4));
 f.data.get('file-return/lab/return-one').expires_at=1;await cleanupReturns(f.env,f.env.ELF_DO.get('main'));assert.equal(f.objects.size,0);assert.equal(f.data.has('file-return/lab/return-one'),false);
});
test('取消与错误目标拒绝继续取回，空文件可完整下载',async()=>{
 const f=setup(),c=await login(f),path='/api/elfremote/file-return?device_id=lab&task_id=empty';
 assert.throws(()=>returnParams({path:'/a/../b'}));
 await worker.fetch(request('/api/elfremote/task','POST',{device_id:'lab',id:'empty',type:'get_file',params:{path:'/empty'}},c),f.env);
 const post=b=>worker.fetch(request(path,'POST',b,null,{Authorization:'Bearer '+f.token}),f.env);
 await post({action:'init',size:0,sha256:sha('')});await post({action:'complete'});
 const r=await worker.fetch(request(path+'&download=1','GET',undefined,c),f.env);assert.equal(r.status,200);assert.equal((await r.arrayBuffer()).byteLength,0);
 await worker.fetch(request('/api/elfremote/task','POST',{device_id:'lab',action:'cancel',task_id:'empty'},c),f.env);assert.equal((await post({action:'get'})).status,409);
});

test('只有管理员完整落盘回执才能清理；删除失败可定时重试且回执幂等',async()=>{
 const f=setup(),c=await login(f),p='/api/elfremote/file-return/received?device_id=lab&task_id=saved',bytes=Buffer.from('合成文件'),hash=sha(bytes),object='device-files/return/lab/saved/0-'+hash;
 f.data.set('file-return/lab/saved',{device_id:'lab',task_id:'saved',size:bytes.length,sha256:hash,state:'ready',expires_at:Date.now()+86400000,parts:{0:{bytes:bytes.length,sha256:hash}}});f.objects.set(object,bytes);
 const send=(body,cookie=c)=>worker.fetch(request(p,'POST',body,cookie),f.env);
 assert.equal((await send({size:bytes.length,sha256:hash},null)).status,401);
 assert.equal((await send({size:bytes.length,sha256:'f'.repeat(64)})).status,409);assert.equal(f.objects.size,1);
 const del=f.env.ELF_ARTIFACTS.delete;f.env.ELF_ARTIFACTS.delete=async()=>{throw Error('模拟R2暂不可用');};
 const result=await (await send({size:bytes.length,sha256:hash})).json();assert.equal(result.cleanup_pending,true);assert.equal(f.data.get('file-return/lab/saved').state,'delivered');assert.equal(f.objects.size,1);
 f.env.ELF_ARTIFACTS.delete=del;await cleanupReturns(f.env,f.env.ELF_DO.get('main'));assert.equal(f.objects.size,0);assert.equal(f.data.get('file-return/lab/saved').purged,true);
 assert.equal((await send({size:bytes.length,sha256:hash})).status,200);
 assert.equal((await worker.fetch(request('/api/elfremote/file-return?device_id=lab&task_id=saved','GET',undefined,c),f.env)).status,404);
});
test('管理员清理旧取回暂存不能越过仍在执行的任务',async()=>{
 const f=setup(),c=await login(f),p='/api/elfremote/file-return?device_id=lab&task_id=staged',object='device-files/return/lab/staged/0-fixture';
 f.data.set('file-return/lab/staged',{device_id:'lab',task_id:'staged',state:'ready',expires_at:Date.now()+86400000,parts:{}});f.objects.set(object,Buffer.from('fixture'));
 f.data.get('remote_devices')[0].task={id:'staged',type:'get_file',state:'running'};
 assert.equal((await worker.fetch(request(p,'DELETE',undefined,c),f.env)).status,409);assert.equal(f.objects.size,1);
 f.data.get('remote_devices')[0].task.state='success';assert.equal((await worker.fetch(request(p,'DELETE'),f.env)).status,401);
 assert.equal((await worker.fetch(request(p,'DELETE',undefined,c),f.env)).status,200);assert.equal(f.objects.size,0);assert.equal(f.data.get('file-return/lab/staged').state,'discarded');
});
