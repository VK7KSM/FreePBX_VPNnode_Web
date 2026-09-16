import crypto from 'node:crypto';

const accountId=process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken=process.env.CLOUDFLARE_API_TOKEN;
const namespaceId='833409e1f96d4ef28334811dfec66b52';
const taskId='pixel-companion-stage-70482761-492c-4d23-a098-15f245bb178a';
const base='https://v.elfradio.net';
if(!accountId||!apiToken)throw Error('Cloudflare credentials are unavailable');

const cfHeaders={Authorization:`Bearer ${apiToken}`};
const kvUrl=key=>`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`;
async function kv(method,key,value,ttl){
  const url=new URL(kvUrl(key));if(ttl)url.searchParams.set('expiration_ttl',String(ttl));
  const response=await fetch(url,{method,headers:{...cfHeaders,...(value===undefined?{}:{'Content-Type':'application/json'})},body:value===undefined?undefined:JSON.stringify(value)});
  if(!response.ok)throw Error(`KV ${method} failed: ${response.status}`);return method==='GET'?response.json():null;
}
const token=crypto.randomBytes(32).toString('hex');
const digest=crypto.createHash('sha256').update(token).digest('hex');
const sessionKey=`panel/legacy-session/${digest}`;
async function web(path){
  const response=await fetch(base+path,{headers:{Cookie:`elf_admin=${token}`,Origin:base,'Content-Type':'application/json'},signal:AbortSignal.timeout(30000)});
  const data=await response.json();if(!response.ok||data.ok===false)throw Error(`${path} failed: ${response.status} ${data.msg||data.code||'unknown'}`);return data;
}
try{
  const auth=await kv('GET','panel/auth');if(!auth?.revision)throw Error('Panel auth revision is unavailable');
  await kv('PUT',sessionKey,{revision:auth.revision,expires:Date.now()+1800000},1800);
  const gateways=(await web('/api/devices')).devices.filter(device=>device.product_id==='elfremote_gateway');
  if(gateways.length!==1)throw Error(`Expected one Pixel Gateway, found ${gateways.length}`);
  const device=gateways[0];console.log(`::add-mask::${device.id}`);
  const task=(await web(`/api/elfremote/tasks?device_id=${encodeURIComponent(device.id)}&task_id=${encodeURIComponent(taskId)}`)).task;
  const result=task?.result||{};
  const checks={
    task_success:task?.state==='success'&&task?.detail==='companion-staged-disabled',
    units_enabled_false:result.units_enabled===false,
    task_rollback_available:result.rollback_available===true,
    task_legacy_preserved:result.legacy_modules==='preserved',
    sip_registered:device.gateway?.sip_registered===true,
    gateway_idle:device.gateway?.busy===false
  };
  console.log(JSON.stringify({phase:'readback',observed_at:new Date().toISOString(),task_id:taskId,task,
    public_device:{app_version:device.app_version,update:device.update,managed_pixel_companion_v1:device.managed_pixel_companion_v1,
      gateway:device.gateway,last_seen:device.last_seen,last_reported_at:device.last_reported_at},checks,
    pixel_runtime_publicly_available:false},null,2));
}finally{await kv('DELETE',sessionKey).catch(()=>{});}
