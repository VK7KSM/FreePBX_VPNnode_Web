import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import worker from './worker.js';
import {fixture, login, request} from './test-support.mjs';
import {RELEASE_CHANNELS, releaseKey} from './release-channels.js';
import {D31_RECOMMENDATION_KEY as POLICY, D31_ATTEMPT_PREFIX as ATTEMPTS} from './d31-auto-follow.js';

globalThis.fetch = () => { throw Error('离线测试禁止网络'); };
const hash = text => createHash('sha256').update(text).digest('hex');
const IDS = ['fixture-first', 'fixture-second', 'fixture-third'];
const TOKEN = 'fixture-offline-token';
const models = [{id: 'mdl_d31', name: 'D31', registration_key: 'd31'}, {id: 'mdl_d22', name: 'D22', registration_key: 'd22'}];
function release(versionCode = 182, extra = {}) {
  const m = {...RELEASE_CHANNELS.d31, channel: 'd31', versionCode, versionName: '1.0.' + versionCode,
    sha256: hash('fixture-apk-' + versionCode), size: 15, job_id: 'fixture-release-' + versionCode,
    expires_at: Date.now() + 86400000, ...extra};
  m.url = 'https://v.elfradio.net/api/elfremote/apk/' + m.job_id;
  return {...m, manifest_raw: JSON.stringify(m), signature: 'fixture-published-signature', apk_key: 'apks/' + m.sha256};
}
function device(id, extra = {}) {
  return {id, name: '同名测试设备', model_id: 'mdl_d31', hardware_identity: {variant: 'd31'},
    enabled: true, app_version: '1.0.180', status_only: true, managed_update: true, managed_update_v2: true,
    token_sha256: hash(TOKEN), ...extra};
}
function installRelease(f, rel) {
  f.data.set(releaseKey('d31', rel.versionCode), rel);
  f.data.set('elfremote_releases_d31', [...new Set([...(f.data.get('elfremote_releases_d31') || []), rel.versionCode])]);
  f.data.set('elfremote_job_' + rel.job_id, {channel: 'd31', versionCode: rel.versionCode, manifest_raw: rel.manifest_raw});
}
async function setup() {
  const f = fixture({admin_pass: 'fixture-password', remote_device_models: models,
    remote_devices: [...IDS.map(id => device(id)), device('fixture-fourth'),
      device('fixture-d22', {model_id: 'mdl_d22', hardware_identity: {variant: 'd22'}})]});
  f.env.D31_AUTO_FOLLOW_DEVICE_IDS = JSON.stringify(IDS);
  installRelease(f, release(180)); installRelease(f, release());
  f.cookie = await login(f);
  f.post = (path, body, cookie = f.cookie) => worker.fetch(request(path, 'POST', body, cookie), f.env);
  f.get = path => worker.fetch(request(path, 'GET', undefined, f.cookie), f.env);
  return f;
}
const recommendBody = rel => ({action: 'recommend_d31', channel: 'd31', versionCode: rel.versionCode,
  sha256: rel.sha256, release_job_id: rel.job_id});
const promote = (f, version = 182) => f.post('/api/elfremote/assign', recommendBody(f.data.get(releaseKey('d31', version))));
const current = (f, id = IDS[0]) => f.data.get('remote_devices').find(d => d.id === id);
function mutate(f, id, values) {
  const list = structuredClone(f.data.get('remote_devices')); Object.assign(list.find(d => d.id === id), values);
  f.data.set('remote_devices', list);
}
function payload(id = IDS[0], extra = {}) {
  return {device_id: id, token: TOKEN, report_id: crypto.randomUUID(), reported_at: new Date().toISOString(),
    app_version: '1.0.180', status_only: true, managed_update: true, managed_update_v2: true, network: 'ethernet', ...extra};
}
const report = (f, body = payload()) => worker.fetch(request('/api/devices/report', 'POST', body), f.env);
const attempts = f => [...f.data].filter(([key]) => key.startsWith(ATTEMPTS));
async function ok(response) {
  const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body;
}

