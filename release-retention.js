import {RELEASE_CHANNELS,RELEASE_VARIANTS,releaseKey,releaseListKey} from './release-channels.js';
// 设备列表拆键之后 update 记录在 device_ext/<id> 里，只读 remote_devices 会看不到正在
// 进行中的更新，进而误删它正在下载的制品。清理时按同样的合并规则读。
async function mergedDevices(storage){
  const list=await storage.get('remote_devices')||[],out=[];
  for(const d of list){if(!d||!d.id){out.push(d);continue;}const ext=await storage.get('device_ext/'+encodeURIComponent(String(d.id)));out.push(ext&&typeof ext==='object'?{...ext,...d}:d);}
  return out;
}
const pendingKey='elfremote_apk_cleanup_pending';
const apkKey=k=>/^apks\/[a-f0-9]{64}$/.test(k||'');
export async function releaseRetentionPlan(read,devices){
  const channels={},remove=[],protect=new Set();
  for(const channel of Object.keys(RELEASE_CHANNELS)){
    const ids=[...new Set(await read(releaseListKey(channel))||[])].sort((a,b)=>b-a),rows=[];
    // 同一个版本码可能有全量包与精简包两条记录；保留与否按版本码决定，两个变体同进同出。
    // 以前只读全量那条：精简包既不在保留名单也不在删除名单，版本清理后成了永远读不到的孤儿。
    for(const id of ids){
      const variants=[];
      for(const variant of RELEASE_VARIANTS){const r=await read(releaseKey(channel,id,variant));if(r&&!r.retired_at)variants.push({...r,variant:r.variant||variant});}
      if(variants.length)rows.push({versionCode:id,variants});
    }
    const active=new Set(devices.filter(d=>d.update?.job_id&&!['success','recovered','rejected'].includes(d.update.state)&&(d.update.channel||'d22')===channel).map(d=>d.update.versionCode));
    const keep=rows.filter((r,i)=>i<10||active.has(r.versionCode)),old=rows.filter(r=>!keep.includes(r));
    channels[channel]={keep:keep.map(r=>r.versionCode),remove:old.map(r=>r.versionCode)};
    for(const r of keep)for(const v of r.variants)if(apkKey(v.apk_key))protect.add(v.apk_key);
    for(const r of old)for(const v of r.variants)remove.push({channel,versionCode:r.versionCode,variant:v.variant,key:v.apk_key,size:v.size});
  }
  for(const d of devices){const u=d.update;if(!u?.job_id||['success','recovered','rejected'].includes(u.state))continue;try{const m=JSON.parse(u.manifest_raw);if(/^[a-f0-9]{64}$/.test(m.sha256||''))protect.add('apks/'+m.sha256);}catch{}}
  const keys=[...new Set(remove.map(r=>r.key).filter(k=>apkKey(k)&&!protect.has(k)))].sort();
  const raw=JSON.stringify({channels,keys}),bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw));
  const digest=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
  return {channels,keys,digest,remove};
}
export async function retireReleases(storage,read,devices,expected){
  const plan=await releaseRetentionPlan(read,devices);if(expected!==plan.digest)throw Error('发布清单已变化，请重新检查清理计划');
  // 退休的同时删掉它的发布任务映射 elfremote_job_<id>（F14）：制品对象都要删了，映射留着只会长。
  for(const r of plan.remove){const key=releaseKey(r.channel,r.versionCode,r.variant),old=await read(key);if(old){await storage.put(key,{...old,retired_at:Date.now()});if(old.job_id)await storage.delete('elfremote_job_'+old.job_id);}}
  for(const [channel,values] of Object.entries(plan.channels))await storage.put(releaseListKey(channel),values.keep);
  const pending=await storage.get(pendingKey)||[];await storage.put(pendingKey,[...new Set([...pending,...plan.keys])]);
  await storage.put('elfremote_apk_retention_keep',10);
  return plan;
}
export async function cleanupRetiredReleases(storage,bucket){
  const pending=await storage.get(pendingKey)||[];if(!pending.length)return {purged:0,pending:0};
  if(!bucket)throw Error('制品存储不可用');
  // 在同一设备存储串行事务内重新检查引用；新发布复用相同APK时不能误删。
  const protectedKeys=new Set(),devices=await mergedDevices(storage);
  for(const channel of Object.keys(RELEASE_CHANNELS))for(const version of await storage.get(releaseListKey(channel))||[])for(const variant of RELEASE_VARIANTS){const r=await storage.get(releaseKey(channel,version,variant));if(r&&!r.retired_at&&apkKey(r.apk_key))protectedKeys.add(r.apk_key);}
  for(const d of devices){const u=d.update;if(u?.job_id&&!['success','recovered','rejected'].includes(u.state))try{const m=JSON.parse(u.manifest_raw);if(/^[a-f0-9]{64}$/.test(m.sha256||''))protectedKeys.add('apks/'+m.sha256);}catch{}}
  const keys=pending.filter(k=>apkKey(k)&&!protectedKeys.has(k));
  if(keys.length)await bucket.delete(keys);
  await storage.put(pendingKey,[]);return {purged:keys.length,pending:0};
}
