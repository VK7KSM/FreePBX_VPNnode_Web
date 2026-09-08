import test from 'node:test';
import assert from 'node:assert/strict';
import {lostModeParams,normalizeLostMode,enqueueRepairTask,applyRepairProgress} from './control-plane.js';
test('丢失模式验证失主文字，退出清除任务文字且不改变历史',()=>{
  assert.deepEqual(lostModeParams({enabled:true,message:' 测试 '}),{enabled:true,message:'测试'});
  for(const value of [{enabled:'true'},{enabled:true},{enabled:true,message:'x'.repeat(301)}]) assert.throws(()=>lostModeParams(value));
  const d={history:['old']};
  enqueueRepairTask(d,{type:'set_lost_mode',params:{enabled:true,message:'测试'}},1000);
  d.task.state='running';
  assert.throws(()=>applyRepairProgress(d,d.task.id,'success','',{}));
  assert.equal(d.task.state,'running');
  applyRepairProgress(d,d.task.id,'success','',{lost_mode:{enabled:true,message:'测试',state:'enabled'}});
  assert.equal(d.lost_mode.state,'enabled');assert.deepEqual(d.task.params,{});assert.deepEqual(d.history,['old']);
  assert.throws(()=>normalizeLostMode({enabled:false,state:'enabled'}));
  assert.deepEqual(normalizeLostMode({enabled:false,state:'disabled',message:'旧文字'}),{enabled:false,state:'disabled',message:''});
});