test('默认不跟随；显式管理员推荐不立即派发；三台认证报告各领唯一既有更新', async () => {
  const f = await setup(); await ok(await report(f)); assert.equal(current(f).update, undefined);
  await ok(await promote(f)); assert.equal(attempts(f).length, 0);
  for (const id of IDS) {
    const body = await ok(await report(f, payload(id)));
    assert.equal(body.managed_update.task_device_id, id);
    assert.equal(body.managed_update.manifest_raw, f.data.get(releaseKey('d31', 182)).manifest_raw);
    assert.equal(body.managed_update.task_id, current(f, id).update.job_id);
    assert.ok(body.managed_update.task_expires_at <= Date.now() + 3600000);
    assert.ok(body.managed_update.task_expires_at > Date.now() + 3590000);
  }
  assert.equal(new Set(IDS.map(id => current(f, id).update.job_id)).size, 3);
  assert.equal(attempts(f).length, 3);
});

test('固定ID不按显示名；第四台及D22保持不派发，D22不读取推荐记录', async () => {
  const f = await setup(); await ok(await promote(f));
  await ok(await report(f, payload('fixture-fourth'))); assert.equal(current(f, 'fixture-fourth').update, undefined);
  const get = f.storage.get;
  f.storage.get = async key => { assert.notEqual(key, POLICY); return get(key); };
  await ok(await report(f, payload('fixture-d22'))); assert.equal(current(f, 'fixture-d22').update, undefined);
  assert.equal(attempts(f).length, 0);
});

test('管理员鉴权与设备鉴权不可由推荐字段绕过', async () => {
  const f = await setup();
  assert.equal((await f.post('/api/elfremote/assign', recommendBody(release()), '')).status, 401);
  assert.equal(f.data.has(POLICY), false);
  await ok(await promote(f));
  assert.equal((await report(f, payload(IDS[0], {token: 'wrong', action: 'recommend_d31'}))).status, 401);
  assert.equal(current(f).update, undefined); assert.equal(attempts(f).length, 0);
});

for (const allowed of [undefined, 'invalid', '[]', JSON.stringify([IDS[0], IDS[0], IDS[2]]), JSON.stringify([...IDS, 'fixture-fourth'])]) {
  test('缺失或非法服务器三机集合拒绝推荐：' + String(allowed), async () => {
    const f = await setup(); f.env.D31_AUTO_FOLLOW_DEVICE_IDS = allowed;
    assert.equal((await promote(f)).status, 400); assert.equal(f.data.has(POLICY), false);
    await ok(await report(f)); assert.equal(current(f).update, undefined);
  });
}

for (const field of ['sha256', 'release_job_id', 'channel', 'versionCode']) {
  test('推荐精确绑定已发布制品字段：' + field, async () => {
    const f = await setup(); const data = recommendBody(release()); data[field] = field === 'versionCode' ? 181 : 'wrong';
    assert.equal((await f.post('/api/elfremote/assign', data)).status, 400); assert.equal(f.data.has(POLICY), false);
  });
}

for (const changes of [{device_id: IDS[0]}, {expires_at: 1}, {retired_at: 1}, {signature: ''}]) {
  test('单机、过期、退休或缺发布签名不能推荐：' + JSON.stringify(changes), async () => {
    const f = await setup(); installRelease(f, {...release(182, changes), ...changes});
    assert.equal((await promote(f)).status, 400); assert.equal(f.data.has(POLICY), false);
  });
}

test('发布job索引不符或授权设备模型冲突拒绝推荐', async () => {
  const f = await setup(); f.data.set('elfremote_job_fixture-release-182', {channel: 'd22'});
  assert.equal((await promote(f)).status, 400);
  installRelease(f, release()); mutate(f, IDS[1], {model_id: 'mdl_d22'});
  assert.equal((await promote(f)).status, 400);
});

test('相同报告及不同新报告并发，响应重放只交付同一任务', async () => {
  const f = await setup(); await ok(await promote(f)); const body = payload();
  const responses = await Promise.all(Array.from({length: 8}, () => report(f, body)));
  const results = await Promise.all(responses.map(ok));
  assert.equal(new Set(results.map(r => r.managed_update.task_id)).size, 1);
  const first = current(f).update.job_id;
  await Promise.all(Array.from({length: 8}, () => report(f).then(ok)));
  assert.equal(current(f).update.job_id, first); assert.equal(attempts(f).length, 1);
  assert.match(current(f).update.request_id, /^auto-d31-[a-f0-9]{64}$/);
});

test('旧报告重放不在新推荐后额外分配，下一新鲜报告才评估', async () => {
  const f = await setup(); const body = payload(); await ok(await report(f, body)); await ok(await promote(f));
  assert.equal((await ok(await report(f, body))).managed_update, undefined);
  assert.equal(current(f).update, undefined); await ok(await report(f)); assert.ok(current(f).update.job_id);
});

