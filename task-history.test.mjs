import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import worker from './worker.js';
import {fixture,request,login} from './test-support.mjs';

test('任务A完成、任务B进行中时重试A只返回旧结果，同号不同参数拒绝',async()=>{
  const token='fixture-task-token';
  const f=fixture({admin_pass:'fixture-password',remote_devices:[{id:'test',token_sha256:createHash('sha256').update(token).digest('hex')}]});
  const cookie=await login(f);
  const call=async(path,body,auth=cookie)=>worker.fetch(request(path,body?'POST':'GET',body,auth),f.env);
  const enqueue=body=>call('/api/elfremote/task',{device_id:'test',...body});
  const progress=(id,state)=>call('/api/elfremote/task-progress',{device_id:'test',token,task_id:id,state},undefined);
  const a={id:'a',idempotency_key:'key-a',type:'connect_wifi',params:{ssid:'fixture',password:'fixture-password'}};
  assert.equal((await enqueue(a)).status,200);
  await progress('a','claimed');await progress('a','running');await progress('a','success');
  const completed=f.data.get('remote_devices')[0].task.completed_at;
  assert.ok(completed);
  assert.deepEqual(f.data.get('remote_devices')[0].task.params,{});
  assert.equal((await enqueue({id:'b',type:'pull_logs'})).status,200);
  const replay=await (await enqueue({...a,params:{password:'fixture-password',ssid:'fixture'}})).json();
  assert.equal(replay.duplicate,true);assert.equal(replay.task.id,'a');assert.equal(replay.task.state,'success');
  assert.equal(f.data.get('remote_devices')[0].task.id,'b');
  const conflict=await (await enqueue({...a,params:{ssid:'changed',password:'fixture-password'}})).json();
  assert.equal(conflict.reason,'idempotency-conflict');
  await progress('a','running');
  assert.equal(f.data.get('remote_devices')[0].task.state,'pending');
  const historic=await (await call('/api/elfremote/tasks?device_id=test&task_id=a')).json();
  assert.equal(historic.task.completed_at,completed);
  assert.equal((await progress('missing','running')).status,404);
  const history=[...f.data].filter(([k])=>k.startsWith('repair-history/'));
  assert.equal(JSON.stringify(history).includes('fixture-password'),false);
  assert.equal((await call('/api/elfremote/tasks?device_id=test',undefined,null)).status,401);
});

test('无显式编号的同时任务使用不同编号，历史数量有界',async()=>{
  const {enqueueRepairTask,applyRepairProgress,repairHistory}=await import('./elfRemote/control-plane.js');
  const f=fixture(),d={id:'test'};
  const one=await enqueueRepairTask(d,{type:'pull_logs'},1000,f.storage);
  applyRepairProgress(d,one.task.id,'failed','fixture');
  const two=await enqueueRepairTask(d,{type:'pull_logs'},1000,f.storage);
  assert.notEqual(one.task.id,two.task.id);
  applyRepairProgress(d,two.task.id,'failed','fixture');
  for(let i=0;i<140;i++){
    const q=await enqueueRepairTask(d,{id:'task-'+i,type:'pull_logs'},1000+i,f.storage);
    assert.equal(q.ok,true);
    applyRepairProgress(d,q.task.id,'failed','fixture');
  }
  assert.equal((await repairHistory(f.storage,d.id)).length,127);
  assert.equal(d.task.id,'task-139');
});
