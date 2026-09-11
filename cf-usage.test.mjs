import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {collectCfUsage,decodeCfUsage,readCfUsage,cfUsageResponse,scheduleCfUsage,CF_USAGE_KEY,CF_USAGE_INTERVAL} from './cf-usage.js';
import {cfUsageClientSource,cfUsageMarkup,cfUsageStyle} from './cf-usage-client.js';
const NOW=Date.parse('2026-09-12T01:30:00Z');
function envWith(value=null){
  const data=new Map(value?[[CF_USAGE_KEY,value]]:[]),calls={get:0,put:0};
  return {calls,data,env:{CF_ANALYTICS_API_TOKEN:'private-test-token',CF_ANALYTICS_ACCOUNT_ID:'test-account',SUB_STORE_KV:{
    async get(key){calls.get++;return data.get(key)||null;},async put(key,value){calls.put++;data.set(key,JSON.parse(value));}
  }}};
}
const wrap=account=>({account,result:{data:{viewer:{accounts:[account]}}}});
function fixtures(){return [wrap({workers:[{sum:{requests:75000}}],kv:[{dimensions:{actionType:'read'},sum:{requests:110000}},{dimensions:{actionType:'write'},sum:{requests:12}}],durable:[{sum:{requests:900}}],durableRows:[{sum:{rowsRead:25000,rowsWritten:400}}]}),
  wrap({operations:[{dimensions:{actionType:'PutObject',storageClass:'Standard'},sum:{requests:12}},{dimensions:{actionType:'GetObject',storageClass:'Standard'},sum:{requests:30}},{dimensions:{actionType:'DeleteObject',storageClass:'Standard'},sum:{requests:600}},{dimensions:{actionType:'GetObject',storageClass:'InfrequentAccess'},sum:{requests:500}}]}),
  wrap({storage:[{dimensions:{bucketName:'a',datetime:'2026-09-12T01:00:00Z',storageClass:'Standard'},max:{payloadSize:90,metadataSize:10}},{dimensions:{bucketName:'a',datetime:'2026-09-12T00:00:00Z',storageClass:'Standard'},max:{payloadSize:500,metadataSize:10}},{dimensions:{bucketName:'b',datetime:'2026-09-12T00:30:00Z',storageClass:'Standard'},max:{payloadSize:180,metadataSize:20}}]})];}