for (const changes of [{managed_update: false}, {managed_update_v2: false}, {app_version: ''}, {app_version: 'unknown'}, {app_version: '1.0.182'}]) {
  test('能力不足或未证实低版本不自动更新：' + JSON.stringify(changes), async () => {
    const f = await setup(); await ok(await promote(f)); await ok(await report(f, payload(IDS[0], changes)));
    assert.equal(current(f).update, undefined); assert.equal(attempts(f).length, 0);
  });
}

test('禁用、已撤销授权、身份冲突、推荐失效都不创建任务', async () => {
  for (const change of ['disabled', 'revoked', 'identity', 'expired', 'retired', 'resigned']) {
    const f = await setup(); await ok(await promote(f));
    if (change === 'disabled') mutate(f, IDS[0], {enabled: false});
    if (change === 'revoked') f.env.D31_AUTO_FOLLOW_DEVICE_IDS = JSON.stringify(['fixture-fourth', IDS[1], IDS[2]]);
    if (change === 'identity') mutate(f, IDS[0], {model_id: 'mdl_d22'});
    if (change === 'expired') installRelease(f, release(182, {expires_at: 1}));
    if (change === 'retired') f.data.set(releaseKey('d31', 182), {...release(), retired_at: 1});
    if (change === 'resigned') installRelease(f, release(182, {job_id: 'new-signing-job'}));
    await ok(await report(f)); assert.equal(current(f).update, undefined, change);
  }
});

test('乱序报告不借旧能力或旧版本分配，版本名歧义也拒绝', async () => {
  const f = await setup(); await ok(await report(f, payload(IDS[0], {managed_update: false})));
  await ok(await promote(f));
  await ok(await report(f, payload(IDS[0], {reported_at: new Date(Date.now() - 60000).toISOString()})));
  assert.equal(current(f).update, undefined);
  installRelease(f, release(181, {versionName: '1.0.180'})); await ok(await report(f)); assert.equal(current(f).update, undefined);
});

for (const state of ['pending', 'claimed', 'installing', 'wait_health', 'rollback']) {
  test('已有活动更新不覆盖：' + state, async () => {
    const f = await setup(); await ok(await promote(f));
    const update = {job_id: 'fixture-existing', versionCode: 181, state, expires_at: Date.now() + 60000};
    mutate(f, IDS[0], {update}); await ok(await report(f)); assert.deepEqual(current(f).update, update); assert.equal(attempts(f).length, 0);
  });
}

for (const terminal of ['success', 'rejected', 'recovered', 'failed', 'expired']) {
  test('失败或完成后即使槽位被覆盖也不循环重装：' + terminal, async () => {
    const f = await setup(); await ok(await promote(f)); await ok(await report(f)); const first = current(f).update;
    mutate(f, IDS[0], {update: {...first, state: terminal, expires_at: 1}});
    await ok(await report(f)); assert.equal(current(f).update.job_id, first.job_id);
    mutate(f, IDS[0], {update: {job_id: 'fixture-other', state: 'success', versionCode: 180}});
    await ok(await promote(f)); await ok(await report(f)); assert.equal(current(f).update.job_id, 'fixture-other');
    assert.equal(attempts(f).length, 1);
  });
}

test('真实progress回滚与拒绝终态后自然报告不重复安装', async () => {
  for (const states of [['claimed', 'rejected'], ['installing', 'rollback', 'recovered']]) {
    const f = await setup(); await ok(await promote(f)); await ok(await report(f)); const job_id = current(f).update.job_id;
    for (const state of states) await ok(await f.post('/api/elfremote/update-progress', {device_id: IDS[0], token: TOKEN, job_id, state}));
    await ok(await report(f)); assert.equal(current(f).update.job_id, job_id); assert.equal(current(f).update.state, states.at(-1));
  }
});

test('未由自动策略创建的同制品失败也保留阻止重装记录', async () => {
  const f = await setup(); await ok(await promote(f));
  mutate(f, IDS[0], {update: {job_id: 'fixture-manual-failed', state: 'recovered', versionCode: 182,
    manifest_raw: f.data.get(releaseKey('d31', 182)).manifest_raw, expires_at: 1}});
  await ok(await report(f)); assert.equal(current(f).update.job_id, 'fixture-manual-failed');
  assert.equal(attempts(f)[0][1].origin, 'existing_update');
});

