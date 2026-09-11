import test from 'node:test';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';import worker from './worker.js';import {fixture,request,login} from './test-support.mjs';

test('D22、D31、H13、Pixel及新增型号统一按ADB能力接入，不要求root或配对',async()=>{
  const f=fixture(),cookie=await login(f);
  for(const model of ['mdl_d22','mdl_d31','mdl_h13','mdl_pixel3','mdl_future']){
    const d={id:'adb-compatible',model_id:model,enabled:true,paired:false,status_only:true,managed_adb_session:true,managed_exec_tasks:false,managed_adbd_tasks:false};
    f.data.set('remote_devices',[d]);
    const r=await worker.fetch(request('/api/elfremote/adb/session','POST',{device_id:d.id},cookie),f.env);
    assert.equal(r.status,200,model);const created=await r.json();assert.equal(created.ok,true);
    assert.equal(f.store.adb.offer(d.id,'https://example.test').session_id,created.session_id);
    f.store.adb.close(f.store.adb.sessions.get(created.session_id),'测试结束');
    for(const capability of [false,undefined]){
      f.data.set('remote_devices',[{...d,managed_adb_session:capability}]);
      assert.equal((await worker.fetch(request('/api/elfremote/adb/session','POST',{device_id:d.id},cookie),f.env)).status,400);
    }
  }
});
test('创建失败在并发锁内部返回JSON而不令Durable Object重置',async()=>{
  const f=fixture();let escaped=false;
  f.store.ctx.blockConcurrencyWhile=async fn=>{try{return await fn();}catch(e){escaped=true;throw e;}};
  const response=await f.store.fetch(request('/api/elfremote/adb/session','POST',{device_id:'missing'}));
  assert.equal(response.status,400);assert.equal((await response.json()).ok,false);assert.equal(escaped,false);
});
test('只有已登录管理员能创建会话，设备报告领取绑定目标的短期凭据',async()=>{
  const token='adb-device-fixture',f=fixture({admin_pass:'fixture-password',remote_devices:[{id:'adb-fixture',enabled:true,paired:true,status_only:true,managed_adb_session:true,token_sha256:createHash('sha256').update(token).digest('hex')}]});
  const cookie=await login(f);
  const result=await worker.fetch(request('/api/elfremote/adb/session','POST',{device_id:'missing'},cookie),f.env);assert.equal(result.status,400);
  const session=await (await worker.fetch(request('/api/elfremote/adb/session','POST',{device_id:'adb-fixture'},cookie),f.env)).json();assert.equal(session.ok,true);assert.equal(session.token,undefined);
  const report=await worker.fetch(request('/api/devices/report','POST',{device_id:'adb-fixture',token,report_id:crypto.randomUUID(),status_only:true,managed_adb_session:true,network:'wifi',timestamp:new Date().toISOString()}),f.env);
  const received=await report.json();assert.equal(report.status,200,JSON.stringify(received));assert.equal(received.adb_session.session_id,session.session_id);assert.equal(received.adb_session.token.length,64);
  assert.equal((await worker.fetch(request('/api/elfremote/adb/browser?session_id='+session.session_id),f.env)).status,401);
  assert.equal((await worker.fetch(request('/api/elfremote/adb/device?session_id='+session.session_id,'GET',undefined,null,{Upgrade:'websocket',Authorization:'Bearer wrong'}),f.env)).status,400);
  f.store.adb.close(f.store.adb.sessions.get(session.session_id),'测试结束');
});
