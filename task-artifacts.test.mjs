import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import worker from './worker.js';
import {fixture,login,request} from './test-support.mjs';

test('生产显式部署配置绑定私有日志桶',()=>{
  const config=JSON.parse(readFileSync(new URL('./wrangler.jsonc',import.meta.url),'utf8'));
  assert.deepEqual(config.r2_buckets,[{binding:'ELF_ARTIFACTS',bucket_name:'elfremote-private'}]);
  assert.match(readFileSync(new URL('./.github/workflows/deploy.yml',import.meta.url),'utf8'),/command: deploy --config wrangler\.jsonc/);
});

function setup(){
  const f=fixture({admin_pass:'fixture-password',remote_devices:[{id:'device',enabled:true,token_sha256:createHash('sha256').update('fixture-token').digest('hex'),
    task:{id:'log-task',type:'pull_logs',state:'running',expires_at:Date.now()+60000}}]});
  const objects=new Map();let writes=0;
  f.env.ELF_ARTIFACTS={async put(key,bytes){writes++;objects.set(key,bytes);},async get(key){return objects.has(key)?{body:objects.get(key)}:null;}};
  const text='complete-fixture-log\n'.repeat(400);
  f.body={device_id:'device',token:'fixture-token',task_id:'log-task',state:'success',result:{log_text:text,bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex'),text:'summary'}};
  f.writes=()=>writes;
  return f;
}

test('完整日志保存、校验、重试去重和历史下载都受正确认证约束',async()=>{
  const f=setup(),cookie=await login(f);
  const send=body=>worker.fetch(request('/api/elfremote/task-progress','POST',body),f.env);
  assert.equal((await send({...f.body,token:'bad'})).status,401);
  assert.equal(f.writes(),0);
  const reply=await send(f.body);assert.equal(reply.status,200);
  const data=await reply.json();assert.equal(data.task.result.artifact.bytes,f.body.result.bytes);
  assert.equal(JSON.stringify(data).includes('complete-fixture-log'),false);
  assert.equal((await send(f.body)).status,200);assert.equal(f.writes(),1);
  const path='/api/elfremote/task-log?device_id=device&task_id=log-task';
  assert.equal((await worker.fetch(request(path),f.env)).status,401);
  const download=await worker.fetch(request(path,'GET',undefined,cookie),f.env);
  assert.equal(await download.text(),f.body.result.log_text);
  assert.equal(download.headers.get('X-Content-SHA256'),f.body.result.sha256);
  const devices=f.data.get('remote_devices');devices[0].task={id:'next'};f.data.set('remote_devices',devices);
  assert.equal((await worker.fetch(request(path,'GET',undefined,cookie),f.env)).status,200);
});

test('坏校验和存储失败不提交成功状态',async()=>{
  const f=setup();
  const send=body=>worker.fetch(request('/api/elfremote/task-progress','POST',body),f.env);
  assert.equal((await send({...f.body,result:{...f.body.result,bytes:1}})).status,400);
  assert.equal(f.writes(),0);
  f.env.ELF_ARTIFACTS.put=async()=>{throw Error('private fixture failure');};
  const response=await send(f.body);assert.equal(response.status,503);
  assert.equal((await response.text()).includes('private fixture'),false);
  assert.equal(f.data.get('remote_devices')[0].task.state,'running');
});

test('缺少设备凭证记录时不能上传日志',async()=>{
  const f=setup();
  const devices=f.data.get('remote_devices');delete devices[0].token_sha256;f.data.set('remote_devices',devices);
  assert.equal((await worker.fetch(request('/api/elfremote/task-progress','POST',f.body),f.env)).status,401);
  assert.equal(f.writes(),0);
});

test('状态模式仅向声明能力的客户端提供新建日志任务',async()=>{
  const f=setup(),cookie=await login(f);
  let sequence=0;
  const report=async capable => (await worker.fetch(request('/api/devices/report','POST',{
    device_id:'device',token:'fixture-token',status_only:true,managed_log_tasks:capable,
    report_id:'fixture-report-'+(++sequence),sampled_at:new Date(Date.now()+sequence*1000).toISOString()
  }),f.env)).json();
  const enqueue=type=>worker.fetch(request('/api/elfremote/task','POST',{device_id:'device',type},cookie),f.env);
  assert.equal((await report(true)).managed_task,undefined);
  const devices=f.data.get('remote_devices');devices[0].task.state='success';f.data.set('remote_devices',devices);
  assert.equal((await enqueue('reboot')).status,409);
  assert.equal((await enqueue('pull_logs')).status,200);
  const offered=await report(true);
  assert.equal(offered.managed_task.type,'pull_logs');
  assert.equal(offered.managed_task.managed_log_v1,true);
  assert.equal(offered.task,undefined);assert.equal(offered.update,undefined);
  const repeated=await (await worker.fetch(request('/api/devices/report','POST',{
    device_id:'device',token:'fixture-token',status_only:true,managed_log_tasks:true,report_id:'fixture-report-'+sequence
  }),f.env)).json();
  assert.equal(repeated.duplicate,true);
  assert.equal(repeated.managed_task.id,offered.managed_task.id);
  assert.equal((await report(false)).managed_task,undefined);
  assert.equal((await enqueue('pull_logs')).status,409);
});

test('新自愈能力不影响旧客户端且停用设备不能领取',async()=>{
  const f=setup(),cookie=await login(f);
  const devices=f.data.get('remote_devices');devices[0].status_only=true;devices[0].task.state='success';f.data.set('remote_devices',devices);
  const enqueue=()=>worker.fetch(request('/api/elfremote/task','POST',{device_id:'device',type:'heal_network'},cookie),f.env);
  assert.equal((await enqueue()).status,409);
  let sequence=0;
  const report=async capable => (await worker.fetch(request('/api/devices/report','POST',{
    device_id:'device',token:'fixture-token',status_only:true,managed_heal_tasks:capable,
    report_id:'heal-report-'+(++sequence),sampled_at:new Date(Date.now()+sequence*1000).toISOString()
  }),f.env)).json();
  await report(true);
  assert.equal((await enqueue()).status,200);
  assert.equal((await report(false)).managed_task,undefined);
  assert.equal((await report(true)).managed_task.managed_heal_v1,true);
  const disabled=f.data.get('remote_devices');disabled[0].enabled=false;f.data.set('remote_devices',disabled);
  assert.equal((await report(true)).managed_task,undefined);
});

for (const [type, capability, marker] of [['reboot','managed_reboot_tasks','managed_reboot_v1'],['restart_adbd','managed_adbd_tasks','managed_adbd_v1']]) {
test(type+' 只提供给明确声明能力的客户端且过期后不再提供',async()=>{
  const f=setup(),cookie=await login(f);
  const devices=f.data.get('remote_devices');devices[0].status_only=true;devices[0].task.state='success';f.data.set('remote_devices',devices);
  const enqueue=()=>worker.fetch(request('/api/elfremote/task','POST',{device_id:'device',type},cookie),f.env);
  assert.equal((await enqueue()).status,409);
  let sequence=0;
  const report=async capable => (await worker.fetch(request('/api/devices/report','POST',{
    device_id:'device',token:'fixture-token',status_only:true,[capability]:capable,
    report_id:'reboot-report-'+(++sequence),sampled_at:new Date(Date.now()+sequence*1000).toISOString()
  }),f.env)).json();
  await report(true); assert.equal((await enqueue()).status,200);
  assert.equal((await report(false)).managed_task,undefined);
  assert.equal((await report(true)).managed_task[marker],true);
  const expired=f.data.get('remote_devices');expired[0].task.expires_at=1;f.data.set('remote_devices',expired);
  assert.equal((await report(true)).managed_task,undefined);
  assert.equal(f.data.get('remote_devices')[0].task.state,'expired');
});
}
