import test from 'node:test';
import assert from 'node:assert/strict';
import {systemSettingsParams,applySystemSettingsResult,systemSettingAllowed} from './system-settings.js';
import {enqueueRepairTask,applyRepairProgress,publicRepair,queueSystemRestore} from './elfRemote/control-plane.js';

test('系统配置拒绝错误类型、越界值与未声明的操作',()=>{
  for(const p of [{group:'sound',action:'set',key:'brightness',value:256},{group:'network',action:'set',key:'mobile_data',value:'false'},{group:'apps',action:'set',key:'enabled',value:false},{group:'time',action:'set',key:'timezone',value:'not-a-zone'},{group:'wifi',action:'set',key:'connect',value:{ssid:'test',password:'bad'}},{group:'network',action:'set',key:'hotspot',value:{enabled:true,ssid:'test',password:''}}])assert.throws(()=>systemSettingsParams(p));
  assert.equal(systemSettingsParams({group:'wifi',action:'set',key:'connect',value:{ssid:'test',password:''}}).value.ssid,'test');
});

test('系统配置要求匹配的真实读回；密码不进入公开任务，重复回执可以确认',async()=>{
  const device={};await enqueueRepairTask(device,{id:'settings-test',type:'system_config',params:{group:'wifi',action:'set',key:'connect',value:{ssid:'test',password:'testpassword'}}},1000);
  assert.ok(!JSON.stringify(publicRepair(device.task)).includes('testpassword'));
  device.task.state='running';assert.throws(()=>applyRepairProgress(device,device.task.id,'success','', {exit_code:0,action:'completed',text:JSON.stringify({group:'network',sampled_at:2000,applied:true})},2000));
  const result={exit_code:0,action:'completed',text:JSON.stringify({group:'wifi',sampled_at:2000,applied:true,ssid:'test'})};
  applyRepairProgress(device,device.task.id,'success','完成',result,2000);assert.equal(device.system_settings.wifi.ssid,'test');assert.deepEqual(device.task.params,{});
  applyRepairProgress(device,device.task.id,'success','完成',result,2100);assert.equal(device.task.state,'success');
});

test('配置读回不接受截断结果或仅任务受理',()=>{
  const device={task:{state:'running',params:{group:'sound',action:'set'}}};
  assert.throws(()=>applySystemSettingsResult(device,{exit_code:0,action:'completed',truncated:true,text:'{}'},1));
  assert.throws(()=>applySystemSettingsResult(device,{exit_code:0,action:'completed',text:JSON.stringify({group:'sound',sampled_at:1})},1));
});


test('兼容D22系统HTTP调试行但拒绝其他错误输出，公开回执仍为纯JSON',()=>{
 const d={task:{type:'system_config',id:'compat',state:'running',params:{group:'network',action:'set',key:'bluetooth',value:false}}};
 const text='port:443\n[OkHttp] sendRequest>>\n[OkHttp] sendRequest<<\n'+JSON.stringify({group:'network',sampled_at:5,applied:true});
 const result={exit_code:0,action:'completed',text};applyRepairProgress(d,'compat','success','完成',result,6);
 assert.equal(JSON.parse(d.task.result.text).applied,true);assert.equal(d.system_settings.network.sampled_at,5);
 applyRepairProgress(d,'compat','success','完成',{exit_code:0,action:'completed',text},7);assert.doesNotThrow(()=>JSON.parse(d.task.result.text));
 assert.throws(()=>applySystemSettingsResult({task:{state:'running',params:{group:'network'}}},{exit_code:0,action:'completed',text:'Error: failed\n'+JSON.stringify({group:'network',sampled_at:5})},6));
});


test('移除的Wi-Fi DNS不再接受下发',()=>{
 assert.throws(()=>systemSettingsParams({group:'network',action:'set',key:'dns',value:{mode:'auto'}}));
});


