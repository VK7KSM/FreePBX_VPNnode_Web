import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import worker from './worker.js';
import {fixture,request,login} from './test-support.mjs';
import {fileOperationParams} from './elfRemote/control-plane.js';

test('文件操作路径保留字面值，拒绝相对目录和无效操作',()=>{
  assert.equal(fileOperationParams({action:'list',path:"/sdcard/引号'空 格"}).path,"/sdcard/引号'空 格");
  for(const input of [{action:'list',path:'relative'},{action:'list',path:'/a/../b'},{action:'copy',path:'/a',target:'/b\0c'},{action:'erase',path:'/a'},{action:'list',path:'/',offset:-1}])assert.throws(()=>fileOperationParams(input));
});

test('文件管理独立能力门、鉴权、回执与同号重试',async()=>{
  const token='fixture-file-operation-token';
  const f=fixture({admin_pass:'fixture-password',remote_devices:[{id:'test',status_only:true,enabled:true,managed_exec_tasks:true,token_sha256:createHash('sha256').update(token).digest('hex')}]});
  const cookie=await login(f),call=(path,body,auth=cookie)=>worker.fetch(request(path,body?'POST':'GET',body,auth),f.env);
  const task={device_id:'test',id:'manage-a',type:'file_manage',params:{action:'list',path:'/sdcard'}};
  assert.equal((await call('/api/elfremote/task',task,null)).status,401);
  assert.equal((await call('/api/elfremote/task',task)).status,409);
  f.data.get('remote_devices')[0].managed_file_operations=true;
  assert.equal((await call('/api/elfremote/task',task)).status,200);
  const progress=(state,result)=>call('/api/elfremote/task-progress',{device_id:'test',token,task_id:'manage-a',state,result},null);
  await progress('claimed');await progress('running');
  assert.equal((await progress('success',{exit_code:1,action:'completed'})).status,400);
  const text=JSON.stringify({entries:Array.from({length:12},(_,i)=>({name:'字'.repeat(90)+i}))});
  assert.equal((await progress('success',{exit_code:0,action:'completed',text})).status,200);
  const result=await (await call('/api/elfremote/tasks?device_id=test&task_id=manage-a')).json();
  assert.equal(result.task.result.text,text);
  assert.equal((await (await call('/api/elfremote/task',task)).json()).duplicate,true);
});

test('真正删除仅下发给声明能力的客户端，不以旧trash冒充删除',async()=>{
  const f=fixture({admin_pass:'fixture-password',remote_devices:[{id:'test',enabled:true,managed_file_operations:true}]});
  const cookie=await login(f),job={device_id:'test',id:'delete-a',type:'file_manage',params:{action:'delete',path:'/sdcard/fixture'}};
  const call=()=>worker.fetch(request('/api/elfremote/task','POST',job,cookie),f.env);
  assert.equal((await call()).status,409);
  f.data.get('remote_devices')[0].managed_file_delete=true;
  assert.equal((await call()).status,200);
  assert.equal(f.data.get('remote_devices')[0].task.params.action,'delete');
  assert.equal(fileOperationParams({action:'copy',path:'/source',target:'/target',overwrite:true}).overwrite,true);
});
