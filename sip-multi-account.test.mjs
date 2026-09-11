import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import worker from './worker.js';
import source from './devices-client-source.js';
import {fixture,request,login} from './test-support.mjs';
import {sipAccountParams,enqueueRepairTask,applyRepairProgress,queueSipRestore,publicRepair} from './elfRemote/control-plane.js';
import {normalizeSipTargets,applySipRegistrations,publicSipAccounts,sipKey,checkSipTarget} from './sip-accounts.js';
import {panelRefreshDelay} from './panel-events.js';
const targets=[{target:'nexui',label:'Nexui 电话',auth_username_supported:true,accounts:[{account_id:'line-a',label:'线路一'},{account_id:'line-b',label:'线路二'}]},{target:'quik',label:'QUIK 短信',auth_username_supported:false,accounts:[{account_id:'default',label:'短信账号'}]}];
const params={target:'nexui',account_id:'line-a',server:'sip.example.invalid',username:'fixture',password:'synthetic=!@',transport:'tls',realm:'example.invalid'};
const make=()=>({id:'fixture',paired:true,status_only:true,enabled:true,network:'ethernet',managed_sip_account:true,sip_targets:normalizeSipTargets(targets),token_sha256:'installation-a'});
const evidence=(p=params)=>({target:p.target,account_id:p.account_id,applied:true,action:'completed',exit_code:0});
async function harness(){
 const token='synthetic-device-token',d=make();d.token_sha256=createHash('sha256').update(token).digest('hex');delete d.sip_targets;
 const f=fixture({admin_pass:'fixture-password',remote_devices:[d]}),cookie=await login(f);
 const call=(path,body,auth=cookie)=>worker.fetch(request(path,body===undefined?'GET':'POST',body,auth),f.env);
 const report=body=>call('/api/devices/report',{device_id:d.id,token,status_only:true,managed_sip_account:true,network:'ethernet',report_id:crypto.randomUUID(),reported_at:new Date().toISOString(),...body},null);
 const progress=(id,state,result,detail)=>call('/api/elfremote/task-progress',{device_id:d.id,token,task_id:id,state,result,detail},null);
 const queue=(id,p=params)=>call('/api/elfremote/task',{device_id:d.id,id,type:'configure_sip',params:p});
 const list=async()=> (await (await call('/api/devices')).json()).devices[0];
 return {f,call,report,progress,queue,list};
}
test('SIP真实接口从声明到领取和保存，Nexui两线路与QUIK互不覆盖，配置成功不冒充注册成功',async()=>{
 const h=await harness();assert.equal((await h.report({sip_targets:targets})).status,200);
 assert.equal((await h.list()).sip_accounts.length,3);
 for(const [i,dest] of [{target:'nexui',account_id:'line-a'},{target:'nexui',account_id:'line-b'},{target:'quik',account_id:'default'}].entries()){
  const p={...params,...dest,password:'synthetic-secret-'+i},id='sip-fixture-'+i;
  assert.equal((await h.queue(id,p)).status,200);
  const offer=await (await h.report({sip_targets:targets})).json();assert.equal(offer.managed_task.id,id);assert.equal(offer.managed_task.params.account_id,p.account_id);assert.equal(offer.managed_task.params.password,p.password);
  assert.equal((await h.progress(id,'claimed')).status,200);assert.equal((await h.progress(id,'running')).status,200);
  assert.equal((await h.progress(id,'success',evidence(p))).status,200);
  const visible=await h.list(),a=visible.sip_accounts.find(a=>sipKey(a)===sipKey(p));
  assert.equal(a.configuration_result.state,'success');assert.equal(a.registration,null);
  const stored=h.f.data.get('remote_devices')[0];assert.equal(stored.account_configs[sipKey(p)].params.password,p.password);
  assert.equal(stored.account_configs.linphone,undefined);assert.deepEqual(stored.task.params,{});
 }
 assert.equal(Object.keys(h.f.data.get('remote_devices')[0].account_configs).length,3);
 const now=Date.now();assert.equal((await h.report({sip_targets:targets,sip_registrations:[{target:'nexui',account_id:'line-a',state:'registered',sampled_at:now,config_task_id:'sip-fixture-0'},{target:'nexui',account_id:'line-b',state:'failed',reason:'认证被拒绝',sampled_at:now,config_task_id:'sip-fixture-1'}]})).status,200);
 const visible=await h.list();assert.equal(visible.sip_accounts[0].registration.fresh,true);assert.equal(visible.sip_accounts[1].registration.state,'failed');assert.equal(visible.sip_accounts[2].registration,null);
 const text=JSON.stringify(visible)+await (await h.call('/api/elfremote/tasks?device_id=fixture')).text();assert.doesNotMatch(text,/synthetic-secret|installation_sha|token_sha256/);
});
test('SIP目标成对、实际槽位、独立认证账号与realm严格校验，旧D22参数不扩写',async()=>{
 const d=make();for(const patch of [{target:undefined},{account_id:undefined},{target:'other'},{account_id:'bad:slot'},{realm:'a\n[config]'}])assert.throws(()=>sipAccountParams({...params,...patch}));
 const legacy={...params};delete legacy.target;delete legacy.account_id;delete legacy.realm;assert.equal(sipAccountParams(legacy).target,undefined);
 assert.throws(()=>checkSipTarget(d,legacy));assert.throws(()=>checkSipTarget(d,{...params,account_id:'missing'}));
 assert.throws(()=>checkSipTarget(d,{...params,target:'quik',account_id:'default',auth_username:'different'}));
 checkSipTarget(d,{...params,target:'quik',account_id:'default',auth_username:params.username});
 assert.throws(()=>normalizeSipTargets([targets[0],targets[0]]));assert.throws(()=>normalizeSipTargets([{...targets[0],accounts:[targets[0].accounts[0],targets[0].accounts[0]]}]));
 const h=await harness();await h.report({sip_targets:targets});
 for(const p of [legacy,{...params,account_id:'missing'},{...params,target:'quik',account_id:'default',auth_username:'different'}])assert.equal((await h.queue('bad-task',p)).status,409);
 const before=structuredClone(h.f.data.get('remote_devices'));assert.equal((await h.report({sip_targets:[{target:'quik',accounts:[{account_id:'bad:id'}]}]})).status,400);assert.deepEqual(h.f.data.get('remote_devices'),before);
});
test('SIP任务去重包含目标、线路与realm；错误回执拒绝、重复成功不改结果',async()=>{
 const h=await harness();await h.report({sip_targets:targets});assert.equal((await h.queue('sip-id')).status,200);
 assert.equal((await (await h.queue('sip-id')).json()).duplicate,true);
 for(const p of [{...params,account_id:'line-b'},{...params,target:'quik',account_id:'default'},{...params,realm:'changed.invalid'}])assert.equal((await h.queue('sip-id',p)).status,400);
 await h.progress('sip-id','claimed');await h.progress('sip-id','running');
 for(const r of [{...evidence(),account_id:'line-b'},{...evidence(),target:'quik'},{...evidence(),applied:false},{...evidence(),exit_code:1}])assert.equal((await h.progress('sip-id','success',r)).status,400);
 assert.equal((await h.progress('sip-id','failed',{target:'quik',account_id:'default'})).status,400);
 assert.equal((await h.progress('sip-id','success',evidence())).status,200);
 const original=structuredClone(h.f.data.get('remote_devices')[0].task);await h.progress('sip-id','success',{...evidence(),text:'late result'});assert.deepEqual(h.f.data.get('remote_devices')[0].task,original);
});
test('SIP失败保留原配置，公开任务/历史/注册原因去掉已知密码与任意载荷',async()=>{
 const h=await harness();await h.report({sip_targets:targets});await h.queue('good');await h.progress('good','claimed');await h.progress('good','running');await h.progress('good','success',evidence());
 const old=structuredClone(h.f.data.get('remote_devices')[0].account_configs);
 const p={...params,password:'another=secret!'};await h.queue('bad',p);await h.progress('bad','claimed');
 const bad={target:p.target,account_id:p.account_id,text:p.password,reason:params.password,stage:p.password,action:p.password,artifact:{password:p.password}};
 assert.equal((await h.progress('bad','failed',bad,p.password)).status,200);
 assert.deepEqual(h.f.data.get('remote_devices')[0].account_configs,old);
 await h.progress('bad','failed',{...bad,text:'repeat '+p.password});
 await h.report({sip_targets:targets,sip_registrations:[{target:params.target,account_id:params.account_id,state:'failed',reason:encodeURIComponent(params.password),sampled_at:Date.now(),config_task_id:'good'}]});
 await h.queue('next',{...params,account_id:'line-b'});
 const text=JSON.stringify(await h.list())+await (await h.call('/api/elfremote/tasks?device_id=fixture')).text();for(const secret of [p.password,params.password,encodeURIComponent(params.password)])assert.ok(!text.includes(secret));
 assert.equal((await h.list()).sip_accounts[0].configuration_result.state,'failed');
});
test('各账号注册采样独立，旧配置和旧采样不覆盖、离线过期和新安装不冒充在线注册',()=>{
 const d=make(),now=2000000,key=sipKey(params);d.account_configs={[key]:{params,config_task_id:'new-task'}};
 const row={target:params.target,account_id:params.account_id,state:'registered',sampled_at:now,config_task_id:'new-task'};
 applySipRegistrations(d,[row],now);assert.equal(publicSipAccounts(d,true,now)[0].registration.fresh,true);
 for(const patch of [{config_task_id:'old-task',sampled_at:now+1},{sampled_at:now-1},{sampled_at:now}]){applySipRegistrations(d,[{...row,...patch,state:'failed'}],now);assert.equal(d.sip_registrations[key].state,'registered');}
 assert.throws(()=>applySipRegistrations(d,[{...row,sampled_at:now+60001}],now));assert.throws(()=>applySipRegistrations(d,[row,row],now));
 assert.equal(publicSipAccounts(d,false,now)[0].registration.fresh,false);assert.equal(publicSipAccounts(d,true,now+990000)[0].registration.fresh,false);
 d.token_sha256='installation-b';assert.equal(publicSipAccounts(d,true,now)[0].registration.fresh,false);
 applySipRegistrations(d,[{...row,sampled_at:now-1}],now);assert.equal(publicSipAccounts(d,true,now)[0].registration.fresh,true);
 d.account_configs[key].config_task_id='newer-task';assert.equal(publicSipAccounts(d,true,now)[0].registration.fresh,false);
 applySipRegistrations(d,[{...row,config_task_id:'newer-task',sampled_at:now-2}],now);assert.equal(publicSipAccounts(d,true,now)[0].registration.fresh,true);
 assert.equal(panelRefreshDelay([d],[],now+990000-5000-2),5000);
});
test('多账号刷后恢复逐槽位处理，撤销槽位不恢复，失败有界重试，D22旧存储不串入',async()=>{
 const d=make(),f=fixture(),now=Date.now();d.account_configs={linphone:{params:{...params,target:undefined,account_id:undefined},applied_token_sha:'old'}};
 for(const p of [params,{...params,account_id:'line-b'},{...params,target:'quik',account_id:'default'}])d.account_configs[sipKey(p)]={params:p,applied_token_sha:'old'};
 for(const p of [params,{...params,account_id:'line-b'},{...params,target:'quik',account_id:'default'}]){
  assert.equal(await queueSipRestore(d,f.storage,now),true);assert.deepEqual(d.task.sip_destination,{target:p.target,account_id:p.account_id});assert.equal(d.task.managed_exec_v1,true);
  assert.equal(await queueSipRestore(d,f.storage,now),false);
  applyRepairProgress(d,d.task.id,'claimed','',null,now);applyRepairProgress(d,d.task.id,'running','',null,now);applyRepairProgress(d,d.task.id,'success','',evidence(p),now);
 }
 assert.equal(await queueSipRestore(d,f.storage,now),false);d.token_sha256='installation-next';d.sip_targets=[];assert.equal(await queueSipRestore(d,f.storage,now),false);
 d.sip_targets=normalizeSipTargets([targets[1]]);
 for(const offset of [0,300000,2100000]){assert.equal(await queueSipRestore(d,f.storage,now+offset),true);applyRepairProgress(d,d.task.id,'claimed','',null,now+offset);applyRepairProgress(d,d.task.id,'failed','临时故障',{target:'quik',account_id:'default'},now+offset);}
 assert.equal(await queueSipRestore(d,f.storage,now+100000000),false);
});
function browser(){const c=vm.createContext({Date,adminSession:{check(){}},setTimeout(){},setInterval(){}});vm.runInContext(source,c);return c;}
test('SIP页面只显示声明账号、分别呈现失败和过期；切换预填互不串用并转义名称',()=>{
 const d=make();d.online=true;d.sip_accounts=publicSipAccounts(d,true);d.sip_accounts[0].label='<script>fixture</script>';d.sip_accounts[1].configuration={server:'second.invalid',username:'second'};
 d.sip_accounts[1].registration={state:'failed',reason:'认证失败',fresh:true,sampled_at:Date.now()};
 const c=browser();c.DEV=[d];c.selDev=d.id;c.renderOps=()=>{};
 let html=c.pageSipAccount('');assert.match(html,/SIP|配置账号/);assert.match(html,/注册失败/);assert.doesNotMatch(html,/<script>fixture/);assert.match(html,/sipAccountAuth/);
 c.selectSipAccount(1);html=c.pageSipAccount('');assert.match(html,/value="second.invalid"/);assert.equal(c.uiOf().sipSelection,'nexui|line-b');
 c.selectSipAccount(2);html=c.pageSipAccount('');assert.doesNotMatch(html,/sipAccountAuth|second.invalid/);
 d.online=false;assert.match(c.pageSipAccount(''),/设备离线，注册状态待确认/);
 delete d.sip_targets;delete d.sip_accounts;assert.match(c.pageSipAccount(''),/保存并登录/);
 d.sip_targets=[];d.sip_accounts=[];assert.match(c.pageSipAccount(''),/尚未开放/);
});

