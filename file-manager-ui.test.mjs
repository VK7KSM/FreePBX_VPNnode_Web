import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {createHash,webcrypto} from 'node:crypto';

function browser(){
  const c=vm.createContext({Date,Intl,URLSearchParams,Uint8Array,AbortController,crypto:webcrypto,adminSession:{check(){}},setTimeout(){},setInterval(){},window:{},document:{getElementById(){return null;}},localStorage:{getItem(){return null;},setItem(){},removeItem(){}},confirm:()=>true});
  vm.runInContext(fs.readFileSync('devices-client.js','utf8'),c);
  c.DEV=[{id:'xx',enabled:true,managed_file_operations:true,managed_file_delete:true,managed_file_return:true,managed_file_tasks:true}];c.selDev='xx';c.selFn='files';
  c.renderFileManager=()=>{};c.fileManagerHash=async()=>{const hash=createHash('sha256');return {update:x=>hash.update(x),digest:()=>hash.digest()};};
  return c;
}
const json=x=>JSON.parse(JSON.stringify(x));
function localDirectory(){
  const files=new Map(),dirs=new Map();
  return {files,dirs,async getDirectoryHandle(name,{create}={}){if(!dirs.has(name)){if(!create)throw Object.assign(Error('missing'),{name:'NotFoundError'});dirs.set(name,localDirectory());}return dirs.get(name);},async getFileHandle(name,{create}={}){
    if(!files.has(name)){if(!create)throw Object.assign(Error('missing'),{name:'NotFoundError'});files.set(name,{bytes:Buffer.alloc(0),closed:false,aborted:false});}
    const file=files.get(name);
    return {async createWritable(){const chunks=[];return {async write(bytes){chunks.push(Buffer.from(bytes));},async close(){file.bytes=Buffer.concat(chunks);file.closed=true;},async abort(){file.aborted=true;}};}};
  }};
}

test('多选、属性、分页和操作区保持设备隔离，删除不再显示回收站',()=>{
  const c=browser(),s=c.fileManagerState();s.entries=[{name:'照片.jpg',bytes:13400,mode:420,modified_ms:1789090000000},{name:'目录',directory:true}];s.total=17;s.loaded=true;s.next=12;
  c.fileManagerSelect(0,true);c.fileManagerSelect(1,true);assert.equal(c.fileManagerSelected(s).length,2);
  const html=c.fileManagerHtml(s);
  assert.match(html,/第 1 页 \/ 共 2 页/);assert.match(html,/修改时间/);assert.match(html,/rw-r--r-- \(644\)/);assert.match(html,/13.4 KB/);
  assert.doesNotMatch(html,/移至回收站|fileManagerTarget|type="radio"/);
  assert.equal(c.fileManagerPermissions({}), '—');assert.equal(c.fileManagerPermissions({mode:2541}),'rwsr-xr-x (4755)');
  const toolbar=html.slice(0,html.indexOf('file-manager-path'));assert.match(toolbar,/发送文件.*取回文件.*新建文件夹.*复制.*移动.*改名.*删除/);
  c.DEV.push({id:'d31'});c.selDev='d31';assert.equal(c.fileManagerState().selected.length,0);assert.equal(s.selected.length,2);
});

test('发送多文件直接采用当前目录，串行等待设备保存；跳过同名不上传',async()=>{
  const c=browser(),s=c.fileManagerState(),uploaded=[],ended=[];s.path='/sdcard/目标';
  c.fileManagerAll=async()=>[{name:'同名.txt'}];c.fileManagerConflict=async()=> 'skip';
  c.fileManagerUpload=async(_s,file,path,overwrite,progress)=>{uploaded.push({path,overwrite});progress(file.size);progress(file.size*2);};
  c.fileManagerEnd=async(_s,message,error)=>ended.push({message,error});
  await c.fileManagerSendBatch(s,[{name:'一.txt',size:1},{name:'同名.txt',size:2},{name:'二.txt',size:3}],s.path);
  assert.deepEqual(uploaded.map(x=>x.path),['/sdcard/目标/一.txt','/sdcard/目标/二.txt']);assert.equal(ended[0].message,'发送完成 · 已跳过 1 项');assert.equal(ended[0].error,undefined);
});

