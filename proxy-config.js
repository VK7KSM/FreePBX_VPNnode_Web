import {authJson as json} from './admin-auth.js';

export const PROXY_CONFIG_MAX_BYTES=2*1024*1024;
const DEFAULT_BASE_URL='https://v.elfradio.net';
const active=task=>task&&['pending','claimed','running'].includes(task.state)&&Number(task.expires_at)>Date.now();
const hex=bytes=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,96}$/.test(value);
const validTaskId=value=>typeof value==='string'&&/^[A-Za-z0-9-]{1,96}$/.test(value);
const validSha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

async function sha256(value){return hex(await crypto.subtle.digest('SHA-256',value));}
async function objectKey(deviceId,digest){return 'proxy-configs/'+await sha256(new TextEncoder().encode(deviceId))+'/'+digest;}
function version(value){
  value=String(value||'').trim();
  if(!value||value.length>64||/[\x00-\x1f\x7f]/.test(value))throw Error('代理配置版本无效');
  return value;
}
export function publicProxyConfig(value){
  if(!value)return null;
  return {version:value.version,sha256:value.sha256,size:value.size,uploaded_at:value.uploaded_at};
}
/**
 * 代理核心的下发形状。核心是设备以 root 执行的裸二进制，**只校验服务端回的 sha256 挡不住源头被换**——
 * 服务端被改，哈希也跟着改。所以带的是上传时那对「签名清单 + 签名」：设备用内置公钥验签，
 * 通过之后才按清单里的 size/sha256 校验下载到的字节。与 APK 更新走的是同一套验签代码。
 * 下载地址在清单里（`/api/elfremote/apk/<job_id>`，job_id 本身就是凭据），不另发令牌。
 * 没有可用的核心发布时返回 null，任务里就不带 core 这一段，设备按「核心不在」处理。
 */
export function proxyCoreParams(release){
  if(!release||typeof release.manifest_raw!=='string'||!/^(?:[0-9a-f]{2})+$/i.test(release.signature||''))return null;
  return {manifest_raw:release.manifest_raw,signature:release.signature};
}

export async function proxyConfigureParams(device,input,taskId,existing=null,baseUrl=DEFAULT_BASE_URL,core=null){
  // 按能力位放行，不按产品型号。原来硬判 product_id==='elfremote_gateway'，
  // D31 这类同样实现了代理管理的机型一概进不来；为一台设备改公共合同是更糟的做法。
  if(!device||device.managed_proxy_tasks!==true)throw Error('客户端尚未支持代理管理');
  if(input==null||typeof input!=='object'||Array.isArray(input))throw Error('代理任务参数无效');
  if(Object.keys(input).length===0)return {};
  if(!validTaskId(taskId))throw Error('代理任务编号无效');
  const meta=device.proxy_config;
  if(!meta||!validSha(meta.sha256)||!Number.isInteger(meta.size)||meta.size<2||meta.size>PROXY_CONFIG_MAX_BYTES)throw Error('请先上传代理配置');
  const fields=['config_version','config_sha256','config_size'];
  if(Object.keys(input).length!==fields.length||Object.keys(input).some(key=>!fields.includes(key)))throw Error('代理配置引用无效');
  if(input.config_version!==meta.version||input.config_sha256!==meta.sha256||input.config_size!==meta.size)throw Error('代理配置已变化，请重新选择');
  if(existing?.type==='configure_proxy'&&existing.id===taskId&&existing.params?.sha256===meta.sha256
      &&existing.params?.size===meta.size&&existing.params?.version===meta.version
      &&typeof existing.params.url==='string'
      &&JSON.stringify(existing.params.core??null)===JSON.stringify(proxyCoreParams(core))
      &&validSha(existing.proxy_download_token_sha256))
    return {params:existing.params,token_sha256:existing.proxy_download_token_sha256};
  const token=hex(crypto.getRandomValues(new Uint8Array(32)));
  const query=new URLSearchParams({device_id:device.id,token});
  // version 一并下发：设备的看门狗回退时要报「退回了哪一版」，
  // 拿 sha256 前几位当版本号是设备侧自己编的，对不上管理员在页面上看到的那个。
  const coreParams=proxyCoreParams(core);
  return {params:{url:baseUrl+'/api/elfremote/proxy-config/'+taskId+'?'+query,
    version:meta.version,size:meta.size,sha256:meta.sha256,...(coreParams?{core:coreParams}:{})},
    token_sha256:await sha256(new TextEncoder().encode(token))};
}