test('撤销或缺少SIP槽位声明时不领取旧多账号任务，非status_only路径同样受约束',async()=>{
 for(const status_only of [true,false]){
  const h=await harness();await h.report({sip_targets:targets});await h.queue('sip-revoke');
  for(const capability of [{sip_targets:[]},{}]){
   const body=await (await h.report({...capability,status_only})).json();assert.equal(body.managed_task,undefined);assert.equal(body.task,undefined);
  }
 }
});
test('新配置未完成时旧注册样本不显示为当前注册成功',async()=>{
 const d=make(),now=Date.now(),f=fixture();d.account_configs={[sipKey(params)]:{params,config_task_id:'previous'}};
 applySipRegistrations(d,[{target:params.target,account_id:params.account_id,state:'registered',sampled_at:now,config_task_id:'previous'}],now);
 assert.equal(publicSipAccounts(d,true,now)[0].registration.fresh,true);
 await enqueueRepairTask(d,{id:'new-config',type:'configure_sip',params},now,f.storage);
 assert.equal(publicSipAccounts(d,true,now)[0].registration.fresh,false);
 assert.equal(publicRepair(d.task).type_label,'配置SIP账号');
});
test('列表刷新后槽位移除不会把旧账号表单内容或选择索引套在新账号上',async()=>{
 const d=make();d.sip_accounts=publicSipAccounts(d,true);const c=browser();c.DEV=[d];c.selDev=d.id;c.renderOps=()=>{};c.selectSipAccount(0);
 const nodes={sipAccountSlot:{id:'sipAccountSlot',value:'0'},sipAccountServer:{id:'sipAccountServer',value:'draft-first.invalid'},sipAccountPassword:{id:'sipAccountPassword',value:'draft-password'}};
 const ops={querySelectorAll:()=>Object.values(nodes),contains:()=>false};c.document={getElementById:id=>id==='devOps'?ops:nodes[id],activeElement:null};
 for(const name of ['renderList','updateReportFeedback','renderMap','setServiceError'])c[name]=()=>{};
 c.renderOps=()=>{c.selectedSipAccount();nodes.sipAccountSlot.value='0';nodes.sipAccountServer.value='second.invalid';nodes.sipAccountPassword.value='';};
 const next=structuredClone(d);next.sip_targets[0].accounts.shift();next.sip_accounts.shift();
 c.fetch=async()=>({ok:true,json:async()=>({devices:[next],models:[],refresh_after_ms:300000})});
 assert.equal(await c.loadDevices(),true);assert.equal(nodes.sipAccountServer.value,'second.invalid');assert.equal(nodes.sipAccountPassword.value,'');assert.equal(c.uiOf().sipSelection,'nexui|line-b');
 nodes.sipAccountServer.value='draft-second.invalid';nodes.sipAccountPassword.value='second-draft';assert.equal(await c.loadDevices(),true);
 assert.equal(nodes.sipAccountServer.value,'draft-second.invalid');assert.equal(nodes.sipAccountPassword.value,'second-draft');
});
test('编辑过程中原账号被撤销，提交旧表单不会误配置自动选中的下一账号',async()=>{
 const d=make();d.sip_accounts=publicSipAccounts(d,true);const c=browser();c.DEV=[d];c.selDev=d.id;c.selectedSipAccount();
 d.sip_accounts.shift();d.sip_targets[0].accounts.shift();let sent=0,rendered=0;
 const form={dataset:{sipSelection:'nexui|line-a'}},feedback={};c.document={getElementById:id=>id==='sipAccountForm'?form:feedback};c.renderOps=()=>rendered++;c.fileApi=()=>sent++;
 await c.configureMultiSipAccount({preventDefault(){}});assert.equal(sent,0);assert.equal(rendered,1);assert.match(feedback.textContent,/账号列表已变化/);
});
