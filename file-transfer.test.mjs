import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import worker from './worker.js';
import {fixture,request,login} from './test-support.mjs';
import {fileParams,FILE_MAX,FILE_CHUNK,cleanupFiles} from './file-transfer.js';
const sha=v=>createHash('sha256').update(v).digest('hex');

test('文件传输保留64位长度并拒绝无效目标',()=>{
  assert.ok(FILE_MAX>0x7fffffff);
  assert.equal(Math.ceil(FILE_MAX/FILE_CHUNK),512);
  assert.equal(fileParams({transfer_id:'a'.repeat(32),path:'/sdcard/文件'}).allow_cellular,true);
  for(const path of ['relative','/a/../b','/a/','/a\0b'])assert.throws(()=>fileParams({transfer_id:'a'.repeat(32),path}));
});
test('清理未使用发送暂存需管理员且不能删除在途分块',async()=>{
 const f=fixture(),id='a'.repeat(32),key='device-files/'+id+'/0-fixture',objects=new Set([key]);
 f.data.set('file-transfer/'+id,{id,state:'ready',expires_at:Date.now()+86400000,parts:{}});f.data.set('remote_devices',[{task:{type:'send_file',state:'running',params:{transfer_id:id}}}]);
 f.env.ELF_ARTIFACTS={async list(){return {objects:[...objects].map(key=>({key})),truncated:false};},async delete(keys){keys.forEach(k=>objects.delete(k));}};
 const cookie=await login(f),url='/api/elfremote/files/'+id;
 assert.equal((await worker.fetch(request(url,'DELETE'),f.env)).status,401);
 assert.equal((await worker.fetch(request(url,'DELETE',undefined,cookie),f.env)).status,409);assert.equal(objects.size,1);
 f.data.get('remote_devices')[0].task.state='failed';assert.equal((await worker.fetch(request(url,'DELETE',undefined,cookie),f.env)).status,200);assert.equal(objects.size,0);assert.equal(f.data.has('file-transfer/'+id),false);
});

test('私有分块、重试、封存、任务绑定、Range和取消闭环',async()=>{
  const token='file-test-token',f=fixture({admin_pass:'fixture-password',remote_devices:[{id:'test',status_only:true,enabled:true,managed_file_tasks:true,token_sha256:sha(token)}]});
  const objects=new Map();let binaryInsideTransaction=false;
  f.env.ELF_ARTIFACTS={
    async put(k,stream,opts){const b=Buffer.from(await new Response(stream).arrayBuffer());assert.equal(sha(b),opts.sha256);objects.set(k,b);},
    async get(k,opts){const b=objects.get(k);return b?{body:opts?.range?b.subarray(opts.range.offset):b}:null;},
    async list({prefix}){return {objects:[...objects.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key})),truncated:false};},
    async delete(keys){keys.forEach(k=>objects.delete(k));}
  };
  const cookie=await login(f),call=(p,b,auth=cookie)=>worker.fetch(request(p,b?'POST':'GET',b,auth),f.env);
  const content=Buffer.from('file-transfer-fixture');
  assert.equal((await call('/api/elfremote/files',{device_id:'test',name:'test.txt',size:content.length},null)).status,401);
  const init=await (await call('/api/elfremote/files',{device_id:'test',name:'test.txt',size:content.length})).json();assert.equal(init.ok,true);const id=init.file.id;
  assert.equal((await call('/api/elfremote/files/'+id+'/complete',{sha256:sha(content)})).status,400);
  const upload=()=>worker.fetch(new Request('https://example.test/api/elfremote/files/'+id+'/parts/0?sha256='+sha(content),{method:'PUT',headers:{Cookie:cookie,'Content-Length':String(content.length)},body:content}),f.env);
  assert.equal((await upload()).status,200);assert.equal((await upload()).status,200);assert.equal(objects.size,1);
  assert.equal((await call('/api/elfremote/files/'+id+'/complete',{sha256:sha(content)})).status,200);
  assert.equal((await call('/api/elfremote/files/'+id+'/complete',{sha256:'0'.repeat(64)})).status,409);
  const job={id:'test-file',device_id:'test',type:'send_file',params:{transfer_id:id,path:'/sdcard/test.txt'}};
  assert.equal((await call('/api/elfremote/task',job)).status,200);
  const path='/api/elfremote/file-download?'+new URLSearchParams({id,device_id:'test',task_id:job.id});
  const download=(suffix='',headers={})=>worker.fetch(request(path+suffix,'GET',undefined,null,headers),f.env);
  assert.equal((await download()).status,401);
  assert.equal((await download('',{Authorization:'Bearer '+token})).status,200);
  const range=await download('&part=0',{Authorization:'Bearer '+token,Range:'bytes=5-'});
  assert.equal(range.status,206);assert.equal(await range.text(),content.subarray(5).toString());
  assert.equal((await download('&part=0',{Authorization:'Bearer '+token,Range:'bytes=999-'})).status,416);
  await call('/api/elfremote/task',{device_id:'test',task_id:job.id,action:'cancel'});
  assert.equal((await download('&part=0',{Authorization:'Bearer '+token})).status,409);
  const progress=(state,result)=>call('/api/elfremote/task-progress',{device_id:'test',task_id:job.id,token,state,result},null);
  await progress('claimed');await progress('running');
  assert.equal((await progress('success',{action:'committed',bytes:content.length,sha256:'0'.repeat(64)})).status,400);
  assert.equal((await progress('success',{action:'committed',bytes:content.length,sha256:sha(content)})).status,200);
  assert.equal(objects.size,0);assert.equal(f.data.get('file-transfer/'+id).purged,true);
  const m=f.data.get('file-transfer/'+id);m.expires_at=1;
  await cleanupFiles(f.env,f.env.ELF_DO.get('main'));
  assert.equal(objects.size,0);assert.equal(f.data.has('file-transfer/'+id),false);
});

test('慢分块上传不占用设备存储锁',async()=>{
  const f=fixture({admin_pass:'fixture-password',remote_devices:[{id:'test',enabled:true,managed_file_tasks:true}]});
  let release,started;const waiting=new Promise(r=>release=r),begun=new Promise(r=>started=r);
  f.env.ELF_ARTIFACTS={async put(){started();await waiting;}};
  const cookie=await login(f),m=await (await worker.fetch(request('/api/elfremote/files','POST',{device_id:'test',name:'x',size:1},cookie),f.env)).json();
  const upload=worker.fetch(new Request('https://example.test/api/elfremote/files/'+m.file.id+'/parts/0?sha256='+sha('x'),{method:'PUT',headers:{Cookie:cookie,'Content-Length':'1'},body:'x'}),f.env);
  try{await begun;const control=await worker.fetch(request('/api/devices','GET',undefined,cookie),f.env);assert.equal(control.status,200);}finally{release();await upload;}
});
