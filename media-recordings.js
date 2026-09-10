import {authJson as json} from './admin-auth.js';
const TTL=7*86400000,MAX_PART=8*1024*1024,MAX_TOTAL=512*1024*1024;
const valid=s=>typeof s==='string'&&/^[a-zA-Z0-9_-]{1,96}$/.test(s);
const rpc=(stub,p)=>stub.fetch('https://store/__media_records',{method:'POST',body:JSON.stringify(p)});
const recordKey=(d,id)=>'media-record/'+d+'/'+id;
export async function recordingMetadata(storage,request,loadDevices,now=Date.now()){
  try{
    const p=await request.json();
    if(p.action==='expired')return json({ok:true,records:[...(await storage.list({prefix:'media-expiry/',end:'media-expiry/'+String(now).padStart(13,'0')+'~',limit:25})).values()]});
    if(!valid(p.device_id))throw Error('设备编号无效');
    if(p.action==='list'){
      const rows=await storage.list({prefix:recordKey(p.device_id,''),limit:1000});
      return json({ok:true,records:[...rows.values()].filter(r=>r.ready&&r.expires_at>now).map(({id,type,mime,captured_at,duration_ms,bytes,complete})=>({id,type,mime,captured_at,duration_ms,bytes,complete})).sort((a,b)=>b.captured_at-a.captured_at)});
    }
    if(!valid(p.id))throw Error('录制编号无效');const k=recordKey(p.device_id,p.id),old=await storage.get(k);
    if(p.action==='create'){
      if(!(await loadDevices()).some(d=>d.id===p.device_id&&d.enabled!==false))throw Error('设备不可用');
      if(old)return json({ok:true,record:old});
      if(!['audio','video'].includes(p.type)||!['audio/webm;codecs=opus','video/webm;codecs=vp8,opus','video/webm;codecs=vp9,opus','video/mp4'].includes(p.mime))throw Error('录制格式不支持');
      const expiry='media-expiry/'+String(now+TTL).padStart(13,'0')+'/'+p.device_id+'/'+p.id;
      const record={id:p.id,device_id:p.device_id,type:p.type,mime:p.mime,captured_at:now,expires_at:now+TTL,expiry_key:expiry,parts:[],bytes:0,ready:false,duration_ms:0,complete:false};
      await storage.put(k,record);await storage.put(expiry,{device_id:p.device_id,id:p.id});return json({ok:true,record});
    }
    if(p.action==='removed'){if(old&&old.expires_at<=now){await storage.delete(old.expiry_key);await storage.delete(k);}return json({ok:true});}
    if(!old||old.expires_at<=now&&p.action!=='cleanup')return json({ok:false,msg:'录制记录已过期或不存在'},404);
    if(p.action==='get'||p.action==='cleanup')return json({ok:true,record:old});
    if(p.action==='part'){
      if(!Number.isInteger(p.index)||p.index<0||p.index>=720||!Number.isInteger(p.bytes)||p.bytes<=0||p.bytes>MAX_PART||!/^[a-f0-9]{64}$/.test(p.sha256||''))throw Error('录制分段无效');
      const previous=old.parts[p.index];
      if(previous)return previous.bytes===p.bytes&&previous.sha256===p.sha256?json({ok:true,part:previous}):json({ok:false,msg:'录制分段不一致'},409);
      if(old.complete||p.index!==old.parts.length||old.bytes+p.bytes>MAX_TOTAL)throw Error('录制分段顺序或大小无效');
      const part={index:p.index,bytes:p.bytes,sha256:p.sha256,key:'media-recordings/'+p.device_id+'/'+p.id+'/'+p.index+'/'+p.sha256};
      old.parts.push(part);old.bytes+=p.bytes;old.ready=true;
      old.duration_ms=Math.max(old.duration_ms,Math.min(1800000,Math.max(0,Number(p.duration_ms)||0)));
      await storage.put(k,old);return json({ok:true,part});
    }
    if(p.action==='finish'){
      if(p.parts!==old.parts.length||!old.parts.length)throw Error('录制分段尚未全部保存');
      old.complete=true;old.duration_ms=Math.min(1800000,Math.max(old.duration_ms,Number(p.duration_ms)||0));await storage.put(k,old);return json({ok:true,record:old});
    }
    throw Error('录制操作无效');
  }catch(e){return json({ok:false,msg:e.message},400);}
}
export async function recordingHttp(env,request,stub){
  try{
    if(!env.ELF_ARTIFACTS)return json({ok:false,msg:'媒体存储未配置'},503);
    const u=new URL(request.url),p={device_id:u.searchParams.get('device_id'),id:u.searchParams.get('id')};
    if(request.method==='POST'){
      const body=await request.text();if(body.length>4096)throw Error('录制请求过大');const data=JSON.parse(body);
      return rpc(stub,{...data,...p,action:u.searchParams.get('action')});
    }
    if(request.method==='PUT'){
      const index=Number(u.searchParams.get('index'));if(!Number.isInteger(index)||index<0||index>=720)throw Error('分段编号无效');
      const current=await rpc(stub,{...p,action:'get'});if(!current.ok)return current;const {record}=await current.json();
      if(record.complete||index>record.parts.length)throw Error('录制已结束或分段乱序');
      const reader=request.body?.getReader();if(!reader)throw Error('分段为空');const chunks=[];let n=0;
      try{for(;;){const r=await reader.read();if(r.done)break;n+=r.value.length;if(n>MAX_PART)throw Error('录制分段过大');chunks.push(r.value);}}finally{await reader.cancel().catch(()=>{});}
      const bytes=new Uint8Array(n);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
      const previous=record.parts[index];if(previous&&(previous.sha256!==hash||previous.bytes!==n))return json({ok:false,msg:'录制分段不一致'},409);
      if(record.bytes+(previous?0:n)>MAX_TOTAL)throw Error('录制已达大小上限');
      // 同一序号内容相同才可重试；对象写完后才登记可见分段。
      const key='media-recordings/'+p.device_id+'/'+p.id+'/'+index+'/'+hash;
      if(!previous)await env.ELF_ARTIFACTS.put(key,bytes,{sha256:hash,httpMetadata:{contentType:record.mime}});
      return rpc(stub,{...p,action:'part',index,bytes:n,sha256:hash,duration_ms:Number(u.searchParams.get('duration_ms'))});
    }
    if(request.method!=='GET')return json({ok:false},405);
    if(u.searchParams.get('list')==='1')return rpc(stub,{action:'list',device_id:p.device_id});
    const result=await rpc(stub,{...p,action:'get'});if(!result.ok)return result;const {record}=await result.json();if(!record.ready)return json({ok:false,msg:'录制尚无数据'},404);
    let start=0,end=record.bytes-1;const range=request.headers.get('Range');
    if(range){const m=/^bytes=(\d*)-(\d*)$/.exec(range);if(!m||!m[1]&&!m[2])return new Response(null,{status:416});if(m[1]){start=Number(m[1]);if(m[2])end=Math.min(end,Number(m[2]));}else start=Math.max(0,record.bytes-Number(m[2]));if(start>end||start>=record.bytes)return new Response(null,{status:416,headers:{'Content-Range':'bytes */'+record.bytes}});}
    let offset=0;const parts=[];for(const part of record.parts){const from=Math.max(start,offset),to=Math.min(end,offset+part.bytes-1);if(from<=to)parts.push({...part,offset:from-offset,length:to-from+1});offset+=part.bytes;}
    let reader=null,index=0;
    const stream=new ReadableStream({async pull(controller){try{for(;;){if(!reader){if(index>=parts.length){controller.close();return;}const part=parts[index++];const object=await env.ELF_ARTIFACTS.get(part.key,{range:{offset:part.offset,length:part.length}});if(!object)throw Error('录制分段缺失');reader=object.body.getReader();}const r=await reader.read();if(r.done){reader.releaseLock();reader=null;continue;}controller.enqueue(r.value);return;}}catch(e){controller.error(e);}},async cancel(){await reader?.cancel();}});
    return new Response(stream,{status:range?206:200,headers:{'Content-Type':record.mime,'Content-Length':String(end-start+1),'Accept-Ranges':'bytes','Cache-Control':'private, no-store',...(range?{'Content-Range':`bytes ${start}-${end}/${record.bytes}`}:{})}});
  }catch(e){return json({ok:false,msg:e.message},400);}
}
export async function cleanupRecordings(env,stub){
  if(!env.ELF_ARTIFACTS||!stub)return;const result=await rpc(stub,{action:'expired'});if(!result.ok)return;
  for(const row of (await result.json()).records)try{
    const response=await rpc(stub,{...row,action:'cleanup'});if(!response.ok)continue;const {record}=await response.json();
    // 连同对象已写入但元数据提交失败的最后一段一起清理。
    let cursor;do{const page=await env.ELF_ARTIFACTS.list({prefix:'media-recordings/'+row.device_id+'/'+row.id+'/',cursor});if(page.objects.length)await env.ELF_ARTIFACTS.delete(page.objects.map(o=>o.key));cursor=page.truncated?page.cursor:undefined;}while(cursor);
    const removed=await rpc(stub,{...row,action:'removed'});if(!removed.ok)throw Error('metadata');
  }catch{console.error('media_cleanup_pending');}
}
