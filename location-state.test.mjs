import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import worker from './worker.js';import {fixture,login,request} from './test-support.mjs';
import {normalizeLocationState, LOCATION_REASONS} from './location-state.js';

test('定位可用性：只收白名单原因，取值不合法就整条丢弃', () => {
  assert.deepEqual(normalizeLocationState({enabled:false,reason:'location_disabled',gps:false,fused:false,network:false}),
    {enabled:false,reason:'location_disabled',gps:false,fused:false,network:false});
  // 任一来源可用即算可用，不要求 GPS 开着：只开 Wi-Fi 与基站定位是正当配置
  const partial=normalizeLocationState({enabled:true,reason:'ok',gps:false,fused:true,network:true});
  assert.equal(partial.enabled,true);assert.equal(partial.gps,false);assert.equal(partial.network,true);
  // 失败关闭：原因不在白名单就返回 null，面板退回原有行为，不显示一个猜出来的原因
  for(const bad of [null,undefined,'x',42,[],{},{reason:'unknown'},{reason:''}])
    assert.equal(normalizeLocationState(bad),null,'不应接受 '+JSON.stringify(bad));
  // 缺失的布尔一律当假，不要把 undefined 透出去
  const sparse=normalizeLocationState({reason:'permission_denied'});
  assert.deepEqual(sparse,{enabled:false,reason:'permission_denied',gps:false,fused:false,network:false});
  assert.deepEqual([...LOCATION_REASONS],['ok','location_disabled','permission_denied','provider_unavailable']);
});

test('定位可用性随上报落库并出现在设备列表；不带该键的上报不清空', async () => {
  const token='synthetic-loc-token',id='synthetic-loc-device';
  const f=fixture({admin_pass:'fixture-password',remote_devices:[{id,model_id:'mdl_pixel3',paired:true,enabled:true,
    status_only:true,token_sha256:createHash('sha256').update(token).digest('hex')}]});
  const cookie=await login(f);
  let sequence=0;
  const report=async extra=>(await worker.fetch(request('/api/devices/report','POST',{device_id:id,token,status_only:true,
    report_id:'loc-'+(++sequence),sampled_at:new Date(Date.now()+sequence*1000).toISOString(),...extra}),f.env)).status;
  const shown=async()=>(await (await worker.fetch(request('/api/devices','GET',undefined,cookie),f.env)).json()).devices[0].location_state;

  assert.equal(await report({}),200);
  assert.equal(await shown(),null,'没报过就是 null');

  assert.equal(await report({location_state:{enabled:false,reason:'location_disabled',gps:false,fused:false,network:false}}),200);
  assert.equal((await shown()).reason,'location_disabled');

  // 只报状态、不带这个键的上报，不应该把上一次的判定清掉
  assert.equal(await report({}),200);
  assert.equal((await shown()).reason,'location_disabled','不带该键时保留上一次的判定');

  assert.equal(await report({location_state:{enabled:true,reason:'ok',gps:true,fused:true,network:true}}),200);
  assert.equal((await shown()).reason,'ok');

  // 设备报了个不认识的原因，服务端丢弃，面板退回原有行为
  assert.equal(await report({location_state:{enabled:false,reason:'something_new'}}),200);
  assert.equal(await shown(),null,'不认识的原因整条丢弃');
});