function fakeFetch(log, fail=false){return async(url,options)=>{
  log.push({url,options});if(fail)return new Response('',{status:503});
  const query=JSON.parse(options.body).query,index=query.includes('workers:')?0:query.includes('operations:')?1:2;
  return Response.json(fixtures()[index].result);
};}
test('用量按账号汇总并保留日/月/容量三个周期，R2 删除不计入收费操作',()=>{
  const metrics=decodeCfUsage(...fixtures(),NOW),map=Object.fromEntries(metrics.map(x=>[x.id,x]));
  assert.equal(map.workers_requests.used,75000);assert.equal(map.kv_reads.used,110000);
  assert.equal(map.kv_deletes.used,0);assert.equal(map.r2_class_a.used,12);assert.equal(map.r2_class_b.used,30);
  assert.equal(map.r2_storage.used,300);assert.equal(map.r2_storage.limit,null);
  assert.equal(map.r2_storage.observedAt,'2026-09-12T00:30:00.000Z');
  assert.equal(map.workers_requests.periodKey,'2026-09-12');assert.equal(map.r2_class_a.periodKey,'2026-09');
  assert.equal(map.r2_storage.freeMonthlyAverageBytes,10000000000);
});
test('缺权限、未知指标、未知 R2 操作和容量截断不得显示为零',()=>{
  const f=fixtures();f[0].result.errors=[{path:['viewer','accounts',0,'workers'],message:'denied'}];
  f[1].account.operations.push({dimensions:{actionType:'NewBillableOperation',storageClass:'Standard'},sum:{requests:1}});
  f[2].account.storage=Array(1000).fill(f[2].account.storage[0]);
  const metrics=decodeCfUsage(...f,NOW),map=Object.fromEntries(metrics.map(x=>[x.id,x]));
  assert.equal(map.workers_requests.used,null);assert.equal(map.kv_reads.used,110000);
  assert.equal(map.r2_class_a.used,null);assert.equal(map.r2_storage.used,null);
  assert.ok(decodeCfUsage(null,null,null,NOW).every(x=>x.used===null));
});
test('并发页面读取合并一次 KV，读取不会采集，快照无密钥及账号标识',async()=>{
  const {env,calls}=envWith();
  const rows=await Promise.all(Array.from({length:30},()=>readCfUsage(env,{now:NOW})));
  assert.equal(calls.get,1);assert.equal(calls.put,0);assert.equal(rows[0].status,'pending');
  assert.ok(rows[0].metrics.every(x=>x.used===null));
  assert.doesNotMatch(JSON.stringify(rows),/private-test-token|test-account/);
});
test('KV 故障缓存五分钟，不因同时打开多个页面放大故障',async()=>{
  let gets=0;const env={SUB_STORE_KV:{async get(){gets++;throw Error('quota');}}};
  await Promise.all(Array.from({length:20},()=>readCfUsage(env,{now:NOW})));
  await readCfUsage(env,{now:NOW+60000});assert.equal(gets,1);
  await readCfUsage(env,{now:NOW+300001});assert.equal(gets,2);
});
test('并发采集合并三次 GraphQL 请求一次共享快照写入，后续命中退避门',async()=>{
  const {env,calls,data}=envWith(),requests=[];
  const results=await Promise.all(Array.from({length:10},()=>collectCfUsage(env,{now:NOW,fetch:fakeFetch(requests)})));
  assert.equal(requests.length,3);assert.equal(calls.put,1);assert.equal(results[0].status,'ok');
  assert.equal(data.get(CF_USAGE_KEY).nextAttemptAt,new Date(NOW+CF_USAGE_INTERVAL).toISOString());
  await collectCfUsage(env,{now:NOW+60000,fetch:fakeFetch(requests)});assert.equal(requests.length,3);
  assert.ok(requests.every(x=>x.url==='https://api.cloudflare.com/client/v4/graphql'));
  assert.doesNotMatch(JSON.stringify(results),/private-test-token|test-account/);
});
test('采集失败保留上次值与周期并持久化退避，跨日不冒充今日',async()=>{
  const {env,data}=envWith(),requests=[];await collectCfUsage(env,{now:NOW,fetch:fakeFetch(requests)});
  const later=NOW+86400000;const result=await collectCfUsage(env,{now:later,fetch:fakeFetch(requests,true)});
  assert.equal(result.status,'unavailable');assert.equal(result.metrics[0].used,75000);assert.equal(result.metrics[0].stale,true);
  assert.equal(result.metrics[0].periodKey,'2026-09-12');assert.equal(result.generatedAt,new Date(NOW).toISOString());
  assert.ok(Date.parse(result.nextAttemptAt)>=later+1800000);assert.equal(data.get(CF_USAGE_KEY).failures,1);
  const read=await readCfUsage(env,{now:later});assert.equal(read.currentDay,'2026-09-13');assert.equal(read.stale,true);
});
test('未配置凭据不会产生分析请求或 KV 写入，付费方案不套用免费硬限',async()=>{
  const {env,calls}=envWith();delete env.CF_ANALYTICS_API_TOKEN;
  assert.deepEqual(await collectCfUsage(env,{now:NOW,fetch:()=>{throw Error('must not fetch');}}),{skipped:'unconfigured'});
  assert.equal(calls.put,0);assert.equal((await readCfUsage(env,{now:NOW})).status,'unconfigured');
  assert.ok(decodeCfUsage(...fixtures(),NOW,{CF_USAGE_PLAN:'paid'}).every(x=>x.limit===null));
});
test('定时接线仅每十五分钟触发，API 为私有缓存且不返回缓存存储键',async()=>{
  const {env}=envWith();delete env.CF_ANALYTICS_API_TOKEN;let waits=0;const ctx={waitUntil(p){waits++;return p;}};
  scheduleCfUsage({scheduledTime:NOW+60000},env,ctx);assert.equal(waits,0);
  scheduleCfUsage({scheduledTime:NOW},env,ctx);assert.equal(waits,1);
  const response=await cfUsageResponse(env);assert.equal(response.status,200);
  assert.equal(response.headers.get('Cache-Control'),'private, max-age=300');assert.equal(response.headers.get('Vary'),'Cookie');
  assert.doesNotMatch(await response.text(),/panel\/cf-usage|private-test-token/);
});
test('浏览器脚本语法成立，独立导航组件包含四服务及键盘展开入口',()=>{
  assert.doesNotThrow(()=>new vm.Script(cfUsageClientSource));
  assert.match(cfUsageMarkup,/<details/);assert.match(cfUsageMarkup,/Cloudflare 服务用量/);
  for(const label of ['Workers','KV','DO','R2'])assert.ok(cfUsageMarkup.includes(label));
  assert.match(cfUsageStyle,/width:232px/);assert.doesNotMatch(cfUsageClientSource,/api\.cloudflare\.com|Bearer/);
});
