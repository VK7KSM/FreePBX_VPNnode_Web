import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import worker from './worker.js';
import source from './devices-client-source.js';
import {fixture,request,login} from './test-support.mjs';
import {sipAccountParams} from './elfRemote/control-plane.js';
import {normalizeSipTargets,publicSipAccounts,sipKey} from './sip-accounts.js';

const target={target:'gateway',label:'Pixel 网关',auth_username_supported:false,accounts:[{account_id:'primary',label:'主网关账号'}]};
const keep={target:'gateway',account_id:'primary',server:'sip.example.invalid',username:'888',transport:'tls',port:5061,realm:'example.invalid',keep_password:true};
const evidence={target:'gateway',account_id:'primary',applied:true,action:'completed',exit_code:0};

test('Gateway只接受primary单账号声明，D22和D31既有目标保持兼容',()=>{
  assert.deepEqual(normalizeSipTargets([target])[0],target);
  for(const bad of [
    {...target,auth_username_supported:true},
    {...target,accounts:[{account_id:'other'}]},
    {...target,accounts:[{account_id:'primary'},{account_id:'other'}]}
  ])assert.throws(()=>normalizeSipTargets([bad]),/Gateway/);
  assert.equal(normalizeSipTargets([{target:'linphone',accounts:[{account_id:'main'}]}])[0].target,'linphone');
  assert.equal(normalizeSipTargets([{target:'nexui',auth_username_supported:true,accounts:[{account_id:'line-a'}]}])[0].auth_username_supported,true);
  assert.equal(normalizeSipTargets([{target:'quik',auth_username_supported:false,accounts:[{account_id:'default'}]}])[0].target,'quik');
});

test('Gateway密码必须在新密码和保留现有密码中二选一，普通目标合同不变',()=>{
  assert.deepEqual(sipAccountParams(keep),keep);
  const password={...keep,password:'synthetic-secret'};delete password.keep_password;
  assert.equal(sipAccountParams(password).password,'synthetic-secret');
  for(const bad of [
    {...keep,password:'synthetic-secret'},
    {...keep,keep_password:false},
    {...keep,keep_password:undefined},
    {...keep,password:undefined,keep_password:undefined},
    {...keep,auth_username:'888'},
    {...keep,account_id:'other'},
    {...keep,transport:'tcp'}
  ])assert.throws(()=>sipAccountParams(bad));
  const d31={target:'nexui',account_id:'line-a',server:'sip.example.invalid',username:'100',auth_username:'auth100',password:'secret',transport:'tcp',port:5060};
  assert.equal(sipAccountParams(d31).auth_username,'auth100');
  assert.throws(()=>sipAccountParams({...d31,keep_password:true}));
  const d22={server:'sip.example.invalid',username:'100',password:'secret',transport:'tls'};
  assert.equal(sipAccountParams(d22).port,5061);
});

async function harness(){
  const token='gateway-device-token',device={id:'gateway-fixture',paired:true,status_only:true,enabled:true,network:'wifi',managed_sip_account:true,token_sha256:createHash('sha256').update(token).digest('hex')};
  const f=fixture({admin_pass:'fixture-password',remote_devices:[device]}),cookie=await login(f);
  const call=(path,body,auth=cookie)=>worker.fetch(request(path,body===undefined?'GET':'POST',body,auth),f.env);
  const report=body=>call('/api/devices/report',{device_id:device.id,token,status_only:true,managed_sip_account:true,sip_targets:[target],network:'wifi',report_id:crypto.randomUUID(),reported_at:new Date().toISOString(),...body},null);
  const progress=(id,state,result,detail)=>call('/api/elfremote/task-progress',{device_id:device.id,token,task_id:id,state,result,detail},null);
  const queue=(id,params=keep)=>call('/api/elfremote/task',{device_id:device.id,id,idempotency_key:id,type:'configure_sip',expires_at:Date.now()+60000,params});
  const list=async()=> (await (await call('/api/devices')).json()).devices[0];
  return {f,call,report,progress,queue,list};
}

test('Gateway保留密码同值任务经原队列即时领取、严格回执并公开配置和注册状态',async()=>{
  const h=await harness();assert.equal((await h.report()).status,200);
  const queued=await h.queue('gateway-keep');assert.equal(queued.status,200);assert.doesNotMatch(await queued.text(),/keep_password|password/);
  const offered=await (await h.report()).json();assert.equal(offered.managed_task.id,'gateway-keep');assert.equal(offered.managed_task.idempotency_key,'gateway-keep');assert.equal(offered.managed_task.params.keep_password,true);assert.ok(offered.managed_task.expires_at>Date.now());
  await h.progress('gateway-keep','claimed');await h.progress('gateway-keep','running');
  assert.equal((await h.progress('gateway-keep','success',{...evidence,account_id:'other'})).status,400);
  assert.equal((await h.progress('gateway-keep','success',evidence)).status,200);
  const sampled=Date.now();await h.report({sip_registrations:[{target:'gateway',account_id:'primary',state:'registered',sampled_at:sampled,config_task_id:'gateway-keep'}]});
  const visible=await h.list(),account=visible.sip_accounts[0];
  assert.deepEqual(account.configuration,{server:keep.server,username:keep.username,transport:'tls',port:5061,realm:keep.realm,updated_at:account.configuration.updated_at});
  assert.equal(account.configuration_result.state,'success');assert.equal(account.registration.state,'registered');assert.equal(account.registration.fresh,true);
  const stored=h.f.data.get('remote_devices')[0].account_configs[sipKey(keep)];assert.equal(stored.params.keep_password,true);assert.equal(stored.params.password,undefined);assert.equal(stored.config_task_id,'gateway-keep');
});

