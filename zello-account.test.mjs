import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import worker from './worker.js';
import {fixture,request,login} from './test-support.mjs';
import {zelloAccountParams,queueZelloRestore,applyRepairProgress} from './elfRemote/control-plane.js';
const params={username:'synthetic-user',password:" synthetic'$(value) ",type:'regular'};

test('Zello密码保持原样，不接受未知账号类型和控制字符',()=>{
 assert.equal(zelloAccountParams(params).password,params.password);
 for(const bad of [{type:'work'},{username:'user\nnext'},{password:'secret\u0000'}])assert.throws(()=>zelloAccountParams({...params,...bad}));
});
test('Zello任务需要能力与登录证据，秘密不回传且失败不覆盖成功配置',async()=>{
 const token='test-device',d={id:'test',enabled:true,status_only:true,token_sha256:createHash('sha256').update(token).digest('hex')},f=fixture({admin_pass:'fixture-password',remote_devices:[d]}),cookie=await login(f);
 const call=(path,body,auth=cookie)=>worker.fetch(request(path,body?'POST':'GET',body,auth),f.env);
 const input={device_id:'test',id:'zello-fixture',type:'configure_zello',params};
 assert.equal((await call('/api/elfremote/task',input,null)).status,401);
 assert.equal((await call('/api/elfremote/task',input)).status,409);
 f.data.get('remote_devices')[0].managed_zello_account=true;
 assert.equal((await call('/api/elfremote/task',input)).status,200);
 const progress=(state,result)=>call('/api/elfremote/task-progress',{device_id:'test',token,task_id:input.id,state,result},null);
 await progress('claimed');await progress('running');
 assert.equal((await progress('success',{action:'completed',exit_code:0})).status,400);
 assert.equal((await progress('success',{action:'completed',exit_code:0,logged_in:true,text:'Zello已登录'})).status,200);
 const saved=f.data.get('remote_devices')[0];assert.equal(saved.account_configs.zello.params.password,params.password);assert.deepEqual(saved.task.params,{});
 assert.ok(!(await (await call('/api/devices')).text()).includes(params.password));assert.ok(!(await (await call('/api/elfremote/tasks?device_id=test')).text()).includes(params.password));
 const old=structuredClone(saved.account_configs.zello);
 const badTask={...input,id:'zello-failed',params:{...params,password:'bad',previous_username:'untrusted-input'}};
 await call('/api/elfremote/task',badTask);
 const current=f.data.get('remote_devices')[0];assert.equal(current.task.params.previous_username,params.username);
 assert.equal((await (await call('/api/elfremote/task',badTask)).json()).duplicate,true);
 applyRepairProgress(current,'zello-failed','failed','登录失败',{},Date.now());
 assert.deepEqual(current.account_configs.zello,old);assert.deepEqual(current.task.params,{});
});
test('Zello安装恢复等待其他任务结束，每个新凭据只尝试一次',async()=>{
 const f=fixture(),d={id:'test',enabled:true,managed_zello_account:true,token_sha256:'new',account_configs:{zello:{params,applied_token_sha:'old'}},task:{state:'running'}};
 assert.equal(await queueZelloRestore(d,f.storage,Date.now()),false);d.task=null;
 assert.equal(await queueZelloRestore(d,f.storage,Date.now()),true);assert.equal(d.task.type,'configure_zello');
 d.task.state='failed';assert.equal(await queueZelloRestore(d,f.storage,Date.now()),false);
});
