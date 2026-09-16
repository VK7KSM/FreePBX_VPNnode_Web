import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import worker from './worker.js';
import {fixture,login,request} from './test-support.mjs';

const deviceId='pixel-tunnel-fixture',deviceToken='pixel-device-token';
const identity={device_id:deviceId,token:deviceToken};
const call=(f,path,body,cookie,method='POST')=>worker.fetch(request(path,method,body,cookie),f.env);
async function setup(t,capability=true){
  const f=fixture({admin_pass:'fixture-password',remote_devices:[{id:deviceId,enabled:true,managed_adb_tunnel_v1:capability,
    token_sha256:createHash('sha256').update(deviceToken).digest('hex')}]});
  f.env.ELF_BASE_URL='https://v.elfradio.net';f.env.MQTT_API_URL='https://broker.example.test';f.env.MQTT_API_TOKEN='fixture';f.notices=[];
  f.env.MQTT_FETCH=async(url,init)=>{const notice=JSON.parse(init.body).notification;f.notices.push(notice);return Response.json({ok:true,accepted:true,request_id:notice.request_id});};
  f.cookie=await login(f);t.after(()=>{for(const session of f.store.adbTunnel.sessions.values())f.store.adbTunnel.close(session,'test_cleanup');});return f;
}

test('能力开启后管理员创建会话，MQTT即时唤醒并由push-sync领取device邀请',async t=>{
  const f=await setup(t);const response=await call(f,'/api/elfremote/adb-tunnel/session',{device_id:deviceId},f.cookie);
  assert.equal(response.status,200);const created=await response.json();
  assert.match(created.host_token,/^[a-f0-9]{64}$/);assert.match(created.host_url,/^wss:\/\/v\.elfradio\.net\/api\/elfremote\/adb-tunnel\/host\?session_id=/);
  assert.equal(new URL(created.host_url).searchParams.size,1);assert.equal(created.expires_at_unit,'unix_ms');
  assert.equal(f.notices.length,1);assert.equal(f.data.get('push/request/'+deviceId).wake_key,'adb_tunnel:'+created.session_id);
  const sync=await (await call(f,'/api/devices/push-sync',identity)).json();assert.equal(sync.adb_tunnel.session_id,created.session_id);
  assert.match(sync.adb_tunnel.token,/^[a-f0-9]{64}$/);assert.equal(sync.adb_tunnel.expires_at,created.expires_at);
  assert.equal(sync.adb_tunnel.expires_at_unit,'unix_ms');assert.equal(new URL(sync.adb_tunnel.device_url).origin,'wss://v.elfradio.net');
  assert.equal(new URL(sync.adb_tunnel.device_url).searchParams.size,1);assert.equal(sync.adb_tunnel.device_url.includes(sync.adb_tunnel.token),false);
});

test('能力缺失或设备停用时拒绝创建，错误设备凭据不能领取邀请',async t=>{
  const unsupported=await setup(t,false);assert.equal((await call(unsupported,'/api/elfremote/adb-tunnel/session',{device_id:deviceId},unsupported.cookie)).status,400);
  const f=await setup(t);await call(f,'/api/elfremote/adb-tunnel/session',{device_id:deviceId},f.cookie);
  assert.equal((await call(f,'/api/devices/push-sync',{...identity,token:'wrong'})).status,401);
  f.data.get('remote_devices')[0].enabled=false;assert.equal((await call(f,'/api/devices/push-sync',identity)).status,409);
});

test('主动关闭后状态接口证明会话与令牌均已清除',async t=>{
  const f=await setup(t),created=await (await call(f,'/api/elfremote/adb-tunnel/session',{device_id:deviceId},f.cookie)).json();
  const before=await worker.fetch(request('/api/elfremote/adb-tunnel/session?session_id='+created.session_id,'GET',undefined,f.cookie),f.env);
  assert.equal((await before.json()).active,true);
  const removed=await call(f,'/api/elfremote/adb-tunnel/session',{session_id:created.session_id},f.cookie,'DELETE');
  assert.equal(removed.status,200);assert.equal(f.store.adbTunnel.sessions.size,0);
  const after=await worker.fetch(request('/api/elfremote/adb-tunnel/session?session_id='+created.session_id,'GET',undefined,f.cookie),f.env);
  assert.deepEqual(await after.json(),{ok:true,active:false,session_id:created.session_id});
  assert.equal((await (await call(f,'/api/devices/push-sync',identity)).json()).adb_tunnel,null);
});

test('状态报告保存新能力并在公开设备对象显示，不改变旧浏览器ADB能力',async t=>{
  const f=await setup(t,false);const report=await call(f,'/api/devices/report',{...identity,status_only:true,report_id:crypto.randomUUID(),
    timestamp:new Date().toISOString(),managed_adb_tunnel_v1:true,managed_adb_session:false,network:'wifi'});
  assert.equal(report.status,200);const saved=f.data.get('remote_devices')[0];assert.equal(saved.managed_adb_tunnel_v1,true);assert.equal(saved.managed_adb_session,false);
  const list=await worker.fetch(request('/api/devices','GET',undefined,f.cookie),f.env),publicDevice=(await list.json()).devices[0];
  assert.equal(publicDevice.managed_adb_tunnel_v1,true);assert.equal(publicDevice.managed_adb_session,false);
});

test('管理接口仍需登录，host/device入口只接受一次性Bearer而不接受跨站来源',async t=>{
  const f=await setup(t);assert.equal((await call(f,'/api/elfremote/adb-tunnel/session',{device_id:deviceId})).status,401);
  const created=await (await call(f,'/api/elfremote/adb-tunnel/session',{device_id:deviceId},f.cookie)).json();
  const denied=await worker.fetch(new Request(created.host_url,{headers:{Upgrade:'websocket',Authorization:'Bearer bad'}}),f.env);assert.equal(denied.status,400);
  const cross=await worker.fetch(new Request(created.host_url,{headers:{Upgrade:'websocket',Authorization:'Bearer '+created.host_token,Origin:'https://other.test','Sec-Fetch-Site':'cross-site'}}),f.env);
  assert.equal(cross.status,403);
});
