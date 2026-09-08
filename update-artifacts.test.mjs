import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {saveReleaseApk} from './update-artifacts.js';
import worker from './worker.js';
import {fixture,request,login} from './test-support.mjs';

test('更新制品校验后进入私有对象存储，下载不依赖状态中的Base64',async()=>{
  const bytes=Buffer.alloc(512*1024,7),sha256=createHash('sha256').update(bytes).digest('hex');
  const f=fixture(),objects=new Map();
  f.env.ELF_ARTIFACTS={async put(key,value){objects.set(key,value);},async get(key){return objects.has(key)?{body:objects.get(key)}:null;}};
  const manifest={size:bytes.length,sha256};
  const key=await saveReleaseApk(f.env,manifest,bytes.toString('base64'));
  f.data.set('elfremote_job_fixture-job',100);
  f.data.set('elfremote_rel_100',{apk_key:key,...manifest});
  const response=await worker.fetch(request('/api/elfremote/apk/fixture-job'),f.env);
  assert.equal(response.status,200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
  await assert.rejects(saveReleaseApk(f.env,{...manifest,size:1},bytes.toString('base64')));
  await assert.rejects(saveReleaseApk(f.env,{...manifest,sha256:'0'.repeat(64)},bytes.toString('base64')));
  assert.equal(objects.size,1);
});

test('旧制品仍可下载，新制品缺失不返回空APK',async()=>{
  const f=fixture();
  f.data.set('elfremote_job_fixture-job',100);
  f.data.set('elfremote_rel_100',{apk_b64:Buffer.from('fixture').toString('base64')});
  assert.equal(await (await worker.fetch(request('/api/elfremote/apk/fixture-job'),f.env)).text(),'fixture');
  f.data.set('elfremote_rel_100',{apk_key:'apks/fixture'});
  assert.equal((await worker.fetch(request('/api/elfremote/apk/fixture-job'),f.env)).status,503);
});

test('更新分配校验设备能力与签名清单目标，重复分配不重置状态',async()=>{
  const f=fixture({admin_pass:'fixture-password',remote_devices:[{id:'device',status_only:true,enabled:true}]});
  const cookie=await login(f);
  const rel={job_id:'update-one',manifest_raw:JSON.stringify({device_id:'device'}),expires_at:Date.now()+60000,versionCode:100,versionName:'fixture'};
  f.data.set('elfremote_rel_100',rel);
  const assign=()=>worker.fetch(request('/api/elfremote/assign','POST',{device_id:'device',versionCode:100},cookie),f.env);
  assert.equal((await assign()).status,400);
  let devices=f.data.get('remote_devices');devices[0].managed_update=true;f.data.set('remote_devices',devices);
  f.data.set('elfremote_rel_100',{...rel,manifest_raw:JSON.stringify({device_id:'another-device'})});
  assert.equal((await assign()).status,400);
  f.data.set('elfremote_rel_100',rel);assert.equal((await assign()).status,200);
  devices=f.data.get('remote_devices');assert.equal(devices[0].update.managed_update_v1,true);
  devices[0].update.state='success';f.data.set('remote_devices',devices);
  assert.equal((await assign()).status,200);
  assert.equal(f.data.get('remote_devices')[0].update.state,'success');
});

test('覆盖安装复用签名更新及回滚流程，不新建旧修复安装任务',async()=>{
  const f=fixture({admin_pass:'fixture-password',remote_devices:[{id:'device',status_only:true,enabled:true,managed_update:true}]});
  const cookie=await login(f);
  const rel={job_id:'install-one',manifest_raw:JSON.stringify({device_id:'device'}),expires_at:Date.now()+60000,versionCode:101,versionName:'fixture'};
  f.data.set('elfremote_rel_101',rel);
  const response=await worker.fetch(request('/api/elfremote/task','POST',{device_id:'device',type:'install_apk',versionCode:101},cookie),f.env);
  assert.equal(response.status,200);
  assert.equal((await response.json()).kind,'update');
  const device=f.data.get('remote_devices')[0];
  assert.equal(device.update.job_id,'install-one');
  assert.equal(device.update.managed_update_v1,true);
  assert.equal(device.task,undefined);
});

test('能力上报留下的空更新记录不阻止首次下发，真实进行中任务仍受保护',async()=>{
  const f=fixture({admin_pass:'fixture-password',remote_devices:[{id:'device',status_only:true,enabled:true,managed_update:true,update:{state:'',managed_update_v1:true}}]});
  const cookie=await login(f);
  const rel={job_id:'first-install',manifest_raw:'{}',expires_at:0,versionCode:102,versionName:'fixture'};
  f.data.set('elfremote_rel_102',rel);
  const assign=versionCode=>worker.fetch(request('/api/elfremote/assign','POST',{device_id:'device',versionCode},cookie),f.env);
  assert.equal((await assign(102)).status,200);
  assert.equal(f.data.get('remote_devices')[0].update.job_id,'first-install');
  f.data.set('elfremote_rel_103',{...rel,job_id:'second-install',versionCode:103});
  assert.equal((await assign(103)).status,400);
  assert.equal(f.data.get('remote_devices')[0].update.job_id,'first-install');
});


test('新客户端安装尝试独立于发布版本，重试幂等且过期清单明确拒绝',async()=>{
  const f=fixture({admin_pass:'fixture-password',remote_devices:[{id:'device',status_only:true,enabled:true,managed_update:true,managed_update_v2:true}]});
  const cookie=await login(f);
  const rel={job_id:'release-fixed',manifest_raw:'{}',expires_at:0,versionCode:200,versionName:'fixture'};
  f.data.set('elfremote_rel_200',rel);
  const assign=key=>worker.fetch(request('/api/elfremote/assign','POST',{device_id:'device',versionCode:200,request_id:key},cookie),f.env);
  const first=await (await assign('request-first')).json();
  assert.match(first.update.job_id,/^update-/);
  const same=await (await assign('request-first')).json();assert.equal(same.update.job_id,first.update.job_id);
  const devices=f.data.get('remote_devices');devices[0].update.state='rejected';f.data.set('remote_devices',devices);
  const next=await (await assign('request-second')).json();assert.notEqual(next.update.job_id,first.update.job_id);
  assert.equal(next.update.state,'pending');
  f.data.set('elfremote_rel_200',{...rel,expires_at:Date.now()-1});
  assert.equal((await assign('request-third')).status,400);
});

test('一次任务提交即通知且发布发生在任务保存之后',async()=>{
  const f=fixture({admin_pass:'fixture-password',remote_devices:[{id:'device',status_only:true,enabled:true,managed_log_tasks:true}]});
  const cookie=await login(f);let calls=0;
  f.env.MQTT_API_URL='https://mqtt.example.test';f.env.MQTT_API_TOKEN='fixture';
  f.env.MQTT_FETCH=async(url,options)=>{
    calls++;assert.equal(f.data.get('remote_devices')[0].task.type,'pull_logs');
    const value=JSON.parse(options.body);return Response.json({ok:true,accepted:true,request_id:value.notification.request_id});
  };
  const result=await (await worker.fetch(request('/api/elfremote/task','POST',{device_id:'device',type:'pull_logs'},cookie),f.env)).json();
  assert.equal(calls,1);assert.equal(result.notification.published,true);
});
