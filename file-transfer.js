import {authJson as json} from './admin-auth.js';

export const FILE_CHUNK = 8 * 1024 * 1024;
export const FILE_MAX = 4 * 1024 * 1024 * 1024;
const TTL = 7 * 86400000;
const validId = value => /^[a-f0-9]{32}$/.test(value || '');
const validSha = value => /^[a-f0-9]{64}$/.test(value || '');
const key = id => 'file-transfer/' + id;
export const chunkKey = (m, i, sha) => `device-files/${m.id}/${i}-${sha}`;
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2,'0')).join('');

export function fileParams(p = {}) {
  if (!validId(p.transfer_id)) throw Error('文件编号无效');
  if (typeof p.path !== 'string' || !p.path.startsWith('/') || p.path.endsWith('/') || p.path.length > 512
      || /[\x00-\x1f\x7f]/.test(p.path) || p.path.split('/').some(s => s === '.' || s === '..')) throw Error('请填写设备上的完整文件路径');
  return {transfer_id:p.transfer_id,path:p.path,allow_cellular:true,overwrite:p.overwrite===true};
}

// 这里只处理小型元数据；二进制正文永远不进入设备共用事务。
export async function fileMetadata(storage, request, loadDevices, now = Date.now()) {
  try {
    const data = await request.json();
    if (data.action === 'cleanup') {
      const entries = await storage.list({prefix:'file-transfer/'}), removed=[];
      for (const [k,m] of entries) if ((m.expires_at <= now || (m.state==='delivered'&&!m.purged)) && removed.length < 4) {
        removed.push(m);
      }
      return json({ok:true,removed});
    }
    if (data.action === 'init') {
      if (!Number.isSafeInteger(data.size) || data.size < 0 || data.size > FILE_MAX) throw Error('文件最大支持4 GB');
      if (typeof data.name !== 'string' || !data.name || data.name.length > 255) throw Error('文件名无效');
      const device=(await loadDevices()).find(d=>d.id===data.device_id);
      if (!device || device.enabled===false || !device.managed_file_tasks) return json({ok:false,msg:'客户端尚未支持文件接收'},409);
      const id=crypto.randomUUID().replaceAll('-','');
      const m={id,device_id:device.id,name:data.name,size:data.size,chunk_size:FILE_CHUNK,parts:{},state:'uploading',expires_at:now+TTL};
      await storage.put(key(id),m);return json({ok:true,file:m});
    }
    if (!validId(data.id)) throw Error('文件编号无效');
    const m=await storage.get(key(data.id));
    if(data.action==='cleanup_done') {
      if(m && m.expires_at<=now)await storage.delete(key(data.id));
      else if(m?.state==='delivered'){m.purged=true;m.parts={};await storage.put(key(data.id),m);}
      return json({ok:true});
    }
    if(data.action==='delivered'){
      if(m){m.state='delivered';m.delivered_at=now;await storage.put(key(data.id),m);}return json({ok:true,file:m});
    }
    if (!m || m.expires_at<=now) return json({ok:false,msg:'文件已过期，请重新上传'},404);
    if (data.action==='authorize') {
      const d=(await loadDevices()).find(d=>d.id===data.device_id);
      const tokenSha=hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(data.token||'')));
      if (!d || !d.token_sha256 || d.token_sha256!==tokenSha) return json({ok:false,msg:'设备凭证无效'},401);
      if (d.enabled===false || d.id!==m.device_id || m.state!=='ready' || d.task?.id!==data.task_id
          || d.task?.type!=='send_file' || d.task.params.transfer_id!==m.id || d.task.cancel_requested
          || !['pending','claimed','running'].includes(d.task.state) || Number(d.task.expires_at)<=now) return json({ok:false,msg:'文件任务已停止或不匹配'},409);
    } else if (data.action==='part') {
      const count=Math.ceil(m.size/FILE_CHUNK),expected=Math.min(FILE_CHUNK,m.size-data.index*FILE_CHUNK);
      if (!Number.isInteger(data.index) || data.index<0 || data.index>=count || data.bytes!==expected || !validSha(data.sha256)) throw Error('文件分块无效');
      const old=m.parts[data.index];
      if (old && old.sha256!==data.sha256) return json({ok:false,msg:'文件内容已变化，请重新上传'},409);
      if (m.state!=='uploading' && !old) return json({ok:false,msg:'文件已封存'},409);
      m.parts[data.index]={bytes:data.bytes,sha256:data.sha256};await storage.put(key(m.id),m);
    } else if (data.action==='complete') {
      if (!validSha(data.sha256)) throw Error('文件校验值无效');
      if (m.state==='ready' && m.sha256!==data.sha256) return json({ok:false,msg:'文件已封存'},409);
      const count=Math.ceil(m.size/FILE_CHUNK);
      for(let i=0;i<count;i++) if(!m.parts[i]) throw Error('文件尚未上传完整');
      m.sha256=data.sha256;m.state='ready';await storage.put(key(m.id),m);
    } else if (data.action!=='get') throw Error('文件操作无效');
    return json({ok:true,file:m});
  } catch(error) {return json({ok:false,msg:error.message},400);}
}

export async function validateFileTask(storage, deviceId, params,completedRetry=false) {
  const p=fileParams(params), m=await storage.get(key(p.transfer_id));
  if(!m || !(m.state==='ready'||(completedRetry&&m.state==='delivered')) || m.device_id!==deviceId || m.expires_at<=Date.now()) throw Error('文件尚未上传完整或已过期');
  return {...p,size:m.size,sha256:m.sha256,chunk_size:m.chunk_size};
}

