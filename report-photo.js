import {authJson as json} from './admin-auth.js';
export const PHOTO_MAX=256*1024;
const TTL=7*86400000;
const valid=s=>typeof s==='string'&&/^[a-zA-Z0-9_-]{1,96}$/.test(s);
const hex=bytes=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
const sha=async bytes=>hex(await crypto.subtle.digest('SHA-256',bytes));
const key=(device,id)=>'report-photo/'+device+'/'+id;
const rpc=(stub,body)=>stub.fetch('https://elf-store/__photos',{method:'POST',body:JSON.stringify(body)});

export async function photoMetadata(storage,request,loadDevices,saveDevices,now=Date.now()){
  try{
    const p=await request.json();
    if(p.action==='expired'){
      const permits=await storage.list({prefix:'manual-photo-expiry/',end:'manual-photo-expiry/'+String(now).padStart(13,'0')+'~',limit:100});
      for(const [expiry,k] of permits){await storage.delete(k);await storage.delete(expiry);}
      const rows=await storage.list({prefix:'report-photo-expiry/',end:'report-photo-expiry/'+String(now).padStart(13,'0')+'~',limit:50});
      return json({ok:true,files:[...rows.values()]});
    }
    if(p.action==='list'){
      if(!valid(p.device_id)||(p.cursor&&!valid(p.cursor)))return json({ok:false,msg:'照片查询编号无效'},400);
      const prefix=key(p.device_id,'');
      const rows=await storage.list({prefix,...(p.cursor?{startAfter:prefix+p.cursor}:{}),limit:100});
      const photos=[...rows.values()].filter(photo=>photo.ready&&photo.expires_at>now)
        .map(({report_id,captured_at,expires_at})=>({report_id,captured_at,expires_at}));
      return json({ok:true,photos,next:rows.size===100?[...rows.keys()].at(-1).slice(prefix.length):null});
    }
    if(!valid(p.device_id)||!valid(p.report_id))return json({ok:false,msg:'照片关联编号无效'},400);
    const k=key(p.device_id,p.report_id),old=await storage.get(k);
    if(p.action==='get')return old?.ready&&old.expires_at>now?json({ok:true,photo:old}):json({ok:false,msg:'照片不可用'},404);
    if(p.action==='removed'){
      if(old&&old.expires_at<=now){
        await storage.delete(old.expiry_key);await storage.delete(k);await storage.delete('manual-photo/'+p.device_id+'/'+p.report_id);
        const devices=await loadDevices(),d=devices.find(d=>d.id===p.device_id);
        if(d?.report_photo?.report_id===p.report_id){delete d.report_photo;await saveDevices(devices);}
      }
      return json({ok:true});
    }
    const devices=await loadDevices(),device=devices.find(d=>d.id===p.device_id);
    if(!device||device.enabled===false||typeof p.token!=='string'||!p.token||device.token_sha256!==await sha(new TextEncoder().encode(p.token)))return json({ok:false,msg:'设备验证失败'},401);
    const index=await storage.get('history-id/'+encodeURIComponent(device.id)+'/'+p.report_id);
    const manual=await storage.get('manual-photo/'+device.id+'/'+p.report_id);
    const isManual=manual?.expires_at>now;
    const report=isManual?manual:index?await storage.get(index.key):null;
    if(!report||Date.parse(report.received_at)+86400000<now)return json({ok:false,msg:'文字报告尚未确认或已过期'},409);
    const critical=report.report_event?.type==='low_battery'&&report.report_event.level<2&&report.report_event.thresholds.includes(2);
    if(!isManual&&report.network!=='wifi'&&!critical)return json({ok:false,msg:'本次报告不包含拍照规则'},409);
    if(p.action==='reserve'){
      if(!Number.isInteger(p.bytes)||p.bytes<4||p.bytes>PHOTO_MAX||!/^[a-f0-9]{64}$/.test(p.sha256||'')
        ||!Number.isFinite(p.captured_at)||Math.abs(now-p.captured_at)>86400000)throw Error('照片信息无效');
      if(old)return old.sha256===p.sha256&&old.bytes===p.bytes?json({ok:true,photo:old}):json({ok:false,msg:'同次照片内容不一致'},409);
      const expires=now+TTL,expiry='report-photo-expiry/'+String(expires).padStart(13,'0')+'/'+device.id+'/'+p.report_id;
      const photo={device_id:device.id,report_id:p.report_id,bytes:p.bytes,sha256:p.sha256,captured_at:new Date(p.captured_at).toISOString(),
        report_received_at:report.received_at,expires_at:expires,expiry_key:expiry,ready:false,
        object_key:'report-photos/'+device.id+'/'+p.report_id+'/'+p.sha256+'.jpg',
        url:'/api/elfremote/report-photo?'+new URLSearchParams({device_id:device.id,report_id:p.report_id})};
      await storage.put(k,photo);await storage.put(expiry,photo);return json({ok:true,photo});
    }
    if(p.action==='commit'){
      if(!old||old.sha256!==p.sha256||old.expires_at<=now)return json({ok:false,msg:'照片接收记录不匹配'},409);
      old.ready=true;await storage.put(k,old);
      if(!device.report_photo||old.report_received_at>device.report_photo.report_received_at
        ||(old.report_received_at===device.report_photo.report_received_at&&old.report_id>device.report_photo.report_id)){
        device.report_photo={report_id:old.report_id,captured_at:old.captured_at,bytes:old.bytes,sha256:old.sha256,
          report_received_at:old.report_received_at,url:old.url};await saveDevices(devices);
      }
      return json({ok:true,sha256:old.sha256,bytes:old.bytes});
    }
    return json({ok:false,msg:'照片操作无效'},400);
  }catch(error){return json({ok:false,msg:error.message},400);}
}

