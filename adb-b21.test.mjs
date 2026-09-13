import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import worker from './worker.js';
import {fixture, login, request} from './test-support.mjs';
import {pushState} from './push-control.js';
import {AdbRelay} from './adb-relay.js';

const token='offline-fixture-token';
const deviceId='offline-fixture';
const identity={device_id:deviceId,token};
const call=(f,path,body,cookie)=>worker.fetch(request(path,'POST',body,cookie),f.env);

async function setup(t){
  const f=fixture({admin_pass:'fixture-password',remote_devices:[{
    id:deviceId,enabled:true,managed_adb_session:true,
    token_sha256:createHash('sha256').update(token).digest('hex')
  }]});
  f.published=[];
  f.env.ELF_BASE_URL='https://example.test';
  f.env.MQTT_API_URL='https://broker.example.test';
  f.env.MQTT_API_TOKEN='offline-fixture-api';
  f.env.MQTT_FETCH=async(url,init)=>{
    assert.ok(String(url).endsWith('/v1/publish'));
    const notice=JSON.parse(init.body).notification;f.published.push(notice);
    return Response.json({ok:true,accepted:true,request_id:notice.request_id});
  };
  t.after(()=>{for(const s of f.store.adb.sessions.values())f.store.adb.close(s,'离线测试结束');});
  f.cookie=await login(f);
  return f;
}

test('新ADB会话不继承五分钟旧通知及已用完的三次发布额度',async t=>{
  const f=await setup(t);
  const prior=await (await call(f,'/api/devices/request-status',identity,f.cookie)).json();
  const key='push/request/'+deviceId,old=f.data.get(key);
  old.publish_attempts=3;old.received_at=new Date().toISOString();f.data.set(key,old);
  const created=await (await call(f,'/api/elfremote/adb/session',{device_id:deviceId},f.cookie)).json();
  const notice=f.data.get(key);
  assert.equal(f.published.length,2,'新会话必须真实调用发布替身');
  assert.notEqual(notice.request_id,prior.request.request_id);
  assert.equal(notice.version,prior.request.version+1);
  assert.equal(notice.wake_key,'adb:'+created.session_id);
  assert.equal(notice.publish_attempts,1);
  assert.equal(notice.received_at,undefined);
  assert.equal(created.notification.request_id,notice.request_id);
});

test('ADB立即重连产生新通知并关闭旧会话，普通拉取仍合并',async t=>{
  const f=await setup(t);
  const first=await (await call(f,'/api/elfremote/adb/session',{device_id:deviceId},f.cookie)).json();
  const previous=f.data.get('push/request/'+deviceId);
  const second=await (await call(f,'/api/elfremote/adb/session',{device_id:deviceId},f.cookie)).json();
  const current=f.data.get('push/request/'+deviceId);
  assert.notEqual(current.request_id,previous.request_id);
  assert.equal(current.version,previous.version+1);
  assert.equal(current.wake_key,'adb:'+second.session_id);
  assert.equal(f.store.adb.sessions.has(first.session_id),false);
  await call(f,'/api/devices/request-status',{...identity,wake_key:'adb:'+crypto.randomUUID()},f.cookie);
  assert.equal(f.published.length,2);
  assert.equal(f.data.get('push/request/'+deviceId).request_id,current.request_id);
});

test('同一内部ADB唤醒标识保持去重，错误标识不能刷新通知',async()=>{
  const f=fixture({remote_devices:[{id:deviceId,enabled:true}]});
  const wake='adb:'+crypto.randomUUID();
  const prepare=async wake_key=>(await pushState(f.storage,
    request('/__push/prepare','POST',{device_id:deviceId,wake_key}),
    async()=>f.data.get('remote_devices'),10000)).json();
  const first=await prepare(wake),again=await prepare(wake),invalid=await prepare('adb:invalid');
  assert.equal(first.request.wake_key,wake);
  assert.equal(again.request.request_id,first.request.request_id);
  assert.equal(again.should_publish,false);
  assert.equal(invalid.request.request_id,first.request.request_id);
});

test('认证同步立即取得ADB邀请，无需完整报告且不伪造完成回执',async t=>{
  const f=await setup(t);
  const created=await (await call(f,'/api/elfremote/adb/session',{device_id:deviceId},f.cookie)).json();
  const notice=f.data.get('push/request/'+deviceId);
  const sync=await (await call(f,'/api/devices/push-sync',{
    ...identity,received_request_id:notice.request_id,received_version:notice.version
  })).json();
  assert.equal(sync.adb_session?.session_id,created.session_id);
  assert.equal(sync.adb_session.token.length,64);
  assert.equal(sync.adb_session.expires_at,created.expires_at);
  assert.equal(f.data.get('remote_devices')[0].last_reported_at,undefined);
  assert.equal(f.data.get('push/request/'+deviceId).state,'pending');
  assert.ok(f.data.get('push/request/'+deviceId).received_at);
  assert.equal(created.token,undefined);
});

