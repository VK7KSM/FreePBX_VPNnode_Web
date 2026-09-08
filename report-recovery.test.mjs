import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareRecovery,recoveryContact,runRecovery} from './report-recovery.js';
import {fixture,request,login} from './test-support.mjs';
import {pushState} from './push-control.js';
import worker from './worker.js';

test('蜂窝与Wi-Fi到期不同，补拉两次后停止，完整报告重新开始计时',async()=>{
  const f=fixture(),start=Date.parse('2026-09-08T00:00:00Z');
  const wifi={id:'wifi',status_only:true,network:'wifi',last_seen:new Date(start).toISOString()};
  const cell={...wifi,id:'cell',network:'cellular'};
  const disabled={...wifi,id:'disabled',enabled:false};
  const now=start+1000000,devices=[wifi,cell,disabled];
  assert.equal(recoveryContact(wifi,now).state,'report_overdue');
  assert.equal(recoveryContact(cell,now).state,'awaiting_report');
  assert.equal((await prepareRecovery(f.storage,devices,now)).length,1);
  assert.equal((await prepareRecovery(f.storage,devices,now)).length,0);
  assert.equal((await prepareRecovery(f.storage,devices,now+90000)).length,1);
  assert.equal((await prepareRecovery(f.storage,devices,now+180000)).length,0);
  assert.equal(wifi.report_probe.state,'failed');
  assert.equal(recoveryContact(wifi,now+180000).state,'report_overdue');
  assert.equal((await prepareRecovery(f.storage,devices,now+360000)).length,0);
  wifi.last_seen=new Date(now+360000).toISOString();
  await prepareRecovery(f.storage,devices,now+360001);assert.equal(wifi.report_probe,undefined);
});

test('领取回执只说明联系成功，不替代完整报告；异常时窗口有限',async()=>{
  const f=fixture(),now=Date.now(),d={id:'a',status_only:true,network:'wifi',last_seen:new Date(now-1000000).toISOString()};
  const [out]=await prepareRecovery(f.storage,[d],now);
  const k='push/request/a',p=await f.storage.get(k);p.received_at=new Date(now+1000).toISOString();await f.storage.put(k,p);
  await prepareRecovery(f.storage,[d],now+90000);
  assert.equal(recoveryContact(d,now+90000).state,'awaiting_full_report');
  assert.equal(d.last_seen,new Date(now-1000000).toISOString());
  assert.equal(out.request.request_id,p.request_id);
  assert.equal(recoveryContact(d,now+500000).state,'report_overdue');
});

test('定时检查无需网页访问；并发调用仅准备一次，外部接口不能调用内部准备入口',async()=>{
  const f=fixture({admin_pass:'fixture-password',remote_devices:[{id:'a',name:'测试设备',paired:false,status_only:true,network:'wifi',last_seen:new Date(Date.now()-1000000).toISOString()}]});
  let publishes=0;f.env.MQTT_API_URL='https://mqtt.example.test';f.env.MQTT_API_TOKEN='fixture';
  f.env.MQTT_FETCH=async(url,options)=>{publishes++;const b=JSON.parse(options.body);return Response.json({ok:true,accepted:true,request_id:b.notification.request_id});};
  await Promise.all([worker.scheduled({},f.env),worker.scheduled({},f.env)]);assert.equal(publishes,1);
  const cookie=await login(f),list=await (await worker.fetch(request('/api/devices','GET',undefined,cookie),f.env)).json();
  assert.equal(list.devices[0].contact_state,'checking_connection');
  await worker.fetch(request('/__recovery','POST',{}),f.env);assert.equal(publishes,1);
  const d=f.data.get('remote_devices')[0];d.report_probe.next_at=0;f.data.set('remote_devices',[d]);
  // 发布失败也占一次尝试，不因服务故障无限重试。
  const p=f.data.get('push/request/a');p.last_publish_at_ms-=10000;f.data.set('push/request/a',p);
  f.env.MQTT_FETCH=async()=>{publishes++;throw Error('fixture failure');};
  await worker.scheduled({},f.env);assert.equal(publishes,2);
  const d2=f.data.get('remote_devices')[0];d2.report_probe.next_at=0;f.data.set('remote_devices',[d2]);
  await worker.scheduled({},f.env);assert.equal(publishes,2);
  const after=await (await worker.fetch(request('/api/devices','GET',undefined,cookie),f.env)).json();assert.equal(after.devices.length,0);
});
