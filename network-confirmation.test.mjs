import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import worker from './worker.js';
import {fixture,request,login} from './test-support.mjs';
import {enqueueRepairTask,applyRepairProgress,publicRepair,repairOfferPayload,archiveRepair,repairHistory} from './elfRemote/control-plane.js';
import {grantNetworkConfirmation,cancelNetworkTask,holdNetworkTask,networkAcceptanceAllowed} from './network-confirmation.js';
import {systemSettingsParams,systemSettingAllowed} from './system-settings.js';
const apk='a'.repeat(64),token='network-fixture-token',credential=createHash('sha256').update(token).digest('hex');
const params={group:'wifi',action:'set',key:'enabled',value:false,network_transaction:{version:1,apk_sha256:apk,confirm_within_ms:60000}};
async function setup(now=1000){
 const d={id:'network-fixture',model_id:'mdl_d31',token_sha256:credential,managed_system_settings:true,managed_network_confirmation_v1:true,network_write:true};
 await enqueueRepairTask(d,{id:'network-job',type:'system_config',params,expires_at:now+120000},now);
 applyRepairProgress(d,d.task.id,'claimed','',null,now);applyRepairProgress(d,d.task.id,'running','',null,now);
 const binding={task_id:d.task.network.local_task_id,apk_sha256:apk,key:'wifi_enabled',before:true,target:false,boot_id:'00000000-0000-4000-8000-000000000001',started_elapsed:100000,deadline_elapsed:160000,window_ms:60000};
 const data={device_id:d.id,token,task_id:d.task.id,state:'running',action:'network-confirmation',network_confirmation:{version:1,request_digest:d.task.request_digest,...binding,last_elapsed:100500,issued_elapsed:101000,nonce:'00000000-0000-4000-8000-000000000002'}};
 const final={network_transaction:{version:1,status:'CONFIRMED',binding,observed_elapsed:102000,current_enabled:false,cleanup_complete:true,restored:false,confirmation_nonce:data.network_confirmation.nonce}};
 return {d,binding,data,final,now};
}
test('网络参数参与幂等摘要；D22原设置与未知能力不开放',async()=>{
 const {d}=await setup();assert.equal(systemSettingsParams(params).network_transaction.apk_sha256,apk);
 for(const bad of [null,{version:2,apk_sha256:apk,confirm_within_ms:60000},{version:1,apk_sha256:apk,confirm_within_ms:9999}])assert.throws(()=>systemSettingsParams({...params,network_transaction:bad}));
 assert.equal(systemSettingAllowed({...d,model_id:'mdl_d22'},'wifi','enabled'),false);
 assert.equal(systemSettingAllowed({...d,network_write:false},'wifi','enabled'),false);
 assert.equal((await enqueueRepairTask(d,{id:d.task.id,type:'system_config',params:{...params,value:true}},1100)).reason,'idempotency-conflict');
 const exp=d.task.expires_at;assert.equal((await enqueueRepairTask(d,{id:d.task.id,type:'system_config',params,expires_at:999999},1100)).duplicate,true);assert.equal(d.task.expires_at,exp);
 assert.equal(repairOfferPayload(d.task).request_digest,d.task.request_digest);
});
test('同一个忙任务内发放允许，不提前成功、不写自动恢复目标',async()=>{
 const {d,data,final}=await setup();const r=grantNetworkConfirmation(d,d.task,data,1100);assert.equal(r.network_confirmation.decision,'allow');assert.equal(d.task.state,'running');
 assert.equal((await enqueueRepairTask(d,{id:'other',type:'root_exec',params:{command:'id',cwd:'/',timeout:10}},1150)).reason,'inflight');
 applyRepairProgress(d,d.task.id,'success','',final,1200);assert.equal(d.task.state,'success');assert.equal(d.system_targets,undefined);assert.equal(d.system_settings,undefined);
 const publicTask=publicRepair(d.task);assert.equal(publicTask.result.network_transaction.status,'CONFIRMED');assert.equal(JSON.stringify(publicTask).includes(credential),false);
 applyRepairProgress(d,d.task.id,'success','',structuredClone(final),999999);assert.equal(d.task.state,'success');
 assert.throws(()=>applyRepairProgress(d,d.task.id,'success','',{network_transaction:{...final.network_transaction,observed_elapsed:103000}},1300));
});
test('普通HTTP成功或退出码零不是网络成功',async()=>{
 const {d,final}=await setup();assert.throws(()=>applyRepairProgress(d,d.task.id,'success','',{exit_code:0,action:'completed',text:'{}'},1200));
 assert.throws(()=>applyRepairProgress(d,d.task.id,'success','',final,1200));
 assert.equal(d.task.state,'running');
});
test('确认所有绑定字段错配和错误类型均拒绝',async()=>{
 const {d,data}=await setup();grantNetworkConfirmation(d,d.task,data,1100);
 const bad={version:2,request_digest:'b'.repeat(64),task_id:'b'.repeat(64),apk_sha256:'b'.repeat(64),key:'mobile_data',before:false,target:true,boot_id:'00000000-0000-4000-8000-000000000009',started_elapsed:99999,deadline_elapsed:160001,window_ms:59999,last_elapsed:100499.5,issued_elapsed:160000,nonce:'bad'};
 for(const [key,value] of Object.entries(bad))assert.throws(()=>grantNetworkConfirmation(d,d.task,{...data,network_confirmation:{...data.network_confirmation,[key]:value}},1200),key);
 assert.equal(d.task.state,'running');
});
test('新nonce不续期；旧请求时间与改写nonce拒绝',async()=>{
 const {d,data}=await setup();grantNetworkConfirmation(d,d.task,data,1100);const end=d.task.network.confirm_deadline_at;
 assert.deepEqual(grantNetworkConfirmation(d,d.task,data,1200).network_confirmation,d.task.network.receipt);
 assert.throws(()=>grantNetworkConfirmation(d,d.task,{...data,network_confirmation:{...data.network_confirmation,issued_elapsed:102000}},1200));
 const next={...data,network_confirmation:{...data.network_confirmation,issued_elapsed:102000,nonce:crypto.randomUUID()}};
 grantNetworkConfirmation(d,d.task,next,1300);assert.equal(d.task.network.confirm_deadline_at,end);
 assert.throws(()=>grantNetworkConfirmation(d,d.task,{...data,network_confirmation:{...data.network_confirmation,issued_elapsed:103000}},1400));
 assert.throws(()=>grantNetworkConfirmation(d,d.task,data,1400));
 assert.throws(()=>grantNetworkConfirmation(d,d.task,next,end));
});
test('后续poll不撤销先前已发放允许，旧合法nonce的持久提交可补传',async()=>{
 const {d,data,final}=await setup();grantNetworkConfirmation(d,d.task,data,1100);
 grantNetworkConfirmation(d,d.task,{...data,network_confirmation:{...data.network_confirmation,issued_elapsed:103000,nonce:crypto.randomUUID()}},1200);
 applyRepairProgress(d,d.task.id,'success','',final,1300);assert.equal(d.task.state,'success');
});
test('取消先到拒绝确认；允许先到不假承诺撤销',async()=>{
 const first=await setup();assert.equal(cancelNetworkTask(first.d.task),'cancel_requested');assert.throws(()=>grantNetworkConfirmation(first.d,first.d.task,first.data,1100));
 const last=await setup();grantNetworkConfirmation(last.d,last.d.task,last.data,1100);assert.equal(cancelNetworkTask(last.d.task),'confirmation_already_issued');assert.equal(last.d.task.cancel_requested,undefined);
 applyRepairProgress(last.d,last.d.task.id,'success','',last.final,1200);assert.equal(last.d.task.state,'success');
});
test('先恢复或截止相等不得提交，清理未完成不结束忙槽',async()=>{
 const {d,data,final}=await setup();grantNetworkConfirmation(d,d.task,data,1100);
 assert.throws(()=>applyRepairProgress(d,d.task.id,'success','',{network_transaction:{...final.network_transaction,observed_elapsed:160000}},1200));
 const pending={network_transaction:{...final.network_transaction,cleanup_complete:false}};applyRepairProgress(d,d.task.id,'running','',pending,1200);assert.equal(holdNetworkTask(d.task),true);
 applyRepairProgress(d,d.task.id,'success','',final,1300);assert.equal(holdNetworkTask(d.task),false);
 const rolled=await setup();const result={network_transaction:{...rolled.final.network_transaction,status:'ROLLED_BACK',current_enabled:true,restored:true}};delete result.network_transaction.confirmation_nonce;
 applyRepairProgress(rolled.d,rolled.d.task.id,'failed','',result,1200);assert.throws(()=>grantNetworkConfirmation(rolled.d,rolled.d.task,rolled.data,1300));
});
test('任务归档保留绑定，未知状态和重新安装不伪造成功',async()=>{
 const {d,data,final}=await setup();grantNetworkConfirmation(d,d.task,data,1100);const rows=new Map();const store={get:async k=>rows.get(k),put:async(k,v)=>rows.set(k,structuredClone(v)),list:async()=>rows,delete:async k=>rows.delete(k)};
 applyRepairProgress(d,d.task.id,'success','',final,1200);await archiveRepair(store,d,1300);const archived=[...rows.values()][0];assert.ok(archived.params.network_transaction);assert.equal(archived.network.credential_sha,credential);
 const restored={...d,task:structuredClone(archived),token_sha256:'new-token'};assert.throws(()=>applyRepairProgress(restored,archived.id,'success','',final,1500));
});
test('验收白名单只匹配D31、候选APK和短期截止，不开放普通UI',async()=>{
 const {d}=await setup();d.network_write=false;const allow=JSON.stringify({device_id:d.id,apk_sha256:apk,expires_at:5000});
 assert.equal(networkAcceptanceAllowed(d,params,allow,1000),true);assert.equal(systemSettingAllowed(d,'wifi','enabled'),false);
 for(const [dev,p,at] of [[{...d,id:'other'},params,1000],[{...d,model_id:'mdl_d22'},params,1000],[d,{...params,network_transaction:{...params.network_transaction,apk_sha256:'b'.repeat(64)}},1000],[d,params,5000]])assert.equal(networkAcceptanceAllowed(dev,p,allow,at),false);
});
test('网络开始前明确拒绝可收尾，普通rejected/null或发放允许后不得伪装未开始',async()=>{
 const {d,data}=await setup();assert.throws(()=>applyRepairProgress(d,d.task.id,'rejected','',null,1100));
 const r={network_transaction:{version:1,status:'NOT_STARTED',binding:null,mutation_started:false,cleanup_complete:true,restored:false,current_enabled:null,observed_elapsed:101000}};
 applyRepairProgress(d,d.task.id,'rejected','',r,1100);assert.equal(d.task.state,'rejected');assert.ok(d.task.completed_at);applyRepairProgress(d,d.task.id,'rejected','',r,1200);
 const issued=await setup();grantNetworkConfirmation(issued.d,issued.d.task,issued.data,1100);assert.throws(()=>applyRepairProgress(issued.d,issued.d.task.id,'rejected','',r,1200));
});
test('重新安装归档的未决网络任务超过30天仍保留，实际终态可正常到期',async()=>{
 const {d}=await setup();d.task.state='expired';d.task.completed_at=new Date(1000).toISOString();
 const rows=new Map([['repair-history/network-fixture/network-job',structuredClone(d.task)]]);const store={list:async()=>rows};
 assert.equal((await repairHistory(store,d.id,1000+31*86400000)).length,1);
 d.task.network.result={status:'NOT_STARTED',cleanup_complete:true};rows.set('repair-history/network-fixture/network-job',d.task);
 assert.equal((await repairHistory(store,d.id,1000+31*86400000)).length,0);
});
test('真实Worker路由确认/取消/重传/历史校验，DO持久数据恢复',async()=>{
 const s=await setup(Date.now()),f=fixture({admin_pass:'fixture-password',remote_devices:[s.d]}),cookie=await login(f);
 const call=(path,body,auth)=>worker.fetch(request(path,'POST',body,auth),f.env);
 assert.equal((await call('/api/elfremote/task-progress',{...s.data,token:'wrong'})).status,401);
 let r=await call('/api/elfremote/task-progress',s.data);assert.equal(r.status,200);assert.equal((await r.json()).network_confirmation.decision,'allow');
 r=await call('/api/elfremote/task',{device_id:s.d.id,action:'cancel',task_id:s.d.task.id},cookie);assert.equal((await r.json()).cancel_outcome,'confirmation_already_issued');
 const saved=structuredClone(f.data.get('remote_devices'));const f2=fixture({admin_pass:'fixture-password',remote_devices:saved});
 r=await worker.fetch(request('/api/elfremote/task-progress','POST',{device_id:s.d.id,token,task_id:s.d.task.id,state:'success',result:s.final}),f2.env);assert.equal(r.status,200,await r.clone().text());
 assert.equal(f2.data.get('remote_devices')[0].task.state,'success');
});
test('真实报告过期与新任务下发均保留未决网络原号，缺能力报告关闭写门',async()=>{
 const s=await setup(Date.now()-200000),f=fixture({admin_pass:'fixture-password',remote_devices:[s.d]}),cookie=await login(f);
 const report=await worker.fetch(request('/api/devices/report','POST',{device_id:s.d.id,token,status_only:true,report_id:crypto.randomUUID(),network:'ethernet',managed_system_settings:true}),f.env);
 assert.equal(report.status,200,await report.clone().text());assert.equal(f.data.get('remote_devices')[0].task.state,'running');assert.ok(f.data.get('remote_devices')[0].task.params.network_transaction);assert.equal(f.data.get('remote_devices')[0].network_write,false);
 const newTask=await worker.fetch(request('/api/elfremote/task','POST',{device_id:s.d.id,id:'other-network-job',type:'system_config',params:{group:'time',action:'read'}},cookie),f.env);
 assert.equal(newTask.status,400);assert.equal((await newTask.json()).reason,'inflight');
});
