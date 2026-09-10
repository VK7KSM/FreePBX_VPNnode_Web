import {authJson as json} from './admin-auth.js';
import {FILE_CHUNK,FILE_MAX} from './file-transfer.js';
const id=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,96}$/.test(v),sha=v=>/^[a-f0-9]{64}$/.test(v||'');
const key=p=>'file-return/'+p.device_id+'/'+p.task_id;
const objectKey=(p,index,hash)=>'device-files/return/'+p.device_id+'/'+p.task_id+'/'+index+'-'+hash;
const rpc=(stub,p)=>stub.fetch('https://elf-store/__returns',{method:'POST',body:JSON.stringify(p)});
const digest=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),b=>b.toString(16).padStart(2,'0')).join('');
export function returnParams(p={}){
  if(typeof p.path!=='string'||!p.path.startsWith('/')||p.path.endsWith('/')||p.path.length>512||/[\x00-\x1f\x7f]/.test(p.path)||p.path.split('/').some(s=>s==='.'||s==='..'))throw Error('请填写设备上的完整文件路径');
  return {path:p.path,allow_cellular:p.allow_cellular===true};
}
export async function returnMetadata(storage,request,loadDevices,now=Date.now()){
  try{
    const p=await request.json();
    if(p.action==='expired')return json({ok:true,files:[...(await storage.list({prefix:'file-return/'})).values()].filter(m=>m.expires_at<=now).slice(0,4)});
    if(!id(p.device_id)||!id(p.task_id))throw Error('文件任务编号无效');
    let m=await storage.get(key(p));
    if(p.action==='removed'){if(m?.expires_at<=now)await storage.delete(key(p));return json({ok:true});}
    if(p.action==='admin')return m?.state==='ready'&&m.expires_at>now?json({ok:true,file:m}):json({ok:false,msg:'文件尚未取回或已过期'},404);
    const d=(await loadDevices()).find(d=>d.id===p.device_id);
    if(!d||!p.token||d.token_sha256!==await digest(p.token))return json({ok:false,msg:'设备验证失败'},401);
    if(d.enabled===false||d.task?.id!==p.task_id||d.task.type!=='get_file'||d.task.cancel_requested||!['pending','claimed','running'].includes(d.task.state)||d.task.expires_at<=now)return json({ok:false,msg:'文件取回任务已停止'},409);
    if(p.action==='init'){
      if(!Number.isSafeInteger(p.size)||p.size<0||p.size>FILE_MAX||!sha(p.sha256))throw Error('文件信息无效');
      if(m){if(m.size!==p.size||m.sha256!==p.sha256)return json({ok:false,msg:'本次文件快照不一致'},409);}
      else{m={device_id:p.device_id,task_id:p.task_id,name:d.task.params.path.split('/').at(-1),size:p.size,sha256:p.sha256,chunk_size:FILE_CHUNK,parts:{},state:'uploading',expires_at:now+7*86400000};await storage.put(key(p),m);}
    }
    if(!m||m.expires_at<=now)return json({ok:false,msg:'文件尚未准备或已过期'},404);
    if(p.action==='part'){
      const expected=Math.min(FILE_CHUNK,m.size-p.index*FILE_CHUNK);
      if(!Number.isInteger(p.index)||p.index<0||expected<=0||p.bytes!==expected||!sha(p.sha256))throw Error('文件分块无效');
      if(m.parts[p.index]&&m.parts[p.index].sha256!==p.sha256)return json({ok:false,msg:'文件分块内容不一致'},409);
      if(m.state!=='uploading'&&!m.parts[p.index])throw Error('文件已封存');
      m.parts[p.index]={sha256:p.sha256,bytes:p.bytes};await storage.put(key(p),m);
    }else if(p.action==='complete'){
      for(let i=0;i<Math.ceil(m.size/FILE_CHUNK);i++)if(!m.parts[i])throw Error('文件尚未传完');
      m.state='ready';await storage.put(key(p),m);
    }else if(!['init','get'].includes(p.action))throw Error('文件操作无效');
    return json({ok:true,file:m});
  }catch(e){return json({ok:false,msg:e.message},400);}
}
export async function returnHttp(env,request,stub){
  try{
    if(!env.ELF_ARTIFACTS)return json({ok:false,msg:'文件存储未配置'},503);
    const u=new URL(request.url),p={device_id:u.searchParams.get('device_id'),task_id:u.searchParams.get('task_id')};
    if(request.method==='POST'){const body=await request.json();if(!['init','get','complete'].includes(body.action))throw Error('文件操作无效');return rpc(stub,{...body,...p,token:(request.headers.get('Authorization')||'').replace(/^Bearer /,'')});}
    if(request.method==='PUT'){
      const auth={...p,token:(request.headers.get('Authorization')||'').replace(/^Bearer /,'')};
      const r=await rpc(stub,{...auth,action:'get'});if(!r.ok)return r;
      const {file:m}=await r.json(),index=Number(u.searchParams.get('part')),hash=u.searchParams.get('sha256'),bytes=Math.min(FILE_CHUNK,m.size-index*FILE_CHUNK);
      if(!Number.isInteger(index)||index<0||bytes<=0||!sha(hash)||Number(request.headers.get('Content-Length'))!==bytes)throw Error('分块信息无效');
      if(m.parts[index])return m.parts[index].sha256===hash?json({ok:true,file:m}):json({ok:false,msg:'分块不一致'},409);
      if(m.state!=='uploading')return json({ok:false,msg:'文件已封存'},409);
      try{await env.ELF_ARTIFACTS.put(objectKey(p,index,hash),request.body,{sha256:hash});}catch{return json({ok:false,msg:'文件存储暂不可用'},503);}
      return rpc(stub,{...auth,action:'part',index,bytes,sha256:hash});
    }
    if(request.method!=='GET')return json({ok:false},405);
    const r=await rpc(stub,{...p,action:'admin'});if(!r.ok)return r;const {file:m}=await r.json();
    if(!u.searchParams.has('download'))return json({ok:true,file:m});
    let start=0,end=m.size-1;const range=request.headers.get('Range');
    if(range){const match=/^bytes=(\d+)-(\d*)$/.exec(range);if(!match)return new Response(null,{status:416});start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),end):end;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start<0)return new Response(null,{status:416});}
    let index=Math.floor(start/FILE_CHUNK),reader,position=start;
    const body=new ReadableStream({async pull(controller){try{for(;;){
      if(position>end){if(reader){await reader.cancel();reader=null;}controller.close();return;}
      if(!reader){const part=m.parts[index],offset=position-index*FILE_CHUNK,length=Math.min(part.bytes-offset,end-position+1);const object=await env.ELF_ARTIFACTS.get(objectKey(p,index,part.sha256),{range:{offset,length}});if(!object)throw Error('文件分块缺失');reader=object.body.getReader();}
      const {done,value}=await reader.read();if(done){reader.releaseLock();reader=null;index++;continue;}
      position+=value.length;controller.enqueue(value);return;
    }}catch(e){controller.error(e);}},async cancel(){if(reader)await reader.cancel();}});
    return new Response(body,{status:range?206:200,headers:{'Content-Type':'application/octet-stream','Cache-Control':'no-store','Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(m.name),'Content-Length':String(Math.max(0,end-start+1)),'Accept-Ranges':'bytes',...(range?{'Content-Range':`bytes ${start}-${end}/${m.size}`}:{})}});
  }catch(e){return json({ok:false,msg:e.message},400);}
}
export async function cleanupReturns(env,stub){
  if(!env.ELF_ARTIFACTS||!stub)return;const r=await rpc(stub,{action:'expired'});if(!r.ok)return;
  for(const m of (await r.json()).files){try{let cursor;do{const list=await env.ELF_ARTIFACTS.list({prefix:'device-files/return/'+m.device_id+'/'+m.task_id+'/',cursor});if(list.objects.length)await env.ELF_ARTIFACTS.delete(list.objects.map(o=>o.key));cursor=list.truncated?list.cursor:undefined;}while(cursor);const removed=await rpc(stub,{...m,action:'removed'});if(!removed.ok)throw Error('metadata');}catch{console.error('return_cleanup_pending');}}
}
