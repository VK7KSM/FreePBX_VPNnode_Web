import {RELEASE_CHANNELS,releaseKey,releaseListKey} from './release-channels.js';
const pendingKey='elfremote_apk_cleanup_pending';
const apkKey=k=>/^apks\/[a-f0-9]{64}$/.test(k||'');
export async function releaseRetentionPlan(read,devices){
  const channels={},remove=[],protect=new Set();
  for(const channel of Object.keys(RELEASE_CHANNELS)){
    const ids=[...new Set(await read(releaseListKey(channel))||[])].sort((a,b)=>b-a),rows=[];
    for(const id of ids){const r=await read(releaseKey(channel,id));if(r&&!r.retired_at)rows.push(r);}
    const active=new Set(devices.filter(d=>d.update?.job_id&&!['success','recovered','rejected'].includes(d.update.state)&&(d.update.channel||'d22')===channel).map(d=>d.update.versionCode));
    const keep=rows.filter((r,i)=>i<10||active.has(r.versionCode)),old=rows.filter(r=>!keep.includes(r));
    channels[channel]={keep:keep.map(r=>r.versionCode),remove:old.map(r=>r.versionCode)};
    for(const r of keep)if(apkKey(r.apk_key))protect.add(r.apk_key);
    for(const r of old)remove.push({channel,versionCode:r.versionCode,key:r.apk_key,size:r.size});
  }
  for(const d of devices){const u=d.update;if(!u?.job_id||['success','recovered','rejected'].includes(u.state))continue;try{const m=JSON.parse(u.manifest_raw);if(/^[a-f0-9]{64}$/.test(m.sha256||''))protect.add('apks/'+m.sha256);}catch{}}
  const keys=[...new Set(remove.map(r=>r.key).filter(k=>apkKey(k)&&!protect.has(k)))].sort();
  const raw=JSON.stringify({channels,keys}),bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw));
  const digest=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
  return {channels,keys,digest,remove};
}
export async function retireReleases(storage,read,devices,expected){
  const plan=await releaseRetentionPlan(read,devices);if(expected!==plan.digest)throw Error('发布清单已变化，请重新检查清理计划');
  for(const r of plan.remove){const key=releaseKey(r.channel,r.versionCode),old=await read(key);await storage.put(key,{...old,retired_at:Date.now()});}
  for(const [channel,values] of Object.entries(plan.channels))await storage.put(releaseListKey(channel),values.keep);
  const pending=await storage.get(pendingKey)||[];await storage.put(pendingKey,[...new Set([...pending,...plan.keys])]);
  await storage.put('elfremote_apk_retention_keep',10);
  return plan;
}
export async function cleanupRetiredReleases(storage,bucket){
  const pending=await storage.get(pendingKey)||[];if(!pending.length)return {purged:0,pending:0};
  if(!bucket)throw Error('制品存储不可用');
  // 在同一设备存储串行事务内重新检查引用；新发布复用相同APK时不能误删。
  const protectedKeys=new Set(),devices=await storage.get('remote_devices')||[];
  for(const channel of Object.keys(RELEASE_CHANNELS))for(const version of await storage.get(releaseListKey(channel))||[]){const r=await storage.get(releaseKey(channel,version));if(r&&!r.retired_at&&apkKey(r.apk_key))protectedKeys.add(r.apk_key);}
  for(const d of devices){const u=d.update;if(u?.job_id&&!['success','recovered','rejected'].includes(u.state))try{const m=JSON.parse(u.manifest_raw);if(/^[a-f0-9]{64}$/.test(m.sha256||''))protectedKeys.add('apks/'+m.sha256);}catch{}}
  const keys=pending.filter(k=>apkKey(k)&&!protectedKeys.has(k));
  if(keys.length)await bucket.delete(keys);
  await storage.put(pendingKey,[]);return {purged:keys.length,pending:0};
}
