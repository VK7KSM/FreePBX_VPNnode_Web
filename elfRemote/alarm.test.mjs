import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeAlarm,applyRepairProgress} from './control-plane.js';

test('警报结果限制状态和时长，非警报任务不能伪造播放结果',()=>{
  const alarm={state:'playing',started_at_ms:1000,duration_ms:10000};
  assert.deepEqual(normalizeAlarm(alarm),alarm);
  assert.equal(normalizeAlarm({...alarm,state:'fake'}),null);
  assert.equal(normalizeAlarm({...alarm,duration_ms:10001}),null);
  assert.equal(normalizeAlarm({...alarm,started_at_ms:-1}),null);
  const device={task:{id:'a',type:'play_alarm',state:'running'}};
  applyRepairProgress(device,'wrong','success','',{alarm});assert.equal(device.alarm,undefined);
  applyRepairProgress(device,'a','success','',{alarm});assert.deepEqual(device.alarm,alarm);
  device.task={id:'b',type:'heal_network',state:'running'};
  applyRepairProgress(device,'b','success','',{alarm:{...alarm,state:'stopped'}});
  assert.equal(device.alarm.state,'playing');
});
