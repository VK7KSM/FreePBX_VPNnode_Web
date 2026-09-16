import crypto from 'node:crypto';

const accountId=process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken=process.env.CLOUDFLARE_API_TOKEN;
const namespaceId='833409e1f96d4ef28334811dfec66b52';
const base='https://v.elfradio.net';
const expectedVersion='1.5.0-gateway-alpha57-companion-stage-ready';
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
  const response=await fetch(base+path,{...options,headers:{Cookie:`elf_admin=${token}`,Origin:base,'Content-Type':'application/json',...(options.headers||{})},signal:AbortSignal.timeout(30000)});
  const text=await response.text();
  let data;try{data=JSON.parse(text);}catch{throw Error(`${path} returned non-JSON (${response.status})`);}
  if(!response.ok||data.ok===false)throw Error(`${path} failed: ${response.status} ${data.msg||data.code||'unknown'}`);
  return data;
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const terminal=new Set(['success','failed','rejected','expired','cancelled']);
const stamp=()=>new Date().toISOString();
function publicGate(device){
  if(device.app_version!==expectedVersion)throw Error(`Unexpected Pixel version: ${device.app_version}`);
  if(device.update?.state!=='success'||device.update?.versionCode!==64)throw Error('Pixel alpha57 update is not successful');
  if(device.managed_pixel_companion_v1!==true)throw Error('Pixel companion capability is unavailable');
  if(device.gateway?.sip_registered!==true||device.gateway?.busy!==false)throw Error('Pixel SIP is not registered and idle');
  if(device.online!==true)throw Error('Pixel is not online');
}
function oneGateway(data){
  const gateways=(data.devices||[]).filter(device=>device.product_id==='elfremote_gateway');
  if(gateways.length!==1)throw Error(`Expected one Pixel Gateway, found ${gateways.length}`);
  return gateways[0];
}
function oneRawGateway(data,id){
  if(!Array.isArray(data))throw Error('remote_devices is not an array');
  const gateways=data.filter(device=>device.product_id==='elfremote_gateway');
  if(gateways.length!==1||gateways[0].id!==id)throw Error('Stored Pixel identity changed');
  return gateways[0];
}
function verifyTask(task,id){
  if(task?.id!==id||task.type!=='stage_pixel_companion')throw Error('Companion task identity mismatch');
  if(task.state!=='success'||task.detail!=='companion-staged-disabled')throw Error(`Companion task failed: ${task.state} ${task.detail||''}`);
  const result=task.result;
  if(!result||result.stage!=='pixel_companion'||result.action!=='staged'
      ||!['installed','unchanged','upgraded'].includes(result.state)||result.units_enabled!==false
      ||result.rollback_available!==true||result.legacy_modules!=='preserved')throw Error('Companion terminal result did not meet the disabled-stage contract');
}
function verifyRuntime(runtime){
  if(!runtime||runtime.schema_version!==1||runtime.assets_verified!==true||runtime.write_locked!==true
      ||runtime.mode!=='companion_staged'||runtime.recognized!==true||runtime.enabled!==true)throw Error('Pixel runtime is not in the expected staged mode');
  const companion=runtime.companion;
  if(!companion||companion.installed!==true||companion.disabled!==true||companion.recognized!==true
      ||companion.active!==false||companion.rollback_available!==true)throw Error('Pixel companion status is not safely staged');
  for(const unit of ['charge','audio','adb_tcp'])if(companion.units?.[unit]!==false)throw Error(`Pixel companion unit ${unit} is enabled`);
  for(const key of ['charge_bypass','sip_audio_access']){
    const module=runtime[key];
    if(!module||module.installed!==true||module.disabled!==false||module.recognized!==true||module.files_verified!==true)
      throw Error(`Legacy module ${key} was removed, disabled, or not verified`);
  }
}

try{
  const auth=await kv('GET','panel/auth');
  if(!auth?.revision)throw Error('Panel auth revision is unavailable');
  await kv('PUT',sessionKey,{revision:auth.revision,expires:Date.now()+3600000},3600);

  const initial=oneGateway(await web('/api/devices'));
  console.log(`::add-mask::${initial.id}`);
  publicGate(initial);
  if(initial.task&&['pending','claimed','running'].includes(initial.task.state))throw Error(`Pixel already has an inflight task: ${initial.task.type}`);
  console.log(JSON.stringify({phase:'preflight_passed',time:stamp(),app_version:initial.app_version,versionCode:initial.update.versionCode,
    update:initial.update.state,managed_pixel_companion_v1:true,sip_registered:true,busy:false,last_reported_at:initial.last_reported_at}));

  const taskId=`pixel-companion-stage-${crypto.randomUUID()}`;
  const requestedAt=Date.now(),expiresAt=requestedAt+25*60*1000;
  // This is the only mutating request in this acceptance run. Never retry it.
  const created=await web('/api/elfremote/task',{method:'POST',body:JSON.stringify({device_id:initial.id,id:taskId,
    type:'stage_pixel_companion',params:{},expires_at:expiresAt})});
  if(created.duplicate===true)throw Error('Companion task unexpectedly matched a prior request');
  if(created.task?.id!==taskId||created.task.type!=='stage_pixel_companion')throw Error('Companion task creation receipt mismatch');
  console.log(JSON.stringify({phase:'submitted',time:stamp(),task_id:taskId,expires_at:created.task.expires_at,
    state:created.task.state,detail:created.task.detail,params_empty:true}));

  const timeline=[];let task=created.task,last='';
  const deadline=Date.now()+8*60*1000;
  while(!terminal.has(task.state)&&Date.now()<deadline){
    await sleep(3000);
    task=(await web(`/api/elfremote/tasks?device_id=${encodeURIComponent(initial.id)}&task_id=${encodeURIComponent(taskId)}`)).task;
    const state=JSON.stringify({state:task?.state,detail:task?.detail,claimed_at:task?.claimed_at,started_at:task?.started_at,completed_at:task?.completed_at});
    if(state!==last){const event={observed_at:stamp(),...JSON.parse(state)};timeline.push(event);console.log(JSON.stringify({phase:'task_observation',task_id:taskId,...event}));last=state;}
  }
  if(!terminal.has(task?.state))throw Error('Companion task terminal state timed out');
  verifyTask(task,taskId);
  console.log(JSON.stringify({phase:'public_terminal',observed_at:stamp(),task_id:taskId,task},null,2));

  let finalPublic=null,finalRaw=null;
  const reportDeadline=Date.now()+4*60*1000;
  while(Date.now()<reportDeadline){
    finalPublic=oneGateway(await web('/api/devices'));
    finalRaw=oneRawGateway(await kv('GET','remote_devices'),initial.id);
    try{
      publicGate(finalPublic);verifyRuntime(finalRaw.pixel_runtime);
      if(Date.parse(finalRaw.last_reported_at||0)<requestedAt)throw Error('Final runtime report predates the companion task');
      break;
    }catch(error){
      if(Date.now()+5000>=reportDeadline)throw error;
      await sleep(5000);
    }
  }
  verifyRuntime(finalRaw.pixel_runtime);
  console.log(JSON.stringify({phase:'final_report',observed_at:stamp(),task_id:taskId,
    public:{app_version:finalPublic.app_version,update:finalPublic.update,managed_pixel_companion_v1:finalPublic.managed_pixel_companion_v1,
      gateway:finalPublic.gateway,last_seen:finalPublic.last_seen,last_reported_at:finalPublic.last_reported_at},
    pixel_runtime:finalRaw.pixel_runtime,timeline},null,2));
}finally{
  await kv('DELETE',sessionKey).catch(()=>{});
}
