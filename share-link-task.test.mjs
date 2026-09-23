import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import worker from './worker.js';import {fixture,login,request} from './test-support.mjs';

function setup(){
  return fixture({admin_pass:'fixture-password',remote_devices:[{id:'device',enabled:true,status_only:true,
    token_sha256:createHash('sha256').update('fixture-token').digest('hex'),
    task:{id:'old-task',type:'pull_logs',state:'success',expires_at:Date.now()+60000}}]});
}
const task=()=>0;

test('show_share_link：链接由服务端生成后推给设备，设备不必反向申请',async()=>{
  const f=setup(),cookie=await login(f);
  const enqueue=(params,id)=>worker.fetch(request('/api/elfremote/task','POST',
    {device_id:'device',type:'show_share_link',...(id?{id}:{}),...(params?{params}:{})},cookie),f.env);
  let sequence=0;
  const report=async capable=>(await worker.fetch(request('/api/devices/report','POST',{
    device_id:'device',token:'fixture-token',status_only:true,managed_share_link_tasks:capable,
    report_id:'share-task-'+(++sequence),sampled_at:new Date(Date.now()+sequence*1000).toISOString()
  }),f.env)).json();

  assert.equal((await enqueue()).status,409,'未声明能力位时不给下发');

  await report(true);
  const created=await enqueue(undefined,'share-task-1');
  assert.equal(created.status,200);

  const stored=f.devices()[0].task;
  assert.equal(stored.type,'show_share_link');
  // 载荷三项：人读地址、二维码用的全大写串、链接有效期
  assert.match(stored.params.url,/^https:\/\/[^/]+\/m\/[A-Z0-9]{12}$/);
  assert.equal(stored.params.qr_text,stored.params.url.toUpperCase(),'二维码文本是整条链接的大写');
  assert.ok(stored.params.link_expires_at>Date.now());
  assert.equal(stored.params.display_ms,undefined,'不传显示时长就不下发，由设备用缺省值');

  // 信封的领取期限与链接有效期是两回事，前者必须短得多
  assert.ok(stored.expires_at<=Date.now()+5*60*1000,'任务领取期限不超过五分钟');
  assert.ok(stored.params.link_expires_at>stored.expires_at+10*60*1000,'链接有效期远长于领取期限');

  // 二维码会画在可能摆在公共位置的屏幕上，载荷里不能有任何口令字段
  for(const field of Object.keys(stored.params))assert.doesNotMatch(field,/pass|secret|token/i);

  const offered=await report(true);
  assert.equal(offered.managed_task.id,stored.id);
  assert.equal(offered.managed_task.managed_share_link_v1,true);
  assert.equal((await report(false)).managed_task,undefined,'撤回能力位后不再派发');
});

test('show_share_link：显示时长透传，撤回复用既有取消动作',async()=>{
  const f=setup(),cookie=await login(f);
  let sequence=0;
  const report=async()=>(await worker.fetch(request('/api/devices/report','POST',{
    device_id:'device',token:'fixture-token',status_only:true,managed_share_link_tasks:true,
    report_id:'share-cancel-'+(++sequence),sampled_at:new Date(Date.now()+sequence*1000).toISOString()
  }),f.env)).json();
  await report();

  const created=await worker.fetch(request('/api/elfremote/task','POST',
    {device_id:'device',type:'show_share_link',id:'share-task-2',params:{display_ms:45000}},cookie),f.env);
  assert.equal(created.status,200);
  const stored=f.devices()[0].task;
  assert.equal(stored.params.display_ms,45000,'显示时长原样透传，夹紧在设备侧做');

  const cancelled=await worker.fetch(request('/api/elfremote/task','POST',
    {device_id:'device',action:'cancel',task_id:stored.id},cookie),f.env);
  assert.equal(cancelled.status,200,'该类型必须在允许撤回的名单里');
  assert.equal(f.devices()[0].task.cancel_requested,true);
});

// 面板上「在设备上显示」用的是分享弹窗里那个有效期下拉框。服务端必须认这个参数，
// 否则界面上选了「6 小时」、实际下发的却是默认一小时，那是界面在骗人。
test('show_share_link：有效期按面板选的来，非法值当场拒绝',async()=>{
  const f=setup(),cookie=await login(f);
  await worker.fetch(request('/api/devices/report','POST',{
    device_id:'device',token:'fixture-token',status_only:true,managed_share_link_tasks:true,
    report_id:'share-ttl-1',sampled_at:new Date().toISOString()}),f.env);

  const enqueue=(params,id)=>worker.fetch(request('/api/elfremote/task','POST',
    {device_id:'device',type:'show_share_link',id,params},cookie),f.env);

  const ok=await enqueue({ttl:'6h'},'ttl-ok');
  assert.equal(ok.status,200);
  const created=f.devices()[0].task.params.link_expires_at;
  const life=created-Date.now();
  assert.ok(Math.abs(life-6*3600000)<10000,'有效期要按面板选的 6 小时来，实际 '+life);

  const bad=await enqueue({ttl:'5m'},'ttl-bad');
  assert.equal(bad.status,400,'非法有效期要当场拒绝，不能静默用默认值');
});
