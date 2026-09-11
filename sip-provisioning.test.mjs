import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';
import {fixture,request,login} from './test-support.mjs';
import {managedSipParams,sipDirectory} from './sip-provisioning.js';
const bundle={extensions:[{ext:'101',name:'电话',sms:false},{ext:'102',name:'短信',sms:true},{ext:'103',sms:true}],groups:[],gateways:[],secrets:{101:'fixture-one',102:'fixture-two'}};
const targets=[{target:'nexui',accounts:[1,2,3,4].map(n=>({account_id:'line-'+n}))},{target:'quik',accounts:[{account_id:'default'}]}];
test('管理目录不返回密码；短信权限和未设置密码分别显示',()=>{
 const rows=sipDirectory(bundle);assert.equal(rows.length,3);assert.equal(rows[0].sms,false);assert.equal(rows[2].available,false);
 assert.doesNotMatch(JSON.stringify(rows),/fixture-one|fixture-two|password/);
});
test('管理分机仅服务端解析，拒绝第三方覆盖、网关、无密码及无短信权限分机',()=>{
 const p={source:'managed',target:'quik',account_id:'default',extension:'102'};
 assert.equal(managedSipParams(p,bundle).password,'fixture-two');
 for(const patch of [{extension:'101'},{extension:'103'},{extension:'300'},{server:'foreign.invalid'},{target:'linphone'},{source:'other'}])assert.throws(()=>managedSipParams({...p,...patch},bundle));
});
test('已鉴权路由一键配置Nexui四槽位及QUIK，公共结果不泄露密码，未声明线路拒绝',async()=>{
 const f=fixture({admin_pass:'fixture-password',sip_extensions:bundle.extensions,sip_groups:[],sip_gateways:[],sip_secrets:bundle.secrets,
   remote_devices:[{id:'fixture',paired:true,enabled:true,status_only:true,managed_sip_account:true,sip_targets:targets}]}),cookie=await login(f);
 const call=(path,body,auth=cookie)=>worker.fetch(request(path,body===undefined?'GET':'POST',body,auth),f.env);
 assert.notEqual((await call('/api/devices/sip-directory',undefined,null)).status,200);
 const directory=await (await call('/api/devices/sip-directory')).text();assert.doesNotMatch(directory,/fixture-one|fixture-two/);
 const send=async(target,account_id,extension,id)=>call('/api/elfremote/task',{device_id:'fixture',type:'configure_sip',id,params:{source:'managed',target,account_id,extension}});
 assert.equal((await send('nexui','line-5','101','invalid')).status,409);
 for(const [i,dest] of [...targets[0].accounts.map(a=>['nexui',a.account_id,'101']),['quik','default','102']].entries()){
   const response=await send(...dest,'managed-'+i);assert.equal(response.status,200,await response.clone().text());
   assert.doesNotMatch(await response.text(),/fixture-one|fixture-two/);
   const d=f.data.get('remote_devices')[0];assert.equal(d.task.params.server,'sip.elfradio.net');assert.equal(d.task.params.password,dest[0]==='quik'?'fixture-two':'fixture-one');
   assert.equal(d.task.params.account_id,dest[1]);d.task.state='failed';f.data.set('remote_devices',[d]);
 }
});