test('未领取任务到期不续期；新推荐可替换已过期待通知任务，执行中超时仍不覆盖', async () => {
  const f = await setup(); await ok(await promote(f)); await ok(await report(f)); const first = current(f).update;
  mutate(f, IDS[0], {update: {...first, expires_at: 1}}); await ok(await report(f)); assert.equal(current(f).update.expires_at, 1);
  installRelease(f, release(184)); await ok(await promote(f, 184)); await ok(await report(f)); assert.equal(current(f).update.versionCode, 184);
  mutate(f, IDS[0], {update: {...current(f).update, state: 'installing', expires_at: 1}});
  installRelease(f, release(186)); await ok(await promote(f, 186)); await ok(await report(f)); assert.equal(current(f).update.versionCode, 184);
});

test('暂停与重新推荐不清尝试记录，管理员原assign仍可明确重试', async () => {
  const f = await setup(); await ok(await promote(f)); await ok(await report(f)); const first = current(f).update;
  await ok(await f.post('/api/elfremote/assign', {action: 'pause_d31_auto_follow', channel: 'd31'}));
  assert.equal(f.data.get(POLICY).enabled, false);
  await ok(await report(f, payload(IDS[1]))); assert.equal(current(f, IDS[1]).update, undefined);
  mutate(f, IDS[0], {update: {...first, state: 'recovered'}}); await ok(await promote(f)); await ok(await report(f));
  assert.equal(current(f).update.job_id, first.job_id);
  await ok(await f.post('/api/elfremote/assign', {device_id: IDS[0], channel: 'd31', versionCode: 182, request_id: 'fixture-admin-explicit-retry'}));
  assert.notEqual(current(f).update.job_id, first.job_id); assert.equal(attempts(f).length, 1);
});

test('同制品重签再推荐不重试，DO重建后尝试记录仍有效', async () => {
  const f = await setup(); await ok(await promote(f)); await ok(await report(f));
  const previous = current(f).update.job_id;
  mutate(f, IDS[0], {update: {...current(f).update, state: 'recovered'}});
  installRelease(f, release(182, {job_id: 'fixture-resigned'})); await ok(await promote(f));
  await ok(await report(f)); assert.equal(current(f).update.job_id, previous);
  const restarted = fixture(Object.fromEntries(structuredClone(f.data)));
  restarted.env.D31_AUTO_FOLLOW_DEVICE_IDS = JSON.stringify(IDS);
  mutate(restarted, IDS[0], {update: {job_id: 'fixture-other', state: 'success', versionCode: 180}});
  await ok(await report(restarted)); assert.equal(current(restarted).update.job_id, 'fixture-other');
  assert.equal(attempts(restarted).length, 1);
});

test('分配写入失败不留下幂等占位，恢复存储后允许正常报告再试', async () => {
  const f = await setup(); await ok(await promote(f)); const put = f.storage.put;
  f.storage.put = async (key, value) => {
    if (key === 'remote_devices' && value.some(d => d.update?.request_id?.startsWith('auto-d31-')))
      throw Error('fixture-assignment-failure');
    return put(key, value);
  };
  const body = payload(); assert.equal((await report(f, body)).status, 503);
  assert.equal(current(f).update, undefined); assert.equal(attempts(f).length, 0);
  f.storage.put = put; await ok(await report(f, body)); assert.equal(attempts(f).length, 1);
});

test('GET目录只读推荐且不派发、不写尝试记录', async () => {
  const f = await setup(); await ok(await promote(f));
  const before = structuredClone(current(f)); const policy = structuredClone(f.data.get(POLICY));
  for (let n = 0; n < 3; n++) {
    const body = await ok(await f.get('/api/elfremote/releases?channel=d31'));
    assert.equal(body.auto_follow.versionCode, 182); assert.equal(body.auto_follow.device_ids, undefined);
    await ok(await f.get('/api/devices'));
  }
  assert.deepEqual(current(f), before); assert.deepEqual(f.data.get(POLICY), policy); assert.equal(attempts(f).length, 0);
  assert.equal((await ok(await f.get('/api/elfremote/releases?channel=d22'))).auto_follow, undefined);
});