test('Gateway新密码只交付设备，终态脱敏且保留密码事务不会清除已有私密密码',async()=>{
  const h=await harness();await h.report();const secret='gateway-private-secret';
  const fresh={...keep,password:secret};delete fresh.keep_password;
  let response=await h.queue('gateway-secret',fresh);assert.doesNotMatch(await response.text(),new RegExp(secret));
  let offered=await (await h.report()).json();assert.equal(offered.managed_task.params.password,secret);
  await h.progress('gateway-secret','claimed');await h.progress('gateway-secret','running');await h.progress('gateway-secret','success',evidence);
  let stored=h.f.data.get('remote_devices')[0].account_configs[sipKey(keep)];assert.equal(stored.params.password,secret);
  response=await h.queue('gateway-preserve',keep);assert.doesNotMatch(await response.text(),new RegExp(secret));
  await h.progress('gateway-preserve','claimed');await h.progress('gateway-preserve','running');
  await h.progress('gateway-preserve','success',{...evidence,text:secret,reason:encodeURIComponent(secret)},secret);
  stored=h.f.data.get('remote_devices')[0].account_configs[sipKey(keep)];assert.equal(stored.params.password,secret);assert.equal(stored.params.keep_password,undefined);assert.equal(stored.config_task_id,'gateway-preserve');
  const publicText=JSON.stringify(await h.list())+await (await h.call('/api/elfremote/tasks?device_id=gateway-fixture')).text();assert.ok(!publicText.includes(secret));assert.ok(!publicText.includes(encodeURIComponent(secret)));
});

function browser(){const c=vm.createContext({Date,adminSession:{check(){}},setTimeout(){},setInterval(){},crypto:{randomUUID:()=> '00000000-0000-4000-8000-000000000001'}});vm.runInContext(source,c);return c;}
test('Gateway账号页显示完整公开配置并默认保留密码，提交不携带密码',async()=>{
  const d={id:'pixel',enabled:true,online:true,managed_sip_account:true,sip_targets:normalizeSipTargets([target]),task:{state:''},network:'wifi'};
  d.sip_accounts=publicSipAccounts({...d,account_configs:{[sipKey(keep)]:{params:keep,updated_at:'2026-09-16T00:00:00Z'}}},true);
  const c=browser();c.DEV=[d];c.selDev=d.id;c.MODELS=[];c.UI[d.id]={accountTab:'Gateway'};c.renderOps=()=>{};
  assert.equal(c.gatewayFunctionAvailable(d,'wifi'),true);c.SYSTEM_TAB='账号配置';assert.match(c.pageSystem(''),/账号配置/);
  const html=c.pageAccountSettings('');assert.match(html,/Pixel 网关/);assert.match(html,/主网关账号/);assert.match(html,/sip\.example\.invalid/);assert.match(html,/888/);assert.match(html,/TLS · 5061/);assert.match(html,/realm · example\.invalid/);assert.match(html,/id="sipKeepPassword" type="checkbox" checked/);assert.match(html,/id="sipAccountPassword"[^>]* disabled/);
  assert.doesNotMatch(html,/<option value="tcp"/);
  const button={disabled:false,isConnected:true},nodes={
    sipAccountForm:{dataset:{sipSelection:'gateway|primary'},querySelector:()=>button},sipAccountServer:{value:keep.server},sipAccountUser:{value:keep.username},sipAccountPassword:{value:'',disabled:true},sipAccountTransport:{value:'tls'},sipAccountPort:{value:'5061'},sipAccountRealm:{value:keep.realm},sipKeepPassword:{checked:true},sipAccountFeedback:{textContent:''}
  };
  c.document={getElementById:id=>nodes[id]||null};let sent;c.fileApi=async(path,body)=>{sent={path,body};};c.loadDevices=()=>{};
  await c.configureMultiSipAccount({preventDefault(){}});assert.equal(sent.path,'/api/elfremote/task');assert.equal(sent.body.params.keep_password,true);assert.equal(Object.hasOwn(sent.body.params,'password'),false);
});