export async function cleanupDeliveredFile(env,stub,id){
  if(!env.ELF_ARTIFACTS||!validId(id))return;
  const result=await rpc(stub,{action:'delivered',id});if(!result.ok)throw Error('文件清理状态未保存');
  let cursor;do{const listed=await env.ELF_ARTIFACTS.list({prefix:`device-files/${id}/`,cursor,limit:1000});if(listed.objects.length)await env.ELF_ARTIFACTS.delete(listed.objects.map(o=>o.key));cursor=listed.truncated?listed.cursor:undefined;}while(cursor);
  await rpc(stub,{action:'cleanup_done',id});
}

async function rpc(stub, data) {
  return stub.fetch('https://elf-store/__files',{method:'POST',body:JSON.stringify(data)});
}
export async function fileHttp(env, request, stub) {
  try {
    const u=new URL(request.url),path=u.pathname,method=request.method;
    if(!env.ELF_ARTIFACTS) return json({ok:false,msg:'文件存储未配置'},503);
    if(path==='/api/elfremote/file-download' && method==='GET') {
      const id=u.searchParams.get('id'), result=await rpc(stub,{action:'authorize',id,device_id:u.searchParams.get('device_id'),task_id:u.searchParams.get('task_id'),token:(request.headers.get('Authorization')||'').replace(/^Bearer /,'')});
      if(!result.ok)return result;
      const {file:m}=await result.json();
      if(!u.searchParams.has('part')) return json({ok:true,file:m});
      const i=Number(u.searchParams.get('part')),part=m.parts[i];
      if(!Number.isInteger(i)||i<0||!part)return json({ok:false,msg:'分块不存在'},404);
      const range=request.headers.get('Range');let offset=0;
      if(range) {
        const match=/^bytes=(\d+)-$/.exec(range);offset=match?Number(match[1]):NaN;
        if(!Number.isSafeInteger(offset)||offset<0||offset>=part.bytes)return new Response(null,{status:416});
      }
      const object=await env.ELF_ARTIFACTS.get(chunkKey(m,i,part.sha256),offset?{range:{offset}}:undefined);
      if(!object)return json({ok:false,msg:'文件分块缺失'},404);
      return new Response(object.body,{status:range?206:200,headers:{'Content-Type':'application/octet-stream','Cache-Control':'no-store','Accept-Ranges':'bytes','Content-Length':String(part.bytes-offset),...(range?{'Content-Range':`bytes ${offset}-${part.bytes-1}/${part.bytes}`}:{})}});
    }
    if(path==='/api/elfremote/files' && method==='POST')return rpc(stub,{...await request.json(),action:'init'});
    const match=/^\/api\/elfremote\/files\/([a-f0-9]{32})(?:\/(complete|parts\/(\d+)))?$/.exec(path);
    if(!match)return json({ok:false,msg:'文件接口不存在'},404);
    const id=match[1];
    if(!match[2] && method==='GET')return rpc(stub,{action:'get',id});
    if(match[2]==='complete' && method==='POST')return rpc(stub,{...await request.json(),action:'complete',id});
    if(match[3]!==undefined && method==='PUT') {
      const found=await rpc(stub,{action:'get',id});if(!found.ok)return found;
      const {file:m}=await found.json(), index=Number(match[3]),sha=u.searchParams.get('sha256');
      const expected=Math.min(FILE_CHUNK,m.size-index*FILE_CHUNK);
      if(!Number.isInteger(index)||index<0||expected<=0||!validSha(sha))throw Error('分块参数无效');
      if(m.parts[index])return m.parts[index].sha256===sha?json({ok:true,file:m}):json({ok:false,msg:'文件内容已变化'},409);
      if(m.state!=='uploading')return json({ok:false,msg:'文件已封存'},409);
      if(Number(request.headers.get('Content-Length'))!==expected)throw Error('分块长度不匹配');
      // 每次最多8 MB，R2本身核对SHA-256；地址含哈希，迟到请求不能改写封存内容。
      await env.ELF_ARTIFACTS.put(chunkKey(m,index,sha),request.body,{sha256:sha});
      return rpc(stub,{action:'part',id,index,bytes:expected,sha256:sha});
    }
    return json({ok:false,msg:'方法不支持'},405);
  }catch(error){return json({ok:false,msg:error.message},400);}
}

export async function cleanupFiles(env,stub) {
  if(!env.ELF_ARTIFACTS||!stub)return;
  // 先删对象再删元数据，失败会在下一次定时任务继续，不留下失去索引的对象。
  // 通过R2前缀清理也包含上传完成回执丢失产生的分块。
  const response=await rpc(stub,{action:'cleanup'});if(!response.ok)return;
  for(const m of (await response.json()).removed) {
    try {
      let cursor;
      do {const listed=await env.ELF_ARTIFACTS.list({prefix:`device-files/${m.id}/`,cursor,limit:1000});
        if(listed.objects.length)await env.ELF_ARTIFACTS.delete(listed.objects.map(o=>o.key));
        cursor=listed.truncated?listed.cursor:undefined;
      }while(cursor);
      await rpc(stub,{action:'cleanup_done',id:m.id});
    }catch(error){throw error;}
  }
}
