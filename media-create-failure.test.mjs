import test from 'node:test';import assert from 'node:assert/strict';
import worker from './worker.js';import {fixture,request,login} from './test-support.mjs';
function setup(device={id:'synthetic-d31',managed_media:false,managed_media_modes:[]}){
  const f=fixture({admin_pass:'fixture-password',remote_devices:[device]});let escaped=0;
  f.store.ctx.blockConcurrencyWhile=async fn=>{try{return await fn();}catch(error){escaped++;throw error;}};
  return {...f,escaped:()=>escaped};
}
test('六种能力拒绝在DO并发回调内部返回400，不重置实例且不创建遗留会话',async()=>{
  const f=setup();
  for(const mode of ['ptt','call','microphone','photo','video','alarm']){
    const r=await f.store.fetch(request('/api/elfremote/media/session','POST',{device_id:'synthetic-d31',mode}));
    assert.equal(r.status,400);assert.equal((await r.json()).ok,false);assert.equal(f.escaped(),0);assert.equal(f.store.media.sessions.size,0);
  }
});
test('照片持久登记失败撤销会话、计时器及已写入登记，不影响已有其他设备会话',async()=>{
  const f=setup({id:'synthetic-d31',managed_media_modes:['photo']});let cancelled=0;f.store.media.cancel=()=>{cancelled++;};f.store.media.schedule=()=>0;
  const other=f.store.media.create({id:'another',managed_media_modes:['photo']},'photo');
  const put=f.storage.put;f.storage.put=async(k,v)=>{if(k.startsWith('manual-photo-expiry/'))throw Error('synthetic-write-failure');return put(k,v);};
  const r=await f.store.fetch(request('/api/elfremote/media/session','POST',{device_id:'synthetic-d31',mode:'photo'}));
  assert.equal(r.status,503);assert.equal((await r.json()).msg,'通信服务暂不可用');assert.equal(f.escaped(),0);assert.equal(cancelled,1);
  assert.equal(f.store.media.sessions.size,1);assert.equal(f.store.media.sessions.has(other.session_id),true);assert.equal([...f.data.keys()].filter(k=>k.startsWith('manual-photo')).length,0);
  f.store.media.close(f.store.media.sessions.get(other.session_id),'测试结束');
});
test('存储读取异常返回503且不逃出并发门，非法请求仍返回400',async()=>{
  const f=setup(),get=f.storage.get;f.storage.get=async k=>{if(k==='remote_devices')throw Error('synthetic-store-error');return get(k);};
  const r=await f.store.fetch(request('/api/elfremote/media/session','POST',{device_id:'synthetic-d31',mode:'photo'}));assert.equal(r.status,503);assert.equal(f.escaped(),0);
  for(const body of [null,[]])assert.equal((await f.store.fetch(request('/api/elfremote/media/session','POST',body))).status,400);
});
test('会话检查仅登录管理员可读，不返回令牌或触发设备通知',async()=>{
  const f=setup();const route='/api/elfremote/media/session?device_id=synthetic-d31';
  assert.equal((await worker.fetch(request(route),f.env)).status,401);const cookie=await login(f);
  let r=await worker.fetch(request(route,'GET',undefined,cookie),f.env);assert.deepEqual(await r.json(),{ok:true,active:false,session:null});
  f.store.media.schedule=()=>0;const created=f.store.media.create({id:'synthetic-d31',managed_media_modes:['photo']},'photo');
  r=await worker.fetch(request(route,'GET',undefined,cookie),f.env);const body=await r.json();assert.equal(body.active,true);assert.equal(body.session.mode,'photo');assert.deepEqual(Object.keys(body.session).sort(),['created_at','mode','started_at']);assert.doesNotMatch(JSON.stringify(body),/token|session_id/);
  assert.equal([...f.data.keys()].some(k=>k.startsWith('status-request/')),false);f.store.media.close(f.store.media.sessions.get(created.session_id),'测试结束');
});
