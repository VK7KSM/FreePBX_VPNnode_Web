import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
globalThis.fetch = () => { throw Error('离线测试禁止网络'); };
const {photoMetadata} = await import('./report-photo.js');
const NOW = 1800000000000;
const DAY = 86400000;
const TOKEN = 'synthetic-offline-token';
const SHA = createHash('sha256').update('synthetic-jpeg').digest('hex');
const copy = value => value === undefined ? undefined : structuredClone(value);
const critical = level => ({type: 'low_battery', level, thresholds: [2]});

// 模拟DO的复制读写语义，避免对象别名导致幂等断言误过；不连接KV、R2或真实设备。
function fixture({model = 'mdl_d31', network = 'ethernet', event, acknowledged = true,
  manual = false, enabled = true, deviceNetwork = 'wifi', reportAge = 1000, expiredManual = false} = {}) {
  const records = new Map();
  let devices = [{id: 'synthetic-device', model_id: model, enabled, network: deviceNetwork,
    token_sha256: createHash('sha256').update(TOKEN).digest('hex')}];
  let saves = 0;
  const report = {received_at: new Date(NOW - reportAge).toISOString(), timeline_at: new Date(NOW - 2000).toISOString(),
    network, ...(event ? {report_event: event} : {})};
  if (acknowledged) {
    records.set('history-id/synthetic-device/synthetic-report', {key: 'synthetic-history'});
    records.set('synthetic-history', copy(report));
  }
  if (manual) records.set('manual-photo/synthetic-device/synthetic-report', {...copy(report), expires_at: NOW + (expiredManual ? -1 : 60000)});
  const storage = {
    async get(key) { return copy(records.get(key)); },
    async put(key, value) { records.set(key, copy(value)); },
    async delete(key) { return records.delete(key); },
    async list({prefix = '', start, startAfter, end, limit = Infinity} = {}) {
      return new Map([...records].filter(([key]) => key.startsWith(prefix) && (!start || key >= start)
        && (!startAfter || key > startAfter) && (!end || key < end)).sort(([a], [b]) => a.localeCompare(b))
        .slice(0, limit).map(([key, value]) => [key, copy(value)]));
    }
  };
  const params = {device_id: 'synthetic-device', report_id: 'synthetic-report', token: TOKEN,
    bytes: 100, sha256: SHA, captured_at: NOW - 500};
  async function call(action, overrides = {}, implementation = photoMetadata) {
    const request = new Request('https://offline.invalid/__photos', {method: 'POST',
      body: JSON.stringify({...params, action, ...overrides})});
    const response = await implementation(storage, request, async () => copy(devices), async next => { saves++; devices = copy(next); }, NOW);
    return {status: response.status, body: await response.json()};
  }
  return {records, report, call, params, photoKey: 'report-photo/synthetic-device/synthetic-report',
    devices: () => copy(devices), saves: () => saves};
}

