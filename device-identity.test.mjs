import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import worker from './worker.js';
import {fixture,request,login} from './test-support.mjs';
import {normalizeDeviceIdentity} from './device-identity.js';

const identity={variant:'d22',kind:'wifi_factory_mac',source:'nvdata_wifi',value:'00:11:22:aa:bb:cc'};
const sha=token=>createHash('sha256').update(token).digest('hex');
test('出厂地址仅接受实读来源及全局单播地址',()=>{
  assert.deepEqual(normalizeDeviceIdentity({...identity,value:'001122AABBCC'}),identity);
  for(const value of ['02:00:00:00:00:00','02:11:22:aa:bb:cc','01:11:22:aa:bb:cc','00:00:00:00:00:00','ff:ff:ff:ff:ff:ff','bad'])
    assert.throws(()=>normalizeDeviceIdentity({...identity,value}));
  assert.throws(()=>normalizeDeviceIdentity({...identity,source:'ssid'}));
});

test('刷后新注册关联原设备，保留配对配置历史，旧动作与凭证不复活',async()=>{
  const oldToken='old-install',newToken='new-install',f=fixture(),cookie=await login(f);
  const enroll=(token,extra={})=>worker.fetch(request('/api/devices/enroll','POST',{token,token_sha256:sha(token),device_name:'系统名称',hardware_identity:identity,...extra}),f.env);
  const first=await (await enroll(oldToken)).json();
  const devices=f.data.get('remote_devices');const d=devices[0];
  d.paired=true;d.name='管理员名称';d.desired_config={wifi:{enabled:true}};
  d.task={id:'before-wipe',type:'reboot',state:'pending',expires_at:Date.now()+10000};
  d.traffic={available:false};d.last_reported_at='2099-01-01T00:00:00Z';
  f.data.set('remote_devices',devices);f.data.set('history/'+d.id+'/fixture',{saved:true});
  const next=await (await enroll(newToken)).json();
  assert.equal(next.device_id,first.device_id);assert.equal(next.paired,true);
  const current=f.data.get('remote_devices')[0];
  assert.equal(current.name,'管理员名称');assert.deepEqual(current.desired_config,{wifi:{enabled:true}});
  assert.equal(current.task,undefined);assert.equal(current.traffic,undefined);assert.ok(current.installation_id);
  assert.equal(f.data.get('remote_devices').length,1);
  assert.equal(f.data.get('history/'+d.id+'/fixture').saved,true);
  assert.equal((await (await enroll(newToken)).json()).device_id,d.id);
  assert.notEqual((await enroll(oldToken)).status,200);
  const oldReport=await worker.fetch(request('/api/devices/report','POST',{device_id:d.id,token:oldToken}),f.env);
  assert.equal(oldReport.status,401);
  const oldPair=await worker.fetch(request('/api/devices/pair','POST',{code:first.code},cookie),f.env);
  assert.notEqual(oldPair.status,200);
  const history=await (await worker.fetch(request('/api/elfremote/tasks?device_id='+d.id,'GET',undefined,cookie),f.env)).json();
  assert.equal(history.tasks[0].state,'expired');
  const report=await worker.fetch(request('/api/devices/report','POST',{device_id:d.id,token:newToken,status_only:true,report_id:'new-report',reported_at:new Date().toISOString(),battery:77,network:'wifi'}),f.env);
  assert.equal(report.status,200);assert.equal((await report.json()).managed_task,undefined);
  const rows=await (await worker.fetch(request('/api/devices','GET',undefined,cookie),f.env)).json();
  assert.equal(rows.devices[0].name,'管理员名称');assert.equal(rows.devices[0].mac,identity.value);
  assert.equal(JSON.stringify(rows).includes(newToken),false);
  // 原注册未切换MQTT用户名；只有新安装使用独立身份，避免旧连接抢占新连接。
  const {pushState}=await import('./push-control.js');
  const readPush=token=>pushState(f.storage,new Request('https://store/__push/config',{method:'POST',body:JSON.stringify({device_id:d.id,token})}),async()=>f.data.get('remote_devices'));
  assert.equal((await readPush(oldToken)).status,401);
  const username=(await (await readPush(newToken)).json()).username;
  assert.notEqual(username,'d_'+sha(d.id));
});

test('缺失或重复地址不猜测关联，已有旧客户端可继续注册',async()=>{
  const f=fixture({admin_pass:'fixture-password',remote_devices:[{id:'a',hardware_identity:identity,token_sha256:sha('a')},{id:'b',hardware_identity:identity,token_sha256:sha('b')}]});
  const enroll=(token,extra={})=>worker.fetch(request('/api/devices/enroll','POST',{token,token_sha256:sha(token),...extra}),f.env);
  const multiple=await (await enroll('third',{hardware_identity:identity})).json();
  assert.ok(multiple.device_id);assert.notEqual(multiple.device_id,'a');assert.notEqual(multiple.device_id,'b');
  assert.equal((await enroll('legacy')).status,200);
});
