import test from 'node:test';
import assert from 'node:assert/strict';
import {radioRequest,googleLocation,googleBillingMonth,googleAccounts} from './google-geolocation.js';

const now=1789017600000;
const radio=()=>({sampled_at_ms:now,wifiAccessPoints:[{macAddress:'10:11:22:33:44:55',signalStrength:-50,ssid:'不应转发'},
  {macAddress:'20:11:22:33:44:55',signalStrength:-60}],cellTowers:[]});
const environment=()=>{const values=new Map();return {GOOGLE_GEOLOCATION_API_KEY:'unit-test-only',__storage:{get:async k=>values.get(k),put:async(k,v)=>values.set(k,v)},values};};
const result=()=>Response.json({location:{lat:-33.8,lng:151.1},accuracy:43.3});

test('无线定位只转发必要参数，禁止Google退回服务器IP',()=>{
  const r=radio();r.wifiAccessPoints.push({macAddress:'02:11:22:33:44:55',signalStrength:-20},{macAddress:'ff:ff:ff:ff:ff:ff',signalStrength:-20},r.wifiAccessPoints[0]);
  const p=radioRequest(r,now);assert.equal(p.considerIp,false);assert.equal(p.wifiAccessPoints.length,2);
  assert.equal(JSON.stringify(p).includes('ssid'),false);assert.equal(JSON.stringify(p).includes('sampled_at'),false);
  assert.equal(radioRequest({...r,sampled_at_ms:now-900001},now),null);
  assert.equal(radioRequest({...r,sampled_at_ms:now+1},now),null);
  assert.equal(radioRequest({sampled_at_ms:now,wifiAccessPoints:[r.wifiAccessPoints[0]]},now),null);
});
test('LTE小区使用完整ECI，拒绝Android未知值和混用无线类型',()=>{
  const r={sampled_at_ms:now,radioType:'lte',cellTowers:[{cellId:17856323,locationAreaCode:321,mobileCountryCode:505,mobileNetworkCode:1,signalStrength:-96}]};
  assert.equal(radioRequest(r,now).cellTowers[0].cellId,17856323);
  assert.equal(radioRequest({...r,radioType:'gsm'},now),null);
  r.cellTowers[0].mobileCountryCode=2147483647;assert.equal(radioRequest(r,now),null);
});
test('GPS有效时不调用Google，不发送无线数据',async()=>{
  const out=await googleLocation(environment(),'test',{gps:{lat:1,lng:2},radio:radio()},now,()=>{throw Error('不得调用');});
  assert.equal(out.reason,'not_needed');
});
test('真实接口合同、来源及精度保留，同接入点短期不重复计费',async()=>{
  const env=environment();let calls=0;
  const request=async(url,options)=>{calls++;assert.equal(new URL(url).hostname,'www.googleapis.com');assert.equal(JSON.parse(options.body).considerIp,false);return result();};
  const first=await googleLocation(env,'test',{radio:radio()},now,request);
  assert.equal(first.location.source,'wifi');assert.equal(first.location.provider,'google');assert.equal(first.location.acc_m,43);
  const changed=radio();changed.sampled_at_ms+=60000;changed.wifiAccessPoints.reverse();changed.wifiAccessPoints[0].signalStrength=-65;
  const second=await googleLocation(env,'test',{radio:changed},now+60000,request);
  assert.deepEqual(second,first);assert.equal(calls,1);
  assert.equal(JSON.stringify([...env.values.values()]).includes('10:11:22'),false);
  await googleLocation(env,'test',{radio:{...radio(),sampled_at_ms:now+900001}},now+900001,request);assert.equal(calls,2);
});
test('基站与混合定位标注正确，不能标为GPS',async()=>{
  const cell={sampled_at_ms:now,radioType:'lte',cellTowers:[{cellId:123456,locationAreaCode:10,mobileCountryCode:505,mobileNetworkCode:1}]};
  assert.equal((await googleLocation(environment(),'c',{radio:cell},now,async()=>result())).location.source,'cell');
  assert.equal((await googleLocation(environment(),'c',{radio:{...radio(),...cell}},now,async()=>result())).location.source,'network');
});
test('额度、权限及服务失败不抛出阻塞上报的错误，短期不反复请求',async()=>{
  for(const [status,reason] of [[403,'access_denied'],[429,'quota_exceeded'],[404,'not_found'],[500,'http_500']]){
    const env=environment();let calls=0;const fetcher=async()=>{calls++;return new Response('',{status});};
    assert.deepEqual(await googleLocation(env,'t',{radio:radio()},now,fetcher),{location:null,reason});
    await googleLocation(env,'t',{radio:radio()},now+1000,fetcher);assert.equal(calls,1);
  }
  assert.equal((await googleLocation(environment(),'t',{radio:radio()},now,async()=>{throw Error('网络故障');})).reason,'unavailable');
  assert.equal((await googleLocation(environment(),'t',{radio:radio()},now,async()=>Response.json({error:{errors:[{reason:'dailyLimitExceeded'}]}},{status:403}))).reason,'quota_exceeded');
  assert.equal((await googleLocation(environment(),'t',{radio:radio()},now,async()=>Response.json({location:{lat:100,lng:0},accuracy:5}))).reason,'invalid_response');
});