test('系统目标按设置项合并；仅成功更新，读操作不保存目标，恢复有界且不泄露密码',async()=>{
 const d={id:'device',token_sha256:'old',managed_system_settings:true};let now=1000;
 async function success(p){await enqueueRepairTask(d,{type:'system_config',id:'t'+now,params:p},now);d.task.state='running';d.task.state='running';applyRepairProgress(d,d.task.id,'success','完成',{exit_code:0,action:'completed',text:JSON.stringify({group:p.group,sampled_at:now,applied:true})},now++);}
 await success({group:'sound',action:'set',key:'brightness',value:80});
 await success({group:'sound',action:'set',key:'media',value:3});
 await success({group:'wifi',action:'set',key:'connect',value:{ssid:'test',password:'testpassword'}});
 await success({group:'time',action:'read'});
 assert.equal(Object.keys(d.system_targets).length,3);
 d.token_sha256='new';assert.equal(await queueSystemRestore(d,null,now),true);assert.equal(d.task.params.key,'brightness');
 assert.equal(await queueSystemRestore(d,null,now),false);
 const first=d.task.id;applyRepairProgress(d,first,'failed','临时失败',null,now);
 assert.equal(await queueSystemRestore(d,null,now),true);assert.equal(d.task.params.key,'media');
 d.task.state='running';applyRepairProgress(d,d.task.id,'success','完成',{exit_code:0,action:'completed',text:JSON.stringify({group:'sound',sampled_at:now,applied:true})},now);
 assert.equal(await queueSystemRestore(d,null,now),true);assert.equal(d.task.params.key,'connect');assert.ok(!JSON.stringify(publicRepair(d.task)).includes('testpassword'));
 d.task.state='running';applyRepairProgress(d,d.task.id,'success','完成',{exit_code:0,action:'completed',text:JSON.stringify({group:'wifi',sampled_at:now,applied:true})},now);
 assert.equal(await queueSystemRestore(d,null,now),false);
 assert.equal(await queueSystemRestore(d,null,now+5*60000),true);assert.notEqual(d.task.id,first);
 d.task.state='running';applyRepairProgress(d,d.task.id,'success','完成',{exit_code:0,action:'completed',text:JSON.stringify({group:'sound',sampled_at:now,applied:true})},now);
 assert.equal(await queueSystemRestore(d,null,now+3600000),false);
});

test('系统配置失败保留此前目标，多项应用权限不互相覆盖',async()=>{
 const d={id:'test',token_sha256:'token'};
 for(const name of ['android.permission.CAMERA','android.permission.RECORD_AUDIO']){
  const p={group:'apps',package:'test.app',action:'set',key:'permission',value:{name,granted:true}};
  await enqueueRepairTask(d,{type:'system_config',id:name.replaceAll('.','-').replaceAll('_','-'),params:p},1000);d.task.state='running';
  d.task.state='running';applyRepairProgress(d,d.task.id,'success','完成',{exit_code:0,action:'completed',text:JSON.stringify({group:'apps',sampled_at:1001,applied:true})},1001);
 }
 const before=structuredClone(d.system_targets);assert.equal(Object.keys(before).length,2);
 await enqueueRepairTask(d,{type:'system_config',id:'fail',params:{group:'sound',action:'set',key:'brightness',value:90}},2000);d.task.state='running';applyRepairProgress(d,'fail','failed','失败',null,2001);
 assert.deepEqual(d.system_targets,before);
});


test('D31未读取设置及自定义型号仍受写入合同限制，D22跨应用恢复不误封',()=>{
 for(const d of [{model_id:'mdl_d31'},{update_channel:'d31'},{hardware_identity:{variant:'d31'}}]){
  for(const [group,key] of [['wifi','connect'],['network','mobile_data'],['sound','font_scale'],['time','locale'],['apps','permission'],['apps','notifications'],['apps','background']])assert.equal(systemSettingAllowed(d,group,key,'test.app'),false);
  for(const [group,key] of [['sound','media'],['sound','brightness'],['time','timezone'],['apps','enabled']])assert.equal(systemSettingAllowed(d,group,key,'test.app'),true);
 }
 const d={model_id:'mdl_d22',system_settings:{apps:{package:'test.other',unavailable:['notifications']},network:{unavailable:{network_write:'尚未适配'}}}};
 assert.equal(systemSettingAllowed(d,'apps','notifications','test.app'),true);
 assert.equal(systemSettingAllowed(d,'apps','notifications','test.other'),false);
 assert.equal(systemSettingAllowed(d,'network','mobile_data'),false);
 assert.equal(systemSettingAllowed({model_id:'mdl_d22'},'wifi','connect'),true);
});
