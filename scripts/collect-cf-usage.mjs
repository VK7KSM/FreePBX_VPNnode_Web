import fs from 'node:fs/promises';
import {collectCfUsage} from '../cf-usage.js';

// 外部备用采集复用 CI 凭据；Worker 主采集使用独立只读凭据。凭据不进入网页或统计快照。
const token=process.env.CLOUDFLARE_API_TOKEN,account=process.env.CLOUDFLARE_ACCOUNT_ID;
if(!token||!account)throw Error('缺少CF采集凭据配置');
const config=JSON.parse(await fs.readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
const namespace=config.kv_namespaces.find(row=>row.binding==='SUB_STORE_KV')?.id;
if(!namespace)throw Error('未找到共享快照存储');
const endpoint='https://api.cloudflare.com/client/v4/accounts/'+encodeURIComponent(account)+'/storage/kv/namespaces/'+encodeURIComponent(namespace)+'/values/';
async function request(key,options={}){
  const r=await fetch(endpoint+encodeURIComponent(key),{...options,headers:{Authorization:'Bearer '+token,...options.headers},signal:AbortSignal.timeout(15000)});
  if(r.status===404&&!options.method)return null;
  if(!r.ok)throw Error('CF快照存储暂不可用（'+r.status+'）');
  return r;
}
const env={CF_ANALYTICS_API_TOKEN:token,CF_ANALYTICS_ACCOUNT_ID:account,SUB_STORE_KV:{
  async get(key){const r=await request(key);return r?await r.json():null;},
  async put(key,value){await request(key,{method:'PUT',headers:{'Content-Type':'text/plain'},body:value});}
}};
const result=await collectCfUsage(env);
console.log(JSON.stringify({status:result.status||result.skipped,generatedAt:result.generatedAt||null,nextAttemptAt:result.nextAttemptAt||null}));
if(result.status==='unavailable')process.exitCode=1;
