import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import worker from './worker.js';import {fixture,request,login} from './test-support.mjs';
test('真实报告保存并透传显式集合；直接API按模式拒绝，不靠隐藏按钮',async()=>{
 const token='synthetic-media-token',id='synthetic-media-device',f=fixture({admin_pass:'fixture-password',remote_devices:[{id,model_id:'mdl_d31',paired:true,enabled:true,status_only:true,token_sha256:createHash('sha256').update(token).digest('hex')}]}),cookie=await login(f);
 const report=async extra=>{const r=await worker.fetch(request('/api/devices/report','POST',{device_id:id,token,report_id:crypto.randomUUID(),status_only:true,network:'ethernet',reported_at:new Date().toISOString(),...extra}),f.env);assert.equal(r.status,200);return r.json();};
 const list=async()=> (await (await worker.fetch(request('/api/devices','GET',undefined,cookie),f.env)).json()).devices[0];
 const create=mode=>worker.fetch(request('/api/elfremote/media/session','POST',{device_id:id,mode},cookie),f.env);
 await report({managed_media:true,managed_media_modes:[]});assert.deepEqual((await list()).managed_media_modes,[]);assert.equal((await create('photo')).status,400);
 await report({managed_media:false,managed_media_modes:['photo']});assert.deepEqual((await list()).managed_media_modes,['photo']);assert.equal((await create('alarm')).status,400);const accepted=await create('photo');assert.equal(accepted.status,200);const session=await accepted.json();
 const offer=await report({managed_media:false,managed_media_modes:['photo']});assert.equal(offer.media_session.session_id,session.session_id);
 await report({managed_media:true,managed_media_modes:['alarm']});assert.equal(f.store.media.sessions.has(session.session_id),false);
 await report({managed_media:true,managed_media_modes:null});assert.deepEqual((await list()).managed_media_modes,[]);assert.equal((await create('alarm')).status,400);
 await report({managed_media:true});assert.equal(Object.hasOwn(await list(),'managed_media_modes'),false);const old=await create('photo');assert.equal(old.status,200);const sid=(await old.json()).session_id;f.store.media.close(f.store.media.sessions.get(sid),'测试结束');
});

