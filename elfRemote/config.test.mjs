import test from 'node:test';
import assert from 'node:assert/strict';
import {configParams,normalizeContacts,enqueueRepairTask,applyRepairProgress,publicRepair} from './control-plane.js';
test('配置参数保留原文并拒绝非法边界，密码不进入公开任务且完成后清除',async()=>{
  const params={ssid:'测试"$(id)',password:'fixture-pass'};
  assert.deepEqual(configParams('connect_wifi',params),params);
  assert.throws(()=>configParams('connect_wifi',{ssid:'测'.repeat(11)}));
  assert.throws(()=>configParams('connect_wifi',{ssid:'a',password:'bad'}));
  assert.throws(()=>configParams('contact_update',{id:-1,name:'a',phone:'b'}));
  const d={};await enqueueRepairTask(d,{type:'connect_wifi',params},1000);
  assert.equal(JSON.stringify(publicRepair(d.task)).includes('fixture-pass'),false);
  applyRepairProgress(d,d.task.id,'failed','rolled-back',{});
  assert.deepEqual(d.task.params,{});
});
test('通信录只有合法完整成功结果替换旧列表，失败保留上次读取',()=>{
  const old={sampled_at_ms:1,items:[],truncated:false};
  const d={contacts:old,task:{id:'a',type:'contact_add',state:'running',params:{name:'fixture'}}};
  assert.throws(()=>applyRepairProgress(d,'a','success','',{contacts:{items:[]}}));
  assert.equal(d.task.state,'running');assert.equal(d.contacts,old);
  const fresh={sampled_at_ms:2,items:[{id:3,name:'<script>',phone:'+1'}],truncated:false};
  applyRepairProgress(d,'a','success','',{contacts:fresh});assert.deepEqual(d.contacts,fresh);
  assert.throws(()=>normalizeContacts({...fresh,items:[fresh.items[0],fresh.items[0]]}));
});
