// 低频管理配置使用KV；设备状态和任务仍由DO保存。
export const PANEL_GROUPS={
 proxy:['nodes','sub_token','cf_preferred_ip','admin_user'],
 sip:['sip_extensions','sip_groups','sip_gateways','sip_secrets','sip_config_rev','sip_heartbeat_token']
};
export const panelEnabled=env=>env.PANEL_KV_ENABLED==='1';
export function panelGroup(key){return Object.keys(PANEL_GROUPS).find(group=>PANEL_GROUPS[group].includes(key));}
const namespaces=new WeakMap();
const requestReads=new WeakMap();
const MAX_READS=128,CONFIG_TTL=15000,ERROR_TTL=2000;
function readState(kv){let state=namespaces.get(kv);if(!state){state={reads:new Map(),epoch:0};namespaces.set(kv,state);}return state;}
function authKey(key){return key==='panel/auth'||key.startsWith('panel/revoked/')||key.startsWith('panel/legacy-session/');}
const copy=value=>value===undefined?undefined:structuredClone(value);
// 认证成功结果只复用于同一 HTTP 请求。跨请求仅合并在途读取，不叠加 KV 撤销缓存窗口。
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
 if(entry&&!entry.pending&&entry.until<=now){state.reads.delete(key);entry=null;}
 if(!entry){
  entry={pending:true,until:0,invalidated:false};
  if(state.reads.size>=MAX_READS)state.reads.delete(state.reads.keys().next().value);
  state.reads.set(key,entry);
  const current=entry;
  entry.promise=Promise.resolve().then(()=>kv.get(key,{type:'json',cacheTtl:30})).then(value=>{
   if(current.invalidated)return kvJson(env,key);
   current.pending=false;current.until=Date.now()+(authKey(key)?0:CONFIG_TTL);
   if(authKey(key)&&state.reads.get(key)===current)state.reads.delete(key);
   return value;
  },error=>{
   if(current.invalidated)return kvJson(env,key);
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
