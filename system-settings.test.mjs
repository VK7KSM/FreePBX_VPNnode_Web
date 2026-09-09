import test from 'node:test';
import assert from 'node:assert/strict';
import {systemSettingsParams,applySystemSettingsResult} from './system-settings.js';
import {enqueueRepairTask,applyRepairProgress,publicRepair} from './elfRemote/control-plane.js';

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
