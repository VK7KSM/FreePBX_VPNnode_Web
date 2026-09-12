import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {normalizeContactsPageParams as params,normalizeContactsPageResult as result,validateContactsPageSnapshot,contactsPageSubmissionRejected,createContactsPageController,contactsPagesClientSource} from './contacts-pages.js';
const snapshotId='00000000-0000-4000-8000-000000000001';
const device={id:'synthetic-a',model_id:'mdl_d31',managed_contacts_page_v1:true};
function descriptor(count=2){return {schema_version:1,action:'open',ok:true,read_only:true,source:'nexui_messenger',contact_type:'LOCAL',owner_package:'com.starnet.dial',snapshot_id:snapshotId,status:'COMPLETED',sampled_at_ms:1000,record_count:count,end_observed:true,list_complete:true,contact_values_emitted:false,completion_scope:'SELECTED_SOURCE_ALL_CONTACTS_REPLY',all_sources_complete:false,snapshot_consistency:'NOT_PROVIDED_BY_VENDOR',retention_ms:120000,max_page_records:32,page_consistency:'IMMUTABLE_RECEIVED_REPLY',storage:'APP_PROCESS_MEMORY',cross_process_restart:false,cross_boot:false};}
function page(p,count=2,cap=1){const n=Math.min(cap,p.limit,count-p.offset);return {...descriptor(count),action:'page',items:Array.from({length:n},(_,i)=>({mId:i+p.offset,mName:'合成姓名'+(i+p.offset),mNumbers:['合成号码'],vendorExtra:{kind:'retained'}})),offset:p.offset,next_offset:p.offset+n,has_more:p.offset+n<count,page_complete:p.offset+n===count,cursor_scope:'SAME_SNAPSHOT_ONLY',contact_values_emitted:n>0};}
function closed(p){return {schema_version:1,action:'close',ok:true,read_only:true,source:'nexui_messenger',contact_type:'LOCAL',snapshot_id:p.snapshot_id,snapshot_closed:true};}
function failure(p,code='CONTACTS_SNAPSHOT_GONE'){return {schema_version:1,action:p.action,ok:false,read_only:true,source:'nexui_messenger',contact_type:'LOCAL',...(p.action==='open'?{}:{snapshot_id:p.snapshot_id}),code};}
function harness({count=2,behavior}={}){let wall=1000000,mono=0,seq=0;const calls=[],tasks=new Map();
 const controller=createContactsPageController({now:()=>wall,monotonic:()=>mono,uuid:()=>String(++seq).padStart(8,'0')+'-0000-4000-8000-000000000000',changed(){},request:async(path,body)=>{
  calls.push({path,body});if(body){const p=body.params,contacts_page=p.action==='open'?descriptor(count):p.action==='page'?page(p,count):closed(p);const task={id:body.id,type:'contacts_page',expires_at:body.expires_at,state:'success',result:{truncated:false,contacts_page}};tasks.set(body.id,task);if(behavior){const v=await behavior({path,body,task,calls});if(v!==undefined)return v;}return {ok:true,task};}
  if(behavior){const v=await behavior({path,calls});if(v!==undefined)return v;}const id=new URL('https://test'+path).searchParams.get('task_id');return {ok:true,task:tasks.get(id)};
 }});
 return {controller,calls,tasks,advance(ms){wall+=ms;mono+=ms;},backward(ms){wall-=ms;},setBehavior(){},state:()=>controller.state(device)};
}
test('三动作严格参数门，仅LOCAL，只读偏移与页长保持整数',()=>{
 assert.deepEqual(params({action:'open',source:'LOCAL'}),{action:'open',source:'LOCAL'});assert.deepEqual(params({action:'page',snapshot_id:snapshotId,offset:0,limit:32}),{action:'page',snapshot_id:snapshotId,offset:0,limit:32});assert.equal(params({action:'close',snapshot_id:snapshotId}).action,'close');
 for(const p of [{action:'open',source:'ALL'},{action:'open',source:'LOCAL',write:true},{action:'page',snapshot_id:snapshotId,offset:'0',limit:32},{action:'page',snapshot_id:snapshotId,offset:0,limit:33},{action:'page',snapshot_id:snapshotId,offset:-1,limit:1},{action:'close',snapshot_id:'bad'},null,[]])assert.throws(()=>params(p));
});
test('结果保留原厂字段但不转换Android号码行，错误来源/完整性/页游标/截断尺寸拒绝',()=>{
 const p={action:'page',snapshot_id:snapshotId,offset:0,limit:32},value=page(p);const normalized=result(value,p);assert.deepEqual(normalized.items[0].vendorExtra,{kind:'retained'});normalized.items[0].mName='changed';assert.notEqual(value.items[0].mName,'changed');
 for(const edit of [v=>v.contact_type='ALL',v=>v.snapshot_id='wrong',v=>v.retention_ms=120001,v=>v.all_sources_complete=true,v=>v.next_offset=32,v=>v.items=[],v=>v.items=[null],v=>v.read_only=false,v=>v.elapsed_ms='unknown',v=>v.start_observed=1,v=>v.items[0].huge='x'.repeat(70000)]){const v=page(p);edit(v);assert.throws(()=>result(v,p));}
 const open=descriptor();open.items=[];assert.throws(()=>result(open,{action:'open',source:'LOCAL'}));
});
test('新任务顺序open后第一页，按真实next_offset翻页与复读，关闭清空内容',async()=>{
 const h=harness(),c=h.controller;await c.open(device);assert.equal(h.state().page.next_offset,1);await c.next(device);assert.equal(h.state().page.offset,1);await c.previous(device);assert.equal(h.state().page.offset,0);await c.close(device);assert.equal(h.state().snapshot,null);assert.equal(h.state().page,null);
 assert.deepEqual(h.calls.map(x=>x.body.params.action),['open','page','page','page','close']);assert.deepEqual(h.calls.filter(x=>x.body.params.action==='page').map(x=>x.body.params.offset),[0,1,0]);assert.equal(h.calls.filter(x=>x.body.params.action==='open').length,1);
});
test('页长预算返回不足32条仍按next_offset；成功空列表与失败空结果区分',async()=>{
 const h=harness({count:0});await h.controller.open(device);assert.equal(h.state().page.record_count,0);assert.equal(h.state().message,'LOCAL 暂无联系人');
 const failed=harness({behavior:({body,task})=>body?.params.action==='open'?{task:{...task,state:'failed',result:{contacts_page:failure(body.params,'CONTACTS_OPEN_FAILED')}}}:undefined});await failed.controller.open(device);assert.equal(failed.state().page,null);assert.ok(failed.state().error);assert.doesNotMatch(failed.state().message,/暂无/);
});
test('页失败保留此前内容并显示错误，不隐式重采，快照身份和元数据不能串用',async()=>{
 for(const mode of ['gone','changed']){let pages=0;const h=harness({behavior:({body,task})=>{if(body?.params.action==='page'&&++pages===2){if(mode==='gone')return {task:{...task,state:'failed',result:{contacts_page:failure(body.params)}}};task.result.contacts_page.sampled_at_ms++;return {task};}}});await h.controller.open(device);const first=structuredClone(h.state().page);await h.controller.next(device);assert.deepEqual(h.state().page,first);assert.ok(h.state().error);assert.equal(h.calls.filter(x=>x.body?.params.action==='open').length,1);}
});
test('120秒原期限不随翻页续期，时钟倒退同样停止新请求',async()=>{
 for(const backwards of [false,true]){const h=harness();await h.controller.open(device);h.advance(110000);await h.controller.next(device);const before=h.calls.length;if(backwards)h.backward(120000);else h.advance(10000);await h.controller.previous(device);assert.equal(h.calls.length,before);assert.equal(h.state().invalid,true);assert.match(h.state().error,/过期/);}
});
test('设备结果延迟超过原期限不继续第一页，不把迟到快照当新120秒',async()=>{
 let h;h=harness({behavior:({body,task})=>{if(body?.params.action==='open'){h.advance(120000);return {task};}}});await h.controller.open(device);assert.equal(h.calls.length,1);assert.equal(h.state().invalid,true);assert.equal(h.state().page,null);
});
test('提交结果未知只查询原号，404或服务器退避不换号，不重复open',async()=>{
 let failed=true;const h=harness({behavior:({body})=>{if(body&&failed){failed=false;throw Object.assign(Error('network'),{retryAfter:3600000});}}});await h.controller.open(device);const original=structuredClone(h.state().pending.request);await h.controller.open(device);await h.controller.resume(device);assert.equal(h.calls.length,1);h.advance(3600000);await h.controller.resume(device);assert.equal(h.calls.length,2);assert.equal(h.calls[1].body,undefined);assert.ok(h.calls[1].path.includes(original.id));assert.equal(h.calls.filter(x=>x.body).length,1);assert.equal(h.state().invalid,true);
 const missing=harness({behavior:({body})=>{if(body)throw Error('unknown');return {ok:false,msg:'未找到该任务'};}});await missing.controller.open(device);const request=structuredClone(missing.state().pending.request);await missing.controller.resume(device);assert.deepEqual(missing.state().pending.request,request);assert.equal(missing.calls.filter(x=>x.body).length,1);
});
test('旧设备task通知不能串入另一设备，pending通知及重复终态只消费一次',async()=>{
 const h=harness({behavior:({body,task})=>body?.params.action==='open'?{task:{...task,state:'pending',result:null}}:undefined});await h.controller.open(device);const original=h.state().pending.request,done=h.tasks.get(original.id),other={...device,id:'synthetic-b',task:done};await h.controller.observe(other);assert.equal(h.calls.length,1);assert.equal(h.state().snapshot,null);
 await h.controller.observe({...device,task:done});assert.equal(h.calls.length,2);assert.equal(h.state().page.offset,0);await h.controller.observe({...device,task:done});assert.equal(h.calls.length,2);
});
test('错误任务编号/类型/期限与截断回执拒绝，未知结果保持原号',async()=>{
 for(const field of ['id','type','expires_at','truncated']){const h=harness({behavior:({task})=>{if(field==='truncated')task.result.truncated=true;else task[field]=field==='expires_at'?task.expires_at+1:'wrong';return {task};}});await h.controller.open(device);assert.equal(h.state().snapshot,null);assert.ok(h.state().pending);assert.ok(h.state().error);assert.equal(h.calls.length,1);}
});
test('服务器比较同快照固定元数据，明确入队前拒绝与模糊400严格区分',()=>{
 const open=descriptor(),p=page({offset:0,limit:32});assert.equal(validateContactsPageSnapshot(open,p),true);p.sampled_at_ms++;assert.throws(()=>validateContactsPageSnapshot(open,p));
 for(const [status,value] of [[400,{ok:false,reason:'inflight'}],[404,{ok:false,msg:'未找到该设备'}],[409,{ok:false,msg:'当前客户端尚未接通该任务'}],[400,{ok:false,not_enqueued:true}]])assert.equal(contactsPageSubmissionRejected(status,value),true);
 for(const [status,value] of [[400,{ok:false,msg:'storage failed'}],[404,{ok:false,msg:'未找到该任务'}],[503,{ok:false,not_enqueued:true}],[400,{ok:false,reason:'inflight',task:{id:'created'}}]])assert.equal(contactsPageSubmissionRejected(status,value),false);
});
test('明确拒绝清除未接受意图，只有用户再次操作才新提交；网络未知保持原号',async()=>{
 let reject=true;const h=harness({behavior:({body})=>{if(body&&reject){reject=false;throw Object.assign(Error('inflight'),{submissionRejected:true});}}});await h.controller.open(device);assert.equal(h.state().pending,null);assert.match(h.state().error,/未接受/);assert.equal(h.calls.length,1);await h.controller.resume(device);assert.equal(h.calls.length,1);await h.controller.open(device);assert.equal(h.calls.filter(c=>c.body?.params.action==='open').length,2);assert.notEqual(h.calls[0].body.id,h.calls[1].body.id);assert.equal(h.state().page.offset,0);
});
test('能力必须严格true，双击和并发open不创建第二个任务',async()=>{
 for(const capability of [undefined,false,'true',1]){const h=harness();await h.controller.open({...device,managed_contacts_page_v1:capability});assert.equal(h.calls.length,0);}
 let release;const wait=new Promise(r=>release=r),h=harness({behavior:async({body,task})=>{if(body.params.action==='open'){await wait;return {task};}}});const first=h.controller.open(device);await h.controller.open(device);assert.equal(h.calls.length,1);release();await first;assert.equal(h.calls.filter(c=>c.body.params.action==='open').length,1);
});
test('浏览器源码可独立运行；D31只读分页转义，D22仍显示原读写入口且设备状态隔离',async()=>{
 const context=vm.createContext({TextEncoder,URLSearchParams,Date,performance,crypto,adminSession:{check(){}},setTimeout(){},setInterval(){},document:{getElementById:()=>({})}});vm.runInContext(contactsPagesClientSource+fs.readFileSync(new URL('./devices-client.js',import.meta.url),'utf8'),context);context.renderOps=()=>{};context.MODELS=[];context.DEV=[device,{id:'d22',model_id:'mdl_d22',contacts:{items:[{id:1,name:'D22姓名',phone:'D22号码'}],sampled_at_ms:1000}}];context.selDev=device.id;
 let html=context.pageContacts('');assert.match(html,/LOCAL · 只读/);assert.doesNotMatch(html,/cName|contactAdd|contactEdit|contactDel/);assert.doesNotMatch(html,/暂无联系人/);
 const controller=context.contactsPageController(),state=controller.state(device);state.snapshot=descriptor();state.startedAt=Date.now();state.startedMono=performance.now();state.page=page({offset:0,limit:32});state.page.items[0].mName='<script>alert(1)</script>';state.pageIndex=0;
 html=context.pageContacts('');assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);context.selDev='d22';html=context.pageContacts('');assert.match(html,/contactAdd/);assert.match(html,/D22姓名/);assert.doesNotMatch(html,/LOCAL · 只读|alert\(1\)/);
 let sent;context.enqueueRepair=(type,p)=>{sent={type,p};};context.contactRefresh();assert.equal(sent.type,'contacts_read');context.selDev=device.id;sent=null;context.contactAdd();context.contactEdit(0);context.contactDel(0);assert.equal(sent,null);
 state.snapshot=null;state.page=null;state.invalid=false;context.AbortSignal=AbortSignal;context.fetch=async()=>Response.json({ok:false,reason:'inflight',msg:'已有任务进行中'},{status:400});await context.contactRefresh();assert.equal(state.pending,null);assert.match(state.error,/未接受/);
});
