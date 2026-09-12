// 账号用量只由低频定时任务采集，页面读取共享快照；不在浏览器请求中调用分析 API。
export const CF_USAGE_KEY = 'panel/cf-usage/v1';
export const CF_USAGE_INTERVAL = 15 * 60 * 1000;
const states = new WeakMap();
const LIMITS = { workers_requests:100000, kv_reads:100000, kv_writes:1000, kv_deletes:1000, kv_lists:1000, do_requests:100000, do_rows_read:5000000, do_rows_written:100000, r2_class_a:1000000, r2_class_b:10000000 };
const DEFINITIONS = [
  ['workers_requests','Workers','请求','day'],
  ['kv_reads','KV','读取','day'], ['kv_writes','KV','写入','day'], ['kv_deletes','KV','删除','day'], ['kv_lists','KV','列举','day'],
  ['do_requests','DO','请求','day'], ['do_rows_read','DO','读取行数','day'], ['do_rows_written','DO','写入行数','day'],
  ['r2_class_a','R2','A 类操作','month'], ['r2_class_b','R2','B 类操作','month'], ['r2_storage','R2','标准存储','capacity']
];
const CLASS_A = new Set(['ListBuckets','PutBucket','ListObjects','ListObjectsV2','PutObject','CopyObject','CompleteMultipartUpload','CreateMultipartUpload','ListMultipartUploads','UploadPart','UploadPartCopy','ListParts','PutBucketEncryption','PutBucketLifecycleConfiguration','PutBucketCors']);
const CLASS_B = new Set(['HeadBucket','HeadObject','GetObject','UsageSummary','GetBucketEncryption','GetBucketLocation','GetBucketLifecycleConfiguration','GetBucketCors']);
const NO_CHARGE = new Set(['DeleteObject','DeleteObjects','DeleteBucket','AbortMultipartUpload']);
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
function sum(rows, field='requests') {
  if(!Array.isArray(rows))return null;
  let total=0;
  for(const row of rows){const n=number(row?.sum?.[field]);if(n===null)return null;total+=n;}
  return total;
}
function metricRows(values, now, observed, env) {
  const end=new Date(now), day=end.toISOString().slice(0,10), month=day.slice(0,7);
  // 明确比较免费方案参考值，不声称这是 Cloudflare 账单或付费账号的硬限制。
  return DEFINITIONS.map(([id,service,label,period])=>({ id,service,label,period,used:number(values[id]),
    unit:period==='capacity'?'bytes':'count', limit:env.CF_USAGE_PLAN==='paid'?null:(LIMITS[id]??null),
    periodKey:period==='day'?day:period==='month'?month:null, observedAt:id==='r2_storage'?observed:null,
    ...(id==='r2_storage'?{freeMonthlyAverageBytes:10*1000*1000*1000}: {}) }));
}
function emptySnapshot(env, now, status='pending') {
  return {version:1, scope:'account', status, generatedAt:null, attemptedAt:null, nextAttemptAt:null,
    metrics:metricRows({},now,null,env), note:'账号全部项目 · 免费方案参考额度 · 统计有延迟'};
}
function stateFor(env) {
  const binding=env.SUB_STORE_KV;
  if(!binding)return null;
  let state=states.get(binding);
  if(!state){state={value:null,expires:0,reading:null,collecting:null};states.set(binding,state);}
  return state;
}
async function readStored(env, now, force=false) {
  const state=stateFor(env);
  if(!state)return null;
  if(!force&&state.expires>now)return state.value;
  if(!state.reading)state.reading=(async()=>{
    try {
      const value=await env.SUB_STORE_KV.get(CF_USAGE_KEY,{type:'json',cacheTtl:300});
      if(value?.version===1&&Array.isArray(value.metrics))state.value=value;
      state.expires=now+5*60*1000;
      return state.value;
    } catch {
      state.expires=now+5*60*1000;
      // 服务不可用时保留最后快照，不反复打 KV，也不把失败解释成零用量。
      return state.value;
    } finally {state.reading=null;}
  })();
  return state.reading;
}
export async function readCfUsage(env, options={}) {
  const now=options.now??Date.now();
  const value=await readStored(env,now);
  const snapshot=value||emptySnapshot(env,now,env.CF_USAGE_ENABLED==='1'||env.CF_ANALYTICS_API_TOKEN&&env.CF_ANALYTICS_ACCOUNT_ID?'pending':'unconfigured');
  return {...snapshot, stale:!snapshot.generatedAt||now-Date.parse(snapshot.generatedAt)>2*CF_USAGE_INTERVAL,
    // UTC 换日后保留旧值及所属日期，不能把旧周期数字贴上“今日”。
    currentDay:new Date(now).toISOString().slice(0,10), refreshAfterSeconds:900};
}
export async function cfUsageResponse(env) {
  return Response.json({ok:true,...await readCfUsage(env)},{headers:{'Cache-Control':'private, max-age=300','Vary':'Cookie','X-Content-Type-Options':'nosniff'}});
}
function errorFor(result, alias) {
  return result?.errors?.some(error=>!Array.isArray(error.path)||error.path.includes(alias));
}
async function analytics(env, fields, fetcher) {
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  try {
    const response=await fetcher('https://api.cloudflare.com/client/v4/graphql',{
      method:'POST', signal:controller.signal,
      headers:{Authorization:'Bearer '+env.CF_ANALYTICS_API_TOKEN,'Content-Type':'application/json'},
      body:JSON.stringify({query:'query { viewer { accounts(filter:{accountTag:'+JSON.stringify(env.CF_ANALYTICS_ACCOUNT_ID)+'}) { '+fields+' } } }'})
    });
    if(!response.ok)throw Error('分析服务暂不可用');
    const result=await response.json(),account=result?.data?.viewer?.accounts?.[0];
    return {result,account};
  } finally {clearTimeout(timer);}
}
function group(result, alias) {return result?.account&&!errorFor(result.result,alias)?result.account[alias]:null;}
export function decodeCfUsage(daily, operations, storage, now, env={}) {
  const values={workers_requests:sum(group(daily,'workers')),do_requests:sum(group(daily,'durable')),
    do_rows_read:sum(group(daily,'durableRows'),'rowsRead'),do_rows_written:sum(group(daily,'durableRows'),'rowsWritten')};
  const kv=group(daily,'kv');
  for(const [key,kind] of [['kv_reads','read'],['kv_writes','write'],['kv_deletes','delete'],['kv_lists','list']]){
    values[key]=Array.isArray(kv)&&kv.length<100?sum(kv.filter(row=>String(row.dimensions?.actionType).toLowerCase()===kind)):null;
  }
  const ops=group(operations,'operations');
  if(Array.isArray(ops)&&ops.length<100){
    let a=0,b=0,valid=true;
    for(const row of ops){
      if(row.dimensions?.storageClass!=='Standard')continue;
      const type=row.dimensions?.actionType,count=number(row.sum?.requests);
      if(count===null){valid=false;break;}
      if(CLASS_A.has(type))a+=count;
      else if(CLASS_B.has(type))b+=count;
      else if(!NO_CHARGE.has(type))valid=false;
    }
    values.r2_class_a=valid?a:null; values.r2_class_b=valid?b:null;
  }
  const stored=group(storage,'storage');let observed=null;
  // 同一桶取最近记录再相加；不能把多个历史时刻或不同桶的独立峰值当成当前总容量。
  if(Array.isArray(stored)&&stored.length>0&&stored.length<1000){
    const latest=new Map();let valid=true;
    for(const row of stored){
      if(row.dimensions?.storageClass!=='Standard')continue;
      const time=Date.parse(row.dimensions?.datetime),bucket=row.dimensions?.bucketName;
      if(!bucket||!Number.isFinite(time)||number(row.max?.payloadSize)===null||number(row.max?.metadataSize)===null){valid=false;break;}
      if(!latest.has(bucket)||latest.get(bucket).time<time)latest.set(bucket,{time,bytes:row.max.payloadSize+row.max.metadataSize});
    }
    if(valid&&latest.size){values.r2_storage=[...latest.values()].reduce((total,row)=>total+row.bytes,0);observed=new Date(Math.min(...[...latest.values()].map(row=>row.time))).toISOString();}
  }
  return metricRows(values,now,observed,env);
}
export async function collectCfUsage(env, options={}) {
  const now=options.now??Date.now(),state=stateFor(env);
  if(!state||!env.CF_ANALYTICS_API_TOKEN||!env.CF_ANALYTICS_ACCOUNT_ID)return {skipped:'unconfigured'};
  if(state.collecting)return state.collecting;
  state.collecting=(async()=>{
    const previous=await readStored(env,now);
    if(previous?.nextAttemptAt&&Date.parse(previous.nextAttemptAt)>now)return {skipped:'backoff'};
    const end=new Date(now).toISOString(),day=end.slice(0,10)+'T00:00:00Z',month=end.slice(0,7)+'-01T00:00:00Z';
    const filter=start=>'filter:{datetime_geq:'+JSON.stringify(start)+',datetime_lt:'+JSON.stringify(end)+'}';
    const fetcher=options.fetch||fetch;
    const results=await Promise.allSettled([
      analytics(env,'workers:workersInvocationsAdaptive(limit:1,'+filter(day)+'){sum{requests}} kv:kvOperationsAdaptiveGroups(limit:100,'+filter(day)+'){dimensions{actionType}sum{requests}} durable:durableObjectsInvocationsAdaptiveGroups(limit:1,'+filter(day)+'){sum{requests}} durableRows:durableObjectsPeriodicGroups(limit:1,'+filter(day)+'){sum{rowsRead rowsWritten}}',fetcher),
      analytics(env,'operations:r2OperationsAdaptiveGroups(limit:100,'+filter(month)+'){dimensions{actionType storageClass}sum{requests}}',fetcher),
      analytics(env,'storage:r2StorageAdaptiveGroups(limit:1000,'+filter(new Date(now-24*60*60*1000).toISOString())+',orderBy:[datetime_DESC]){dimensions{bucketName datetime storageClass}max{payloadSize metadataSize}}',fetcher)
    ]);
    const metrics=decodeCfUsage(...results.map(result=>result.status==='fulfilled'?result.value:null),now,env);
    const complete=metrics.every(metric=>metric.used!==null),any=metrics.some(metric=>metric.used!==null);
    // 个别指标失败时仍按十五分钟更新可用指标；只有全部失败才退避。
    const failures=any?0:Math.min((previous?.failures||0)+1,4);
    const snapshot={version:1,scope:'account',status:complete?'ok':any?'partial':'unavailable',generatedAt:any?end:previous?.generatedAt||null,
      attemptedAt:end,nextAttemptAt:new Date(any?(Math.floor(now/CF_USAGE_INTERVAL)+1)*CF_USAGE_INTERVAL:now+CF_USAGE_INTERVAL*Math.pow(2,failures)).toISOString(),failures,
      metrics:metrics.map(metric=>{
        const old=previous?.metrics?.find(row=>row.id===metric.id);
        return metric.used===null&&old?.used!=null?{...old,stale:true}:metric;
      }),note:'账号全部项目 · 免费方案参考额度 · 统计有延迟'};
    // 成功和失败均持久化退避时间；即使所有页面同时打开也不会触发分析查询。
    try {await env.SUB_STORE_KV.put(CF_USAGE_KEY,JSON.stringify(snapshot));}
    finally {state.value=snapshot;state.expires=now+5*60*1000;}
    return snapshot;
  })().finally(()=>{state.collecting=null;});
  return state.collecting;
}
export function scheduleCfUsage(event, env, ctx) {
  const now=Number(event.scheduledTime)||Date.now();
  if(Math.floor(now/60000)%15!==0)return;
  const work=collectCfUsage(env,{now}).catch(()=>{console.error('cf_usage_collection_failed');});
  ctx?.waitUntil(work);
  return work;
}