for (const network of ['wifi', 'ethernet']) {
  test(`D31 ${network} 自动照片reserve/commit绑定历史并生成回执`, async () => {
    const f = fixture({network, deviceNetwork: 'cellular'});
    const reserve = await f.call('reserve');
    assert.equal(reserve.status, 200);assert.equal(reserve.body.photo.ready, false);
    assert.equal(reserve.body.photo.manual, false);assert.equal(reserve.body.photo.report_id, f.params.report_id);
    assert.equal(reserve.body.photo.report_timeline_at, f.report.timeline_at);
    assert.equal(reserve.body.photo.expires_at, NOW + 7 * DAY);
    assert.equal(f.devices()[0].report_photo, undefined);
    const commit = await f.call('commit');
    assert.deepEqual(commit, {status: 200, body: {ok: true, sha256: SHA, bytes: 100}});
    assert.equal(f.records.get(f.photoKey).ready, true);
    assert.equal(f.devices()[0].report_photo.report_id, f.params.report_id);
    const archived = [...f.records].filter(([key]) => key.startsWith('trajectory-media/'));
    assert.equal(archived.length, 1);assert.equal(archived[0][1].manual, false);
    assert(!JSON.stringify([...f.records]).includes(TOKEN));
    assert.equal((await f.call('get')).body.photo.sha256, SHA);
  });
}
for (const network of ['cellular', 'unknown', 'offline', '', 'vpn']) {
  for (const event of [undefined, critical(0), critical(1)]) {
    test(`D31 ${network || '空'} ${event ? `低电量${event.level}` : '普通'} 拒绝reserve和旧缓存commit`, async () => {
      const f = fixture({network, event});
      assert.deepEqual(await f.call('reserve'), {status: 409, body: {ok: false, msg: '本次报告不包含拍照规则'}});
      assert.equal(f.records.has(f.photoKey), false);
      f.records.set(f.photoKey, {sha256: SHA, bytes: 100, expires_at: NOW + DAY, ready: false});
      assert.equal((await f.call('commit')).status, 409);
      assert.equal(f.records.get(f.photoKey).ready, false);assert.equal(f.saves(), 0);
    });
  }
}
test('D31允许网络低电量仍走相同照片入口', async () => {
  for (const network of ['wifi', 'ethernet']) {
    const f = fixture({network, event: critical(1)});
    assert.equal((await f.call('reserve')).status, 200);assert.equal((await f.call('commit')).status, 200);
  }
});
test('D31仅信任已认证设备型号而非请求伪报型号或网络', async () => {
  const f = fixture({network: 'cellular', event: critical(1)});
  assert.equal((await f.call('reserve', {model_id: 'mdl_d22', network: 'wifi'})).status, 409);
  assert.equal((await fixture({model: 'mdl_d22', network: 'ethernet'}).call('reserve', {model_id: 'mdl_d31'})).status, 409);
});
test('文字ACK缺失及超过24小时不得reserve/commit', async () => {
  for (const options of [{acknowledged: false}, {reportAge: DAY + 1}]) {
    const f = fixture(options);
    for (const action of ['reserve', 'commit']) assert.equal((await f.call(action)).status, 409);
    assert.equal(f.records.has(f.photoKey), false);
  }
  const f = fixture();assert.equal((await f.call('reserve', {report_id: 'unacknowledged-report'})).status, 409);
});
test('鉴权在自动及手动reserve/commit仍生效', async () => {
  for (const manual of [false, true]) for (const action of ['reserve', 'commit']) {
    for (const token of ['', 'wrong-token', null]) assert.equal((await fixture({manual}).call(action, {token})).status, 401);
    assert.equal((await fixture({manual, enabled: false}).call(action)).status, 401);
    assert.equal((await fixture({manual}).call(action, {device_id: 'missing-device'})).status, 401);
  }
});
test('reserve及commit同内容幂等，不生成重复媒体或重复设备保存', async () => {
  const f = fixture();const first = await f.call('reserve');
  assert.deepEqual(await f.call('reserve'), first);
  const commit = await f.call('commit');assert.deepEqual(await f.call('commit'), commit);
  assert.equal(f.saves(), 1);
  assert.equal([...f.records.keys()].filter(key => key.startsWith('trajectory-media/')).length, 1);
  assert.equal((await f.call('reserve')).body.photo.ready, true);
  for (const overrides of [{bytes: 101}, {sha256: 'b'.repeat(64)}]) assert.equal((await f.call('reserve', overrides)).status, 409);
  assert.equal((await f.call('commit', {sha256: 'b'.repeat(64)})).status, 409);
});
test('大小摘要及采样时间门保持，commit不能跳过reserve', async () => {
  for (const overrides of [{bytes: 3}, {bytes: 262145}, {sha256: 'invalid'}, {captured_at: NOW - DAY - 1}])
    assert.equal((await fixture().call('reserve', overrides)).status, 400);
  assert.equal((await fixture().call('commit')).status, 409);
});
test('D31旧蜂窝普通和critical报告不能借当前WiFi取得资格', async () => {
  for (const event of [undefined, critical(1)]) assert.equal((await fixture({network: 'cellular', event, deviceNetwork: 'wifi'}).call('reserve')).status, 409);
});
test('手动入口保留：D31和D22蜂窝及未知网络有效manual许可可reserve/commit', async () => {
  for (const model of ['mdl_d31', 'mdl_d22']) for (const network of ['cellular', 'unknown']) {
    const f = fixture({model, network, manual: true, acknowledged: false});
    const result = await f.call('reserve');assert.equal(result.status, 200);assert.equal(result.body.photo.manual, true);
    assert.equal((await f.call('commit')).status, 200);
    assert.equal((await fixture({model, network, manual: true, expiredManual: true, acknowledged: false}).call('reserve')).status, 409);
  }
});
test('D22及非D31型号使用显式原规则预期，保留低电量例外', async () => {
  const cases = [
    {network: 'wifi', statuses: [200, 200, 200, 200]},
    {network: 'ethernet', statuses: [409, 200, 200, 409]},
    {network: 'cellular', statuses: [409, 200, 200, 409]},
    {network: 'unknown', statuses: [409, 200, 200, 409]}
  ];
  for (const model of ['mdl_d22', null, 'other-model']) {
    for (const row of cases) {
      const events = [undefined, critical(0), critical(1), critical(2)];
      for (let i = 0; i < events.length; i++) {
        const f = fixture({model, network: row.network, event: events[i]});
        for (const action of ['reserve', 'commit', 'reserve', 'commit']) {
          const response = await f.call(action);
          assert.equal(response.status, row.statuses[i]);
          if (row.statuses[i] === 409) {
            assert.deepEqual(response.body, {ok: false, msg: '本次报告不包含拍照规则'});
            assert.equal(f.records.has(f.photoKey), false);assert.equal(f.saves(), 0);
          } else if (action === 'commit') {
            assert.deepEqual(response.body, {ok: true, sha256: SHA, bytes: 100});
            assert.equal(f.records.get(f.photoKey).ready, true);assert.equal(f.saves(), 1);
          } else {
            assert.equal(response.body.ok, true);assert.equal(response.body.photo.sha256, SHA);
            assert.equal(response.body.photo.manual, false);
          }
        }
      }
    }
  }
});
