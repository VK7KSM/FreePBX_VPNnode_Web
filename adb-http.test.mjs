import test from 'node:test';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';import worker from './worker.js';import {fixture,request,login} from './test-support.mjs';
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
