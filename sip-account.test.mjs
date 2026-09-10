import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import worker from './worker.js';
import {fixture,request,login} from './test-support.mjs';
import {sipAccountParams,queueSipRestore,applyRepairProgress} from './elfRemote/control-plane.js';
const params={server:'sip.example.invalid',username:'test',password:'synthetic=!@',transport:'tls'};

test('SIP参数不允许配置注入，默认TLS且不吞掉特殊密码',()=>{
  assert.equal(sipAccountParams(params).port,5061);assert.equal(sipAccountParams(params).password,params.password);
  for(const bad of [{password:'a\n[sip]'},{password:' spaced '},{server:'sip.invalid;transport=udp'},{port:0},{username:'test\rnew'},{transport:'auto'}])assert.throws(()=>sipAccountParams({...params,...bad}));
});

test('账号任务校验能力及注册证据，秘密不进入管理列表和历史，失败保留旧配置',async()=>{
  const token='fixture-account-token',d={id:'test',status_only:true,enabled:true,token_sha256:createHash('sha256').update(token).digest('hex')};
  const f=fixture({admin_pass:'fixture-password',remote_devices:[d]}),cookie=await login(f);
  const call=(path,body,auth=cookie)=>worker.fetch(request(path,body?'POST':'GET',body,auth),f.env);
  const task={device_id:'test',id:'sip-test',type:'configure_sip',params};
  assert.equal((await call('/api/elfremote/task',task,null)).status,401);
  assert.equal((await call('/api/elfremote/task',task)).status,409);
  f.data.get('remote_devices')[0].managed_sip_account=true;
  const queued=await call('/api/elfremote/task',task);assert.equal(queued.status,200);assert.ok(!(await queued.text()).includes(params.password));
  const progress=(state,result)=>call('/api/elfremote/task-progress',{device_id:'test',token,task_id:'sip-test',state,result},null);
  await progress('claimed');await progress('running');
  assert.equal((await progress('success',{action:'completed',exit_code:0})).status,400);
  const evidence={action:'completed',exit_code:0,registered:true,text:'Linphone已注册'};
  assert.equal((await progress('success',evidence)).status,200);
  assert.equal((await progress('success',evidence)).status,200);
  const saved=f.data.get('remote_devices')[0];
  assert.equal(saved.account_configs.linphone.params.password,params.password);assert.deepEqual(saved.task.params,{});
  assert.ok(!(await (await call('/api/devices')).text()).includes(params.password));
  assert.ok(!(await (await call('/api/elfremote/tasks?device_id=test')).text()).includes(params.password));
  assert.equal((await (await call('/api/elfremote/task',task)).json()).duplicate,true);
  const old=structuredClone(saved.account_configs.linphone);
  await call('/api/elfremote/task',{...task,id:'sip-failed',params:{...params,password:'synthetic-bad'}});
  const current=f.data.get('remote_devices')[0];applyRepairProgress(current,'sip-failed','failed','失败',{},Date.now());
  assert.deepEqual(current.account_configs.linphone,old);assert.deepEqual(current.task.params,{});
});

test('新安装恢复已验证配置并等待重试窗口，任务占用时延后且不自行覆盖管理员新任务',async()=>{
  const f=fixture(),d={id:'test',enabled:true,managed_sip_account:true,token_sha256:'new',account_configs:{linphone:{params,applied_token_sha:'old'}}};
  d.task={id:'busy',state:'running'};
  assert.equal(await queueSipRestore(d,f.storage,Date.now()),false);
  d.task=null;assert.equal(await queueSipRestore(d,f.storage,Date.now()),true);
  const id=d.task.id;assert.equal(d.task.type,'configure_sip');assert.equal(d.task.managed_exec_v1,true);
  assert.equal(await queueSipRestore(d,f.storage,Date.now()),false);assert.equal(d.task.id,id);
  d.task.state='failed';assert.equal(await queueSipRestore(d,f.storage,Date.now()),false);
  d.token_sha256='newer';assert.equal(await queueSipRestore(d,f.storage,Date.now()),true);
});


test('账号临时失败自动重试最多三次，明确密码错误停止；不重复成功安装',async()=>{
 const f=fixture(),d={id:'retry',managed_sip_account:true,token_sha256:'new',account_configs:{linphone:{params,applied_token_sha:'old'}}};
 assert.equal(await queueSipRestore(d,f.storage,1000),true);d.task.state='failed';
 assert.equal(await queueSipRestore(d,f.storage,299999),false);
 assert.equal(await queueSipRestore(d,f.storage,301000),true);d.task.state='failed';
 assert.equal(await queueSipRestore(d,f.storage,2101000),true);d.task.state='failed';
 assert.equal(await queueSipRestore(d,f.storage,100000000),false);
 d.token_sha256='next';assert.equal(await queueSipRestore(d,f.storage,100000001),true);d.task.state='failed';d.task.result={text:'invalid password'};
 assert.equal(await queueSipRestore(d,f.storage,110000001),false);assert.equal(d.account_configs.linphone.restore.blocked,'账号或密码错误');
});