test('幂等记录写失败则update和报告一起回滚，同报告重试只创建一次', async () => {
  const f = await setup(); await ok(await promote(f)); const put = f.storage.put; const body = payload();
  f.storage.put = async (key, value) => { if (key.startsWith(ATTEMPTS)) throw Error('fixture-storage-failure'); return put(key, value); };
  assert.equal((await report(f, body)).status, 503); assert.equal(current(f).update, undefined); assert.equal(attempts(f).length, 0);
  assert.equal([...f.data.keys()].some(key => key.includes(body.report_id)), false);
  f.storage.put = put; await ok(await report(f, body)); assert.equal(attempts(f).length, 1);
});

test('真实签名发布流程只入目录，不创建或推进正式推荐', async t => {
  const f = await setup(); const keys = generateKeyPairSync('rsa', {modulusLength: 2048});
  const original = crypto.subtle.importKey.bind(crypto.subtle);
  t.mock.method(crypto.subtle, 'importKey', (format, data, algorithm, ...rest) => original(format,
    algorithm.name === 'RSASSA-PKCS1-v1_5' ? keys.publicKey.export({type: 'spki', format: 'der'}) : data, algorithm, ...rest));
  f.env.ELF_ARTIFACTS = {async put() {}};
  const bytes = Buffer.from('fixture-apk-184'); const rel = release(184, {size: bytes.length, sha256: hash(bytes)});
  const input = {manifest_raw: rel.manifest_raw, signature: sign('sha256', Buffer.from(rel.manifest_raw), keys.privateKey).toString('hex'),
    apk_b64: bytes.toString('base64'), publish_only: true};
  await ok(await f.post('/api/elfremote/releases', input)); assert.equal(f.data.has(POLICY), false);
  await ok(await report(f)); assert.equal(current(f).update, undefined);
  await ok(await promote(f)); const policy = structuredClone(f.data.get(POLICY));
  await ok(await f.post('/api/elfremote/releases', input)); assert.deepEqual(f.data.get(POLICY), policy);
});

async function manualAssign(f, version) {
  return ok(await f.post('/api/elfremote/assign', {device_id: IDS[0], channel: 'd31', versionCode: version,
    request_id: 'fixture-manual-' + crypto.randomUUID()}));
}
async function progress(f, states) {
  for (const state of states) await ok(await f.post('/api/elfremote/update-progress',
    {device_id: IDS[0], token: TOKEN, job_id: current(f).update.job_id, state}));
}

test('同时间戳不同ID旧版本不能覆盖较新版本或触发较低版本分配', async () => {
  const f = await setup(); installRelease(f, release(184));
  const at = new Date(Date.now() - 1000).toISOString();
  await ok(await report(f, payload(IDS[0], {app_version: '1.0.184', reported_at: at})));
  await ok(await promote(f));
  const body = await ok(await report(f, payload(IDS[0], {app_version: '1.0.180', reported_at: at})));
  assert.equal(current(f).app_version, '1.0.184'); assert.equal(body.managed_update, undefined);
  assert.equal(current(f).update, undefined); assert.equal(attempts(f).length, 0);
});

test('手动失败后槽位被另一手动失败覆盖，原制品不能被自动重试', async () => {
  const f = await setup(); installRelease(f, release(184));
  await manualAssign(f, 182); await progress(f, ['claimed', 'rejected']);
  await manualAssign(f, 184); await progress(f, ['claimed', 'rejected']);
  const previous = current(f).update.job_id;
  await ok(await promote(f)); await ok(await report(f));
  assert.equal(current(f).update.job_id, previous); assert.equal(current(f).update.versionCode, 184);
  assert.equal(attempts(f).length, 2);
});

test('导入前未登记的旧手动失败在槽位替换前补记尝试', async () => {
  const f = await setup(); installRelease(f, release(184));
  mutate(f, IDS[0], {update: {job_id: 'old-manual-failed', state: 'recovered', versionCode: 182,
    manifest_raw: f.data.get(releaseKey('d31', 182)).manifest_raw}});
  await manualAssign(f, 184); await progress(f, ['claimed', 'rejected']);
  await ok(await promote(f)); await ok(await report(f));
  assert.equal(current(f).update.versionCode, 184); assert.equal(attempts(f).length, 2);
});

test('最近成功更新版本高于报告旧版本时不派发较低推荐', async () => {
  const f = await setup(); installRelease(f, release(184));
  await manualAssign(f, 184); await progress(f, ['claimed', 'installing', 'wait_health', 'success']);
  assert.equal(current(f).d31_auto_confirmed.versionCode, 184);
  await ok(await promote(f)); await ok(await report(f));
  assert.equal(current(f).update.versionCode, 184); assert.equal(current(f).update.state, 'success');
  assert.equal(attempts(f).length, 1);
});