test('发送实际计算分块与整件校验，并等待设备确认后才结束',async()=>{
  const c=browser(),s=c.fileManagerState(),bytes=Buffer.from('电脑选择的文件'),expected=createHash('sha256').update(bytes).digest('hex'),calls=[];
  c.fileApi=async(path,body)=>{calls.push({path,body:json(body)});if(path==='/api/elfremote/files')return {file:{id:'a'.repeat(32),chunk_size:8388608,parts:{}}};if(path==='/api/elfremote/task')return {task:{id:body.id}};return {ok:true};};
  c.fetch=async(path,options)=>{assert.match(path,new RegExp('sha256='+expected));assert.deepEqual(Buffer.from(options.body),bytes);return {ok:true,json:async()=>({ok:true})};};
  let confirmed=false;c.fileManagerWait=async(_s,id)=>{assert.match(id,/^file-/);confirmed=true;};
  const file={name:'资料.txt',size:bytes.length,lastModified:1,slice(start,end){const part=bytes.subarray(start,end);return {async arrayBuffer(){return Uint8Array.from(part).buffer;}};}};
  await c.fileManagerUpload(s,file,'/sdcard/Download/资料.txt',false,()=>{});
  assert.equal(confirmed,true);assert.equal(calls.find(x=>x.path.endsWith('/complete')).body.sha256,expected);
  const task=calls.find(x=>x.path==='/api/elfremote/task').body;assert.equal(task.params.path,'/sdcard/Download/资料.txt');assert.equal(task.params.allow_cellular,true);
});

test('取回先选本机目录，再枚举并保存远程目录结构及空文件夹，不要求再次下载',async()=>{
  const c=browser(),s=c.fileManagerState(),local=localDirectory(),events=[];s.path='/sdcard/Download';s.entries=[{name:'资料',directory:true},{name:'readme.txt',bytes:2}];s.selected=['资料','readme.txt'];
  c.window.showDirectoryPicker=async()=>{events.push('picker');return local;};
  c.fileManagerRead=async(_s,path)=>{events.push(path);return {entries:path.endsWith('/资料')?[{name:'子文件.txt',bytes:3},{name:'空目录',directory:true}]:[],next:-1};};
  const collected=[];c.fileManagerDownload=async(_s,item,root)=>{collected.push(json(item));assert.equal(root,local);return true;};
  let result;c.fileManagerEnd=async(_s,message,error)=>result={message,error};
  await c.fileManagerTake();
  assert.equal(events[0],'picker');assert.deepEqual(collected.map(x=>x.parts),[['资料','子文件.txt'],['readme.txt']]);assert.ok(local.dirs.get('资料').dirs.has('空目录'));assert.equal(result.message,'取回完成');assert.equal(result.error,undefined);
});

test('取消本机目录选择不产生任何设备任务',async()=>{
  const c=browser(),s=c.fileManagerState();s.entries=[{name:'a'}];s.selected=['a'];let calls=0;
  c.window.showDirectoryPicker=async()=>{throw Object.assign(Error('cancel'),{name:'AbortError'});};c.fileManagerTask=async()=>{calls++;};
  await c.fileManagerTake();assert.equal(calls,0);assert.equal(s.busy,false);assert.equal(s.message,'');
});

test('流式取回校验后关闭本机文件，校验失败不覆盖原文件',async()=>{
  const c=browser(),s=c.fileManagerState(),root=localDirectory(),payload=Buffer.from('真实文件内容'),hash=createHash('sha256').update(payload).digest('hex');let valid=true;
  c.fileApi=async(path,body)=>body?{task:{id:'return-fixture'}}:{file:{size:payload.length,sha256:valid?hash:'0'.repeat(64)}};
  c.fileManagerWait=async()=>({state:'success'});
  c.fetch=async()=>({ok:true,body:new ReadableStream({start(controller){controller.enqueue(payload.subarray(0,4));controller.enqueue(payload.subarray(4));controller.close();}})});
  const item={path:'/sdcard/file',parts:['file'],bytes:payload.length};
  assert.equal(await c.fileManagerDownload(s,item,root,()=>{}),true);assert.equal(root.files.get('file').closed,true);assert.deepEqual(root.files.get('file').bytes,payload);
  valid=false;c.fileManagerConflict=async()=> 'replace';
  await assert.rejects(c.fileManagerDownload(s,item,root,()=>{}),/校验失败/);assert.equal(root.files.get('file').aborted,true);assert.deepEqual(root.files.get('file').bytes,payload);
});

test('文件夹取回不跟随链接、不接受穿越本机目录的名称',async()=>{
  const c=browser(),s=c.fileManagerState();
  await assert.rejects(c.fileManagerCollect(s,'/sdcard',[{name:'link',directory:true,link:true}],[],[],[],new Set()),/符号链接/);
  for(const name of ['..','a/b','a\\b'])assert.throws(()=>c.fileManagerLocalName(name));
});

test('真正删除逐项执行并保留失败结果，不回退到隐藏改名',async()=>{
  const c=browser(),s=c.fileManagerState();s.path='/sdcard';s.entries=[{name:'一'},{name:'二'}];s.selected=['一','二'];const tasks=[];let result;
  c.fileManagerTask=async(_s,p)=>{tasks.push(json(p));if(p.path.endsWith('二'))throw Error('目录不可读取');return {};};c.fileManagerEnd=async(_s,message,error)=>result={message,error};
  await c.fileManagerAction('delete');assert.deepEqual(tasks.map(x=>x.action),['delete','delete']);assert.equal(result.error.message,'目录不可读取');assert.notEqual(result.message,'已删除');
});