export async function photoHttp(env,request,stub){
  try{
    if(!env.ELF_ARTIFACTS)return json({ok:false,msg:'照片存储未配置'},503);
    const u=new URL(request.url),p={device_id:u.searchParams.get('device_id'),report_id:u.searchParams.get('report_id')};
    if(request.method==='GET'){
      if(u.searchParams.get('list')==='1')return rpc(stub,{action:'list',device_id:p.device_id,cursor:u.searchParams.get('cursor')});
      const result=await rpc(stub,{...p,action:'get'});if(!result.ok)return result;
      const {photo}=await result.json(),object=await env.ELF_ARTIFACTS.get(photo.object_key);
      return object?new Response(object.body,{headers:{'Content-Type':'image/jpeg','Cache-Control':'private, max-age=3600','X-Content-Type-Options':'nosniff'}}):json({ok:false,msg:'照片文件缺失'},404);
    }
    if(request.method!=='POST')return json({ok:false},405);
    const length=Number(request.headers.get('Content-Length'));
    if(!Number.isInteger(length)||length<4||length>PHOTO_MAX)return json({ok:false,msg:'照片大小无效'},413);
    // 有界读取，不能依赖声明长度来接受无限正文。
    const reader=request.body?.getReader();if(!reader)return json({ok:false},400);
    let bytes=0;const parts=[];
    try{for(;;){const {value,done}=await reader.read();if(done)break;bytes+=value.length;if(bytes>length)throw Error('照片超过声明大小');parts.push(value);}}
    finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    if(bytes!==length)throw Error('照片长度不匹配');
    const data=new Uint8Array(bytes);let offset=0;for(const part of parts){data.set(part,offset);offset+=part.length;}
    if(data[0]!==255||data[1]!==216||data.at(-2)!==255||data.at(-1)!==217)throw Error('照片格式无效');
    const digest=await sha(data),token=(request.headers.get('Authorization')||'').replace(/^Bearer /,'');
    const reserved=await rpc(stub,{...p,action:'reserve',token,bytes,sha256:digest,captured_at:Number(u.searchParams.get('captured_at'))});if(!reserved.ok)return reserved;
    const {photo}=await reserved.json();
    if(!photo.ready)try{await env.ELF_ARTIFACTS.put(photo.object_key,data,{sha256:digest,httpMetadata:{contentType:'image/jpeg'}});}
    catch{return json({ok:false,msg:'照片存储暂不可用'},503);}
    return rpc(stub,{...p,action:'commit',token,sha256:digest});
  }catch(error){return json({ok:false,msg:error.message},400);}
}

export async function cleanupPhotos(env,stub){
  if(!env.ELF_ARTIFACTS||!stub)return;
  const result=await rpc(stub,{action:'expired'});if(!result.ok)return;
  for(const photo of (await result.json()).files){
    try {
      await env.ELF_ARTIFACTS.delete(photo.object_key);
      const removed=await rpc(stub,{action:'removed',device_id:photo.device_id,report_id:photo.report_id});
      if(!removed.ok)throw Error('metadata');
    } catch { console.error('photo_cleanup_pending'); }
  }
}