test('独立结算账号到限切换，全部耗尽停止外呼，跨月恢复',async()=>{
 const env=environment();env.GOOGLE_GEOLOCATION_ACCOUNTS=JSON.stringify([{id:'first',key:'a',monthlyLimit:1},{id:'second',key:'b',monthlyLimit:1}]);
 const keys=[];const fetcher=async url=>{keys.push(new URL(url).searchParams.get('key'));return result();};
 for(const d of ['one','two'])assert.equal((await googleLocation(env,d,{radio:radio()},now,fetcher)).reason,'located');
 assert.equal((await googleLocation(env,'three',{radio:radio()},now,fetcher)).reason,'free_limit_reached');
 assert.deepEqual(keys,['a','b']);
 const later=Date.parse('2026-10-01T08:00:00Z');
 assert.equal((await googleLocation(env,'one',{radio:{...radio(),sampled_at_ms:later}},later,fetcher)).reason,'located');
 assert.deepEqual(keys,['a','b','a']);
 assert.equal(googleBillingMonth(Date.parse('2026-10-01T06:59:00Z')),'2026-09');
 assert.equal(googleBillingMonth(Date.parse('2026-10-01T07:00:00Z')),'2026-10');
});

test('接口额度拒绝自动切下一账号，失败请求仍记账，缓存命中不计费',async()=>{
 const env=environment();env.GOOGLE_GEOLOCATION_ACCOUNTS=JSON.stringify([{id:'first',key:'a'},{id:'second',key:'b'}]);
 let calls=0;const fetcher=async()=>++calls===1?Response.json({error:{status:'RESOURCE_EXHAUSTED'}},{status:403}):result();
 assert.equal((await googleLocation(env,'one',{radio:radio()},now,fetcher)).reason,'located');
 assert.equal((await googleLocation(env,'one',{radio:radio()},now,fetcher)).reason,'located');
 assert.equal(calls,2);assert.equal(env.values.get('google-usage/first').used,1);assert.equal(env.values.get('google-usage/second').used,1);
 assert.equal(JSON.stringify([...env.values.values()]).includes('"key"'),false);
});

test('配置不允许同账号或同密钥重复获得额度，无效JSON不退回无计数模式',()=>{
 assert.equal(googleAccounts({GOOGLE_GEOLOCATION_ACCOUNTS:'bad',GOOGLE_GEOLOCATION_API_KEY:'a'}).length,0);
 assert.equal(googleAccounts({GOOGLE_GEOLOCATION_ACCOUNTS:JSON.stringify([{id:'same',key:'a'},{id:'same',key:'b'},{id:'other',key:'a'}])}).length,1);
});
