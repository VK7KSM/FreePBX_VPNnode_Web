// 低频管理配置使用KV；设备状态和任务仍由DO保存。
export const PANEL_GROUPS={
 proxy:['nodes','sub_token','cf_preferred_ip','admin_user'],
 sip:['sip_extensions','sip_groups','sip_gateways','sip_secrets','sip_config_rev','sip_heartbeat_token']
};
export const panelEnabled=env=>env.PANEL_KV_ENABLED==='1';
export function panelGroup(key){return Object.keys(PANEL_GROUPS).find(group=>PANEL_GROUPS[group].includes(key));}
const namespaces=new WeakMap();
const requestReads=new WeakMap();
// 登录资料（panel/auth、吊销标记、旧会话）在实例内存里缓存 60 秒：每个已登录请求本来要读 2 次 KV，
// 电话管理页每 2 秒一次的轮询一整天就逼近 10 万次/日的免费读额度（2026-09-24 实测 5.3 万次）。
// 代价：别的实例上的退出或改密码，最多 60 秒后才在本实例生效；本实例内的写入会立即作废缓存。
// 登录与改密码这两处要读最新口令，调用方传 fresh:true，不走这层缓存。
const MAX_READS=128,CONFIG_TTL=15000,AUTH_TTL=60000,ERROR_TTL=2000;
function readState(kv){let state=namespaces.get(kv);if(!state){state={reads:new Map(),epoch:0};namespaces.set(kv,state);}return state;}
function authKey(key){return key==='panel/auth'||key.startsWith('panel/revoked/')||key.startsWith('panel/legacy-session/');}
const copy=value=>value===undefined?undefined:structuredClone(value);
// Workers 的未完成 I/O 属于发起请求，不能让其他请求等待它；只复用已完成配置及同请求读取。
async function readKv(kv,key){
 let timer;
 try{return await Promise.race([
  kv.get(key,{type:'json',cacheTtl:30}),
  new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('KV读取超时，请稍后重试')),8000);})
 ]);}finally{clearTimeout(timer);}
}
export async function kvJson(env,key,{request,fresh=false}={}){
 const kv=env.SUB_STORE_KV,state=readState(kv),now=Date.now();
 let scoped;
 if(request&&!fresh){
  scoped=requestReads.get(request);if(!scoped){scoped=new Map();requestReads.set(request,scoped);}
  const previous=scoped.get(key);
  if(previous?.kv===kv&&previous.epoch===state.epoch)return copy(await previous.promise);
 }
 let entry=state.reads.get(key);
 if(fresh&&entry){entry.invalidated=true;state.reads.delete(key);entry=null;}
 if(entry?.pending)entry=null;
 if(entry&&!entry.pending&&entry.until<=now){state.reads.delete(key);entry=null;}
 if(!entry){
  entry={pending:true,until:0,invalidated:false,epoch:state.epoch};
  if(state.reads.size>=MAX_READS)state.reads.delete(state.reads.keys().next().value);
  state.reads.set(key,entry);
  const current=entry;
  entry.promise=Promise.resolve().then(()=>readKv(kv,key)).then(value=>{
   if(current.invalidated||current.epoch!==state.epoch)return kvJson(env,key);
   current.pending=false;current.until=Date.now()+(authKey(key)?AUTH_TTL:CONFIG_TTL);
   return value;
  },error=>{
   if(current.invalidated||current.epoch!==state.epoch)return kvJson(env,key);
   // 服务异常短暂合并，始终失败关闭，不回退到过期认证资料。
   current.pending=false;current.until=Date.now()+ERROR_TTL;throw error;
  });
 }
 if(scoped)scoped.set(key,{kv,epoch:state.epoch,promise:entry.promise});
 return copy(await entry.promise);
}
export function invalidateKvJson(env,key){
 const state=readState(env.SUB_STORE_KV),entry=state.reads.get(key);state.epoch++;
 if(entry)entry.invalidated=true;state.reads.delete(key);
}
export async function putKvJson(env,key,value,options){
 invalidateKvJson(env,key);
 try{await env.SUB_STORE_KV.put(key,JSON.stringify(value),options);}finally{invalidateKvJson(env,key);}
}
export async function deleteKvJson(env,key){
 invalidateKvJson(env,key);
 try{await env.SUB_STORE_KV.delete(key);}finally{invalidateKvJson(env,key);}
}
export async function panelRead(env,key){
 if(key.startsWith('geo_'))return kvJson(env,'panel/cache/'+key);
 const group=panelGroup(key);if(!group)return undefined;
 const cache=env.__panelReads||(env.__panelReads={});
 if(!cache[group])cache[group]=kvJson(env,'panel/'+group).catch(error=>{delete cache[group];throw error;});
 const bundle=await cache[group];if(!bundle)throw Error('管理配置尚未完成迁移');
 return bundle[key];
}
export async function panelWrite(env,patch){
 const groups=new Set(Object.keys(patch).map(panelGroup));
 if(groups.size!==1||groups.has(undefined))throw Error('配置必须按类别整份保存');
 const group=[...groups][0],current=await kvJson(env,'panel/'+group,{fresh:true});
 if(!current)throw Error('管理配置尚未完成迁移');
 const next={...current,...patch};await putKvJson(env,'panel/'+group,next);
 (env.__panelReads||(env.__panelReads={}))[group]=Promise.resolve(next);
}