test('成功版本依据不随更新槽位被过期pending覆盖而丢失', async () => {
  const f = await setup(); installRelease(f, release(184)); installRelease(f, release(186));
  await manualAssign(f, 184); await progress(f, ['claimed', 'installing', 'wait_health', 'success']);
  await manualAssign(f, 186); mutate(f, IDS[0], {update: {...current(f).update, expires_at: 1}});
  await ok(await promote(f)); await ok(await report(f));
  assert.equal(current(f).update.versionCode, 186); assert.equal(current(f).d31_auto_confirmed.versionCode, 184);
});

test('成功184后186回滚仍按真实报告184识别，允许新的188推荐', async () => {
  const f = await setup(); for (const vc of [184, 186, 188]) installRelease(f, release(vc));
  await manualAssign(f, 184); await progress(f, ['claimed', 'installing', 'wait_health', 'success']);
  await manualAssign(f, 186); await progress(f, ['claimed', 'installing', 'rollback', 'recovered']);
  assert.equal(current(f).d31_auto_confirmed.versionCode, 184);
  await ok(await promote(f, 188));
  const body = await ok(await report(f, payload(IDS[0], {app_version: '1.0.184'})));
  assert(body.managed_update); assert.equal(current(f).update.versionCode, 188);
});

test('无成功更新记录的186回滚不把失败目标当当前版本，180可跟随184', async () => {
  const f = await setup(); for (const vc of [184, 186]) installRelease(f, release(vc));
  await manualAssign(f, 186); await progress(f, ['claimed', 'installing', 'rollback', 'recovered']);
  await ok(await promote(f, 184)); await ok(await report(f)); assert.equal(current(f).update.versionCode, 184);
});

test('旧安装实例成功版本不冒充重新安装后的当前版本', async () => {
  const f = await setup(); installRelease(f, release(184));
  mutate(f, IDS[0], {installation_id: 'new-installation', d31_auto_confirmed: {
    versionCode: 184, installation_id: 'old-installation', job_id: 'old-success'}});
  await ok(await promote(f)); await ok(await report(f)); assert.equal(current(f).update.versionCode, 182);
});

test('当前版本不在目录或目录名称歧义仍保持不自动分配', async () => {
  for (const kind of ['missing', 'ambiguous']) {
    const f = await setup(); await ok(await promote(f));
    if (kind === 'missing') f.data.delete(releaseKey('d31', 180));
    else installRelease(f, release(181, {versionName: '1.0.180'}));
    await ok(await report(f)); assert.equal(current(f).update, undefined);
  }
});

test('缺失型号登记或重复登记拒绝推荐，推荐后丢失登记也不分配', async () => {
  for (const kind of ['unknown', 'missing', 'duplicate']) {
    const f = await setup();
    if (kind === 'unknown') mutate(f, IDS[0], {model_id: 'missing-model'});
    if (kind === 'missing') f.data.set('remote_device_models', models.filter(m => m.id !== 'mdl_d31'));
    if (kind === 'duplicate') f.data.set('remote_device_models', [...models, models[0]]);
    assert.equal((await promote(f)).status, 400);
  }
  const f = await setup(); await ok(await promote(f)); f.data.set('remote_device_models', []);
  await ok(await report(f)); assert.equal(current(f).update, undefined);
});

test('进度新增尝试记录写失败返回503并回滚进度，恢复后原号可重试', async () => {
  const f = await setup(); await manualAssign(f, 182); const job_id = current(f).update.job_id;
  for (const [key] of attempts(f)) f.data.delete(key);
  const put = f.storage.put; f.storage.put = async (key, value) => {
    if (key.startsWith(ATTEMPTS)) throw Error('fixture-record-failure'); return put(key, value);
  };
  const body = {device_id: IDS[0], token: TOKEN, job_id, state: 'claimed'};
  assert.equal((await f.post('/api/elfremote/update-progress', body)).status, 503);
  assert.equal(current(f).update.state, 'pending');
  f.storage.put = put; await ok(await f.post('/api/elfremote/update-progress', body));
  assert.equal(current(f).update.state, 'claimed');
});

test('d004正式状态GET分支仍可经DO单次读取', async () => {
  const f = await setup(); const body = await ok(await f.get('/api/devices/status-request?device_id=' + IDS[0]));
  assert.equal(body.request, null);
});