test('同步拒绝错误凭据且不会向其他认证设备发放ADB邀请',async t=>{
  const f=await setup(t);
  await call(f,'/api/elfremote/adb/session',{device_id:deviceId},f.cookie);
  assert.equal((await call(f,'/api/devices/push-sync',{...identity,token:'invalid'})).status,401);
  f.data.get('remote_devices').push({id:'other-offline-fixture',enabled:true,managed_adb_session:true,
    token_sha256:createHash('sha256').update(token).digest('hex')});
  const other=await (await call(f,'/api/devices/push-sync',{device_id:'other-offline-fixture',token})).json();
  assert.equal(other.adb_session,null);
});

test('能力撤回、停用但保留安全任务时同步也不能领取ADB',async t=>{
  for(const change of [{managed_adb_session:false},{managed_adb_session:undefined},
    {enabled:false,safety_task:{id:'offline-safety',state:'pending'}}]){
    const f=await setup(t);
    await call(f,'/api/elfremote/adb/session',{device_id:deviceId},f.cookie);
    Object.assign(f.data.get('remote_devices')[0],change);
    const response=await call(f,'/api/devices/push-sync',identity);
    assert.equal(response.status,200);
    assert.equal((await response.json()).adb_session,null);
  }
});

test('同步邀请与报告后备领取相同，连接后不重复发放且到期不续命',async t=>{
  const f=await setup(t);let now=Date.now();f.store.adb.now=()=>now;
  const created=await (await call(f,'/api/elfremote/adb/session',{device_id:deviceId},f.cookie)).json();
  const first=await (await call(f,'/api/devices/push-sync',identity)).json();
  const report=await (await call(f,'/api/devices/report',{...identity,status_only:true,
    managed_adb_session:true,report_id:crypto.randomUUID(),timestamp:new Date(now).toISOString()})).json();
  assert.deepEqual(first.adb_session,report.adb_session);
  assert.equal(first.adb_session?.session_id,created.session_id);
  const socket=new Socket();
  f.store.adb.attach(f.store.adb.get(created.session_id,'device',first.adb_session.token),'device',socket);
  assert.equal((await (await call(f,'/api/devices/push-sync',identity)).json()).adb_session,null);
  now+=60000;
  assert.equal((await (await call(f,'/api/devices/push-sync',identity)).json()).adb_session,null);
  assert.equal(f.store.adb.sessions.size,0);
  assert.equal(socket.closes,1);
});

test('只读状态查询不发布推送且不携带ADB会话凭据',async t=>{
  const f=await setup(t);
  await call(f,'/api/elfremote/adb/session',{device_id:deviceId},f.cookie);
  const before=f.published.length;
  const response=await worker.fetch(request('/api/devices/status-request?device_id='+deviceId,'GET',undefined,f.cookie),f.env);
  const result=await response.json();assert.equal(response.status,200);
  assert.equal(result.adb_session,undefined);assert.equal(result.token,undefined);
  assert.equal(f.published.length,before);
});

test('推送代理等待只阻塞创建响应，不阻塞认证同步读取已创建会话',async t=>{
  const f=await setup(t);let release,started;
  const pending=new Promise(resolve=>{started=resolve;});
  f.env.MQTT_FETCH=async(url,init)=>{
    const body=JSON.parse(init.body);started();await new Promise(resolve=>{release=resolve;});
    return Response.json({ok:true,accepted:true,request_id:body.notification.request_id});
  };
  let returned=false;
  const creating=call(f,'/api/elfremote/adb/session',{device_id:deviceId},f.cookie).then(r=>{returned=true;return r;});
  await pending;
  let sync;
  try{sync=await (await call(f,'/api/devices/push-sync',identity)).json();assert.equal(returned,false);}
  finally{release();}
  const created=await (await creating).json();
  assert.equal(sync.adb_session?.session_id,created.session_id);
});

class Socket{
  handlers={};closes=0;throwSend=false;throwClose=false;
  accept(){}
  addEventListener(name,handler){this.handlers[name]=handler;}
  send(){if(this.throwSend)throw Error('离线模拟发送失败');}
  close(){this.closes++;if(this.throwClose)throw Error('离线模拟关闭失败');}
}

test('任一端关闭通知发送失败，仍尝试关闭双端并清除凭据和定时器',()=>{
  for(const role of ['browser','device']){
    let cancelled=0;
    const relay=new AdbRelay({schedule:()=>1,cancel:()=>{cancelled++;}});
    const created=relay.create({id:deviceId,managed_adb_session:true});
    const s=relay.sessions.get(created.session_id),browser=new Socket(),device=new Socket();
    relay.attach(s,'browser',browser);relay.attach(s,'device',device);
    s[role].throwSend=true;
    relay.close(s,'离线测试关闭');relay.close(s,'重复关闭');
    assert.equal(browser.closes,1);assert.equal(device.closes,1);
    assert.equal(relay.sessions.size,0);assert.equal(s.token,'');assert.equal(cancelled,1);
  }
});

test('一个socket关闭抛错不阻止另一端清理',()=>{
  const relay=new AdbRelay({schedule:()=>1,cancel:()=>{}});
  const created=relay.create({id:deviceId,managed_adb_session:true});
  const s=relay.sessions.get(created.session_id),browser=new Socket(),device=new Socket();
  relay.attach(s,'browser',browser);relay.attach(s,'device',device);browser.throwClose=true;
  relay.close(s,'离线测试关闭');
  assert.equal(device.closes,1);assert.equal(relay.sessions.size,0);
});
