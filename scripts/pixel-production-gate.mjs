import crypto from 'node:crypto';

const accountId=process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken=process.env.CLOUDFLARE_API_TOKEN;
const namespaceId='833409e1f96d4ef28334811dfec66b52';
const base='https://v.elfradio.net';
if(!accountId||!apiToken)throw Error('Cloudflare credentials are unavailable');

const cfHeaders={Authorization:`Bearer ${apiToken}`};
const kvUrl=key=>`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`;
async function kv(method,key,value,ttl){
  const url=new URL(kvUrl(key));
  if(ttl)url.searchParams.set('expiration_ttl',String(ttl));
  const response=await fetch(url,{method,headers:{...cfHeaders,...(value===undefined?{}:{'Content-Type':'application/json'})},body:value===undefined?undefined:JSON.stringify(value)});
  if(!response.ok)throw Error(`KV ${method} failed: ${response.status}`);
  return method==='GET'?response.json():null;
}

const token=crypto.randomBytes(32).toString('hex');
const digest=crypto.createHash('sha256').update(token).digest('hex');
const sessionKey=`panel/legacy-session/${digest}`;
async function web(path,options={}){
  const response=await fetch(base+path,{...options,headers:{Cookie:`elf_admin=${token}`,Origin:base,'Content-Type':'application/json',...(options.headers||{})}});
  const text=await response.text();
  let data;try{data=JSON.parse(text);}catch{throw Error(`${path} returned non-JSON (${response.status})`);}
  if(!response.ok||data.ok===false)throw Error(`${path} failed: ${response.status} ${data.msg||data.code||'unknown'}`);
  return data;
}

try{
  const auth=await kv('GET','panel/auth');
  if(!auth?.revision)throw Error('Panel auth revision is unavailable');
  await kv('PUT',sessionKey,{revision:auth.revision,expires:Date.now()+3600000},3600);
  const devices=await web('/api/devices');
  const gateways=(devices.devices||[]).filter(device=>device.product_id==='elfremote_gateway');
  if(gateways.length!==1)throw Error(`Expected one Pixel Gateway, found ${gateways.length}`);
  const device=gateways[0];
  console.log(`::add-mask::${device.id}`);
  const releases=await web(`/api/elfremote/releases?channel=gateway&device_id=${encodeURIComponent(device.id)}`);
  console.log(JSON.stringify({
    mode:'probe',
    gateway_count:gateways.length,
    app_version:device.app_version,
    online:device.online,
    contact_state:device.contact_state,
    last_seen:device.last_seen,
    managed_update:device.managed_update,
    managed_update_v2:device.managed_update_v2,
    managed_pixel_companion_v1:device.managed_pixel_companion_v1,
    gateway:device.gateway,
    update:device.update,
    proxy_runtime:device.proxy_runtime,
    releases:(releases.releases||[]).slice(0,5).map(({versionCode,versionName,sha256,size,expired})=>({versionCode,versionName,sha256,size,expired}))
  },null,2));
}finally{
  await kv('DELETE',sessionKey).catch(()=>{});
}
