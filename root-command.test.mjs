import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import worker from './worker.js';
import {fixture,request,login} from './test-support.mjs';
import {commandParams,repairOfferPayload} from './elfRemote/control-plane.js';

test('命令参数保留原文并校验工作目录、字节长度和超时',()=>{
  assert.deepEqual(commandParams({command:"printf '%s' '$HOME'"}),{command:"printf '%s' '$HOME'",cwd:'/',timeout:30});
  for(const input of [{command:''},{command:'a\0b'},{command:'中'.repeat(2400)},{command:'id',cwd:'relative'},{command:'id',timeout:121}])
    assert.throws(()=>commandParams(input));
});

test('真实能力、管理员鉴权、取消与命令结果历史保持一致',async()=>{
  const token='fixture-command-token';
  const f=fixture({admin_pass:'fixture-password',remote_devices:[{id:'test',status_only:true,enabled:true,managed_exec_tasks:false,token_sha256:createHash('sha256').update(token).digest('hex')}]});
  const cookie=await login(f);
  const call=(path,body,auth=cookie)=>worker.fetch(request(path,body?'POST':'GET',body,auth),f.env);
  const job={device_id:'test',type:'root_exec',id:'command-a',params:{command:'printf fixture; exit 7'}};
  assert.equal((await call('/api/elfremote/task',job,null)).status,401);
  assert.equal((await call('/api/elfremote/task',job)).status,409);
  f.data.get('remote_devices')[0].managed_exec_tasks=true;
  assert.equal((await call('/api/elfremote/task',job)).status,200);
  assert.equal(f.data.get('remote_devices')[0].task.managed_exec_v1,true);
  assert.equal((await call('/api/elfremote/task',{device_id:'test',action:'cancel',task_id:'other'})).status,404);
  assert.equal((await call('/api/elfremote/task',{device_id:'test',action:'cancel',task_id:'command-a'})).status,200);
  assert.equal(repairOfferPayload(f.data.get('remote_devices')[0].task).cancel_requested,true);
  const progress=(state,result)=>call('/api/elfremote/task-progress',{device_id:'test',token,task_id:'command-a',state,result},null);
  await progress('claimed');await progress('running');
  assert.equal((await progress('success',{exit_code:7,action:'completed'})).status,400);
  const text='fixture\n'.repeat(1000);
  assert.equal((await progress('failed',{exit_code:7,elapsed_ms:125,text,action:'completed',stage:'command'})).status,200);
  await call('/api/elfremote/task',{...job,id:'command-b'});
  const historic=await (await call('/api/elfremote/tasks?device_id=test&task_id=command-a')).json();
  assert.equal(historic.task.result.text,text);
  assert.equal(historic.task.result.exit_code,7);
  assert.equal(historic.task.result.elapsed_ms,125);
});
