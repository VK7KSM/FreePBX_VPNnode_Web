import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import worker from './worker.js';import {fixture,request,login} from './test-support.mjs';
import {reportInterval} from './location-history.js';

// 上报节奏由设备自报；服务端以前按 network 查表写死 15 分钟，网关每 60 秒一报却按 30 分钟判断点，故障被掩盖。
test('设备自报的 report_interval_ms 在 [60 秒, 24 小时] 内就采信，否则回退查表', () => {
  assert.equal(reportInterval({network:'wifi',report_interval_ms:60000}),60000);
  assert.equal(reportInterval({network:'cellular',report_interval_ms:86400000}),86400000);
  assert.equal(reportInterval({network:'wifi'}),900000,'没报就查表');
  assert.equal(reportInterval({network:'cellular'}),3600000);
  assert.equal(reportInterval({network:'wifi',report_interval_ms:1000}),900000,'低于 60 秒不信');
  assert.equal(reportInterval({network:'wifi',report_interval_ms:86400001}),900000,'超过一天不信');
  assert.equal(reportInterval({network:'wifi',report_interval_ms:'60000'}),900000,'字符串不信');
  assert.equal(reportInterval({network:'wifi',report_interval_ms:60000.5}),900000);
});

test('上报落到历史行里的 report_interval_ms 是设备自报的值', async () => {
  const TOKEN='t';
  const f=fixture({admin_pass:'fixture-password',remote_devices:[{id:'gw',name:'Pixel Gateway',model_id:'mdl_d22',paired:true,enabled:true,status_only:true,
    token_sha256:createHash('sha256').update(TOKEN).digest('hex')}]});
  const r=await worker.fetch(request('/api/devices/report','POST',{device_id:'gw',token:TOKEN,battery:50,network:'wifi',report_interval_ms:60000,report_id:'r1'}),f.env);
  assert.equal(r.status,200,await r.clone().text());
  const rows=[...f.data.entries()].filter(([k])=>k.startsWith('history/gw/'));
  assert.equal(rows.length,1);
  assert.equal(rows[0][1].report_interval_ms,60000);
  const cookie=await login(f);
  const h=await (await worker.fetch(request('/api/devices/history?device_id=gw','GET',undefined,cookie),f.env)).json();
  const list=h.items||h.history||h.records||[];
  assert.equal(list[0].report_interval_ms,60000,'面板读到的也是 60 秒');
});
