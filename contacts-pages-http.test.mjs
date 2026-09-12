import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import worker from './worker.js';
import {fixture,request,login} from './test-support.mjs';
const token='synthetic-contacts-token',deviceId='contacts-fixture',snapshotId='00000000-0000-4000-8000-000000000001';
const common={schema_version:1,ok:true,read_only:true,source:'nexui_messenger',contact_type:'LOCAL'};
const descriptor={...common,action:'open',owner_package:'com.starnet.dial',snapshot_id:snapshotId,status:'COMPLETED',sampled_at_ms:1000,record_count:2,end_observed:true,list_complete:true,contact_values_emitted:false,completion_scope:'SELECTED_SOURCE_ALL_CONTACTS_REPLY',all_sources_complete:false,snapshot_consistency:'NOT_PROVIDED_BY_VENDOR',retention_ms:120000,max_page_records:32,page_consistency:'IMMUTABLE_RECEIVED_REPLY',storage:'APP_PROCESS_MEMORY',cross_process_restart:false,cross_boot:false};
async function setup(){const f=fixture({admin_pass:'fixture-password',remote_devices:[{id:deviceId,model_id:'mdl_d31',enabled:true,status_only:true,managed_contacts_page_v1:true,token_sha256:createHash('sha256').update(token).digest('hex')}]});const cookie=await login(f);let seq=0;
 const call=(path,body,auth)=>worker.fetch(request(path,body?'POST':'GET',body??undefined,auth),f.env);
 const submit=async(params,id='contacts-'+(++seq))=>{const r=await call('/api/elfremote/task',{device_id:deviceId,id,type:'contacts_page',params},cookie);return {status:r.status,body:await r.json()};};
 const progress=(id,state,result)=>call('/api/elfremote/task-progress',{device_id:deviceId,token,task_id:id,state,...(result?{result:{contacts_page:result}}:{})});
 const complete=async(id,value)=>{assert.equal((await progress(id,'claimed')).status,200);assert.equal((await progress(id,'running')).status,200);const r=await progress(id,value.ok?'success':'failed',value);assert.equal(r.status,200,await r.clone().text());return r.json();};
 return {f,cookie,call,submit,progress,complete};
}
test('正式任务路由完成open/page/复读/close，原厂内容保持且不写旧联系人',async()=>{
 const h=await setup(),open=await h.submit({action:'open',source:'LOCAL'});assert.equal(open.status,200,JSON.stringify(open.body));await h.complete(open.body.task.id,descriptor);
 const expiry=h.f.data.get('remote_devices')[0].contacts_page_snapshot.expires_at;
 const p={action:'page',snapshot_id:snapshotId,offset:0,limit:1},value={...descriptor,action:'page',contact_values_emitted:true,items:[{mName:'合成甲',mNumbers:['合成号码'],vendor:{flag:1}}],offset:0,next_offset:1,has_more:true,page_complete:false,cursor_scope:'SAME_SNAPSHOT_ONLY'};
 const page=await h.submit(p);const done=await h.complete(page.body.task.id,value);assert.deepEqual(done.task.result.contacts_page.items,value.items);assert.equal(h.f.data.get('remote_devices')[0].contacts,undefined);assert.equal(h.f.data.get('remote_devices')[0].contacts_page_snapshot.expires_at,expiry);
 const reread=await h.submit(p);await h.complete(reread.body.task.id,value);
 const close=await h.submit({action:'close',snapshot_id:snapshotId});await h.complete(close.body.task.id,{...common,action:'close',snapshot_id:snapshotId,snapshot_closed:true});
 const refused=await h.submit(p);assert.equal(refused.status,409);assert.equal(refused.body.not_enqueued,true);assert.equal(refused.body.code,'CONTACTS_SNAPSHOT_GONE');
 const old=await h.call('/api/elfremote/tasks?device_id='+deviceId+'&task_id='+page.body.task.id,null,h.cookie);assert.equal((await old.json()).task.result.contacts_page.items[0].mName,'合成甲');
 assert.equal((await h.progress(page.body.task.id,'success',value)).status,200);
 assert.equal((await h.progress(page.body.task.id,'success',{...value,items:[{mName:'错误替换'}]})).status,409);
});
test('页任务不接受不同快照、变更总数、未确认成功或未知错误空列表',async()=>{
 const h=await setup();const open=await h.submit({action:'open',source:'LOCAL'});await h.complete(open.body.task.id,descriptor);
 assert.equal((await h.submit({action:'page',snapshot_id:crypto.randomUUID(),offset:0,limit:1})).status,409);
 const p=await h.submit({action:'page',snapshot_id:snapshotId,offset:0,limit:1});await h.progress(p.body.task.id,'claimed');await h.progress(p.body.task.id,'running');
 const wrong={...descriptor,action:'page',record_count:3,contact_values_emitted:true,items:[{}],offset:0,next_offset:1,has_more:true,page_complete:false,cursor_scope:'SAME_SNAPSHOT_ONLY'};
 assert.equal((await h.progress(p.body.task.id,'success',wrong)).status,409);
 assert.equal(h.f.data.get('remote_devices')[0].task.state,'running');
 const failure={...common,ok:false,action:'page',snapshot_id:snapshotId,code:'CONTACTS_SNAPSHOT_GONE'};assert.equal((await h.progress(p.body.task.id,'success',failure)).status,409);
 const r=await h.progress(p.body.task.id,'failed',failure);assert.equal(r.status,200);assert.equal((await r.json()).task.result.contacts_page.code,'CONTACTS_SNAPSHOT_GONE');
});
test('缺能力/其他来源拒绝，报告能力决定下发并沿原任务查询',async()=>{
 const h=await setup();assert.equal((await h.submit({action:'open',source:'ALL'})).status,400);
 const t=await h.submit({action:'open',source:'LOCAL'});const r=await h.call('/api/devices/report',{device_id:deviceId,token,status_only:true,report_id:crypto.randomUUID(),network:'ethernet',managed_contacts_page_v1:true});
 const b=await r.json();assert.equal(r.status,200,JSON.stringify(b));assert.equal(b.managed_task.type,'contacts_page');assert.equal(b.managed_task.id,t.body.task.id);
 assert.equal(b.managed_task.managed_contacts_page_v1,true);
 const row=h.f.data.get('remote_devices')[0];row.managed_contacts_page_v1=false;row.task=null;h.f.data.set('remote_devices',[row]);assert.equal((await h.submit({action:'open',source:'LOCAL'})).status,409);
});
