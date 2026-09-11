// 低频管理配置使用KV；设备状态和任务仍由DO保存。
export const PANEL_GROUPS={
 proxy:['nodes','sub_token','cf_preferred_ip','admin_user'],
 sip:['sip_extensions','sip_groups','sip_gateways','sip_secrets','sip_config_rev','sip_heartbeat_token']
};
export const panelEnabled=env=>env.PANEL_KV_ENABLED==='1';
export function panelGroup(key){return Object.keys(PANEL_GROUPS).find(group=>PANEL_GROUPS[group].includes(key));}
export async function kvJson(env,key){return env.SUB_STORE_KV.get(key,{type:'json',cacheTtl:30});}
export async function panelRead(env,key){
 if(key.startsWith('geo_'))return kvJson(env,'panel/cache/'+key);
 const group=panelGroup(key);if(!group)return undefined;
 const cache=env.__panelReads||(env.__panelReads={});
 if(!cache[group])cache[group]=kvJson(env,'panel/'+group);
 const bundle=await cache[group];if(!bundle)throw Error('管理配置尚未完成迁移');
 return bundle[key];
}
export async function panelWrite(env,patch){
 const groups=new Set(Object.keys(patch).map(panelGroup));
 if(groups.size!==1||groups.has(undefined))throw Error('配置必须按类别整份保存');
 const group=[...groups][0],current=await kvJson(env,'panel/'+group);
 if(!current)throw Error('管理配置尚未完成迁移');
 const next={...current,...patch};await env.SUB_STORE_KV.put('panel/'+group,JSON.stringify(next));
 (env.__panelReads||(env.__panelReads={}))[group]=Promise.resolve(next);
}