export async function proxyConfigMetadata(storage,request,loadDevices,saveDevices,now=Date.now()){
  try{
    const data=await request.json();
    if(!data||typeof data!=='object'||Array.isArray(data))throw Error('代理配置请求无效');
    const devices=await loadDevices(),device=devices.find(row=>row.id===data.device_id);
    if(!device||device.product_id!=='elfremote_gateway')return json({ok:false,msg:'未找到Pixel Gateway'},404);
    if(data.action==='authorize'){
      if(!validTaskId(data.task_id)||typeof data.token!=='string'||!/^[a-f0-9]{64}$/.test(data.token))return json({ok:false,msg:'下载凭证无效'},401);
      const task=device.task,meta=device.proxy_config;
      if(device.enabled===false||!active(task)||task.id!==data.task_id||task.type!=='configure_proxy'||task.cancel_requested
        ||!meta||task.params?.sha256!==meta.sha256||task.params?.size!==meta.size
        ||task.proxy_download_token_sha256!==await sha256(new TextEncoder().encode(data.token)))
        return json({ok:false,msg:'代理配置任务已停止或不匹配'},409);
      return json({ok:true,object_key:meta.object_key,config:publicProxyConfig(meta)});
    }
    if(data.action==='preflight'){
      if(device.enabled===false||device.managed_proxy_tasks!==true)return json({ok:false,msg:'客户端尚未支持代理管理'},409);
      if(active(device.task))return json({ok:false,msg:'已有任务进行中'},409);
      return json({ok:true,previous_object_key:device.proxy_config?.object_key||null});
    }
    if(data.action==='register'){
      const allowed=['action','device_id','version','sha256','size','object_key'];
      if(Object.keys(data).length!==allowed.length||Object.keys(data).some(key=>!allowed.includes(key)))throw Error('代理配置元数据字段无效');
      if(device.enabled===false||device.managed_proxy_tasks!==true)return json({ok:false,msg:'客户端尚未支持代理管理'},409);
      if(active(device.task))return json({ok:false,msg:'已有任务进行中'},409);
      if(!validSha(data.sha256)||!Number.isInteger(data.size)||data.size<2||data.size>PROXY_CONFIG_MAX_BYTES
        ||typeof data.object_key!=='string'||data.object_key!==await objectKey(device.id,data.sha256))throw Error('代理配置元数据无效');
      device.proxy_config={version:version(data.version),sha256:data.sha256,size:data.size,object_key:data.object_key,uploaded_at:new Date(now).toISOString()};
      await saveDevices(devices);
      return json({ok:true,config:publicProxyConfig(device.proxy_config)});
    }
    return json({ok:false,msg:'代理配置操作无效'},400);
  }catch(error){return json({ok:false,msg:error.message},400);}
}

async function rpc(stub,data){return stub.fetch('https://elf-store/__proxy_config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});}
export async function proxyConfigHttp(env,request,stub){
  try{
    if(!env.ELF_ARTIFACTS)return json({ok:false,msg:'代理配置存储未配置'},503);
    const url=new URL(request.url);
    if(url.pathname==='/api/elfremote/proxy-config'&&request.method==='POST'){
      const deviceId=url.searchParams.get('device_id'),configVersion=version(url.searchParams.get('version'));
      if(!validId(deviceId))throw Error('设备编号无效');
      const declaredHeader=request.headers.get('Content-Length'),declared=declaredHeader===null?null:Number(declaredHeader);
      if(declared!==null&&(!Number.isFinite(declared)||declared<2||declared>PROXY_CONFIG_MAX_BYTES))throw Error('代理配置大小须为2字节至2 MiB');
      const preflight=await rpc(stub,{action:'preflight',device_id:deviceId});if(!preflight.ok)return preflight;
      const before=await preflight.json(),bytes=new Uint8Array(await request.arrayBuffer());
      if(bytes.length<2||bytes.length>PROXY_CONFIG_MAX_BYTES)throw Error('代理配置大小须为2字节至2 MiB');
      const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(text.includes('\0'))throw Error('代理配置内容无效');
      const digest=await sha256(bytes),key=await objectKey(deviceId,digest);
      await env.ELF_ARTIFACTS.put(key,bytes,{httpMetadata:{contentType:'application/yaml; charset=utf-8'}});
      const registered=await rpc(stub,{action:'register',device_id:deviceId,version:configVersion,sha256:digest,size:bytes.length,object_key:key});
      if(!registered.ok){if(before.previous_object_key!==key)try{await env.ELF_ARTIFACTS.delete(key);}catch{console.error('proxy_config_cleanup_pending');}return registered;}
      if(before.previous_object_key&&before.previous_object_key!==key)try{await env.ELF_ARTIFACTS.delete(before.previous_object_key);}catch{console.error('proxy_config_cleanup_pending');}
      return registered;
    }
    const match=url.pathname.match(/^\/api\/elfremote\/proxy-config\/([A-Za-z0-9-]{1,96})$/);
    if(match&&request.method==='GET'){
      const auth=await rpc(stub,{action:'authorize',device_id:url.searchParams.get('device_id'),task_id:match[1],
        token:url.searchParams.get('token')});
      if(!auth.ok)return auth;
      const grant=await auth.json(),object=await env.ELF_ARTIFACTS.get(grant.object_key);
      if(!object)return json({ok:false,msg:'代理配置制品不可用'},503);
      return new Response(object.body,{headers:{'Content-Type':'application/yaml; charset=utf-8','Cache-Control':'no-store',
        'Content-Disposition':'attachment; filename=proxy-config.yaml','X-Content-Type-Options':'nosniff',
        'X-Content-SHA256':grant.config.sha256,'Content-Length':String(grant.config.size)}});
    }
    return json({ok:false},405);
  }catch(error){return json({ok:false,msg:error.message},400);}
}
