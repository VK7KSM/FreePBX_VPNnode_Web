// WebSocket仅承载控制和协商；音视频经Cloudflare Realtime传输。
import {MEDIA_MODES,mediaAllowed} from './media-capabilities.js';
export {MEDIA_MODES};
export function mediaDirections(mode,role){
  return {audio:role==='browser'?['ptt','call'].includes(mode):['call','microphone','video'].includes(mode),video:role==='device'&&mode==='video'};
}
export class MediaRelay {
  constructor(env,{now=Date.now,schedule=(fn,ms)=>setTimeout(fn,ms),cancel=id=>clearTimeout(id),fetcher=(url,init)=>fetch(url,init)}={}){
    this.env=env;this.now=now;this.schedule=schedule;this.cancel=cancel;this.fetcher=fetcher;this.sessions=new Map();
  }
  create(device,mode,camera='front'){
    if(!mediaAllowed(device,mode))throw Error('设备尚不支持此通信操作');
    if(!MEDIA_MODES.includes(mode)||!['front','back'].includes(camera))throw Error('通信操作无效');
    if(!['photo','alarm'].includes(mode)&&!this.env.ELF_REALTIME)throw Error('实时服务未配置');
    if([...this.sessions.values()].some(s=>s.deviceId===device.id))throw Error('请先结束该设备当前通信');
    if(this.sessions.size>=16)throw Error('当前通信过多');
    const id=crypto.randomUUID(),token=crypto.randomUUID()+crypto.randomUUID(),created=this.now();
    const s={id,token,deviceId:device.id,mode,camera,created,started:0,lastBrowser:created,roles:{},published:{},rtc:{},chains:{},closed:false};
    this.sessions.set(id,s);try{this.arm(s);}catch(error){this.sessions.delete(id);throw error;}
    return {ok:true,session_id:id,mode};
  }
  arm(s){s.timer=this.schedule(()=>{
    if(s.closed)return;
    const at=this.now();
    if(!s.started&&at-s.created>=45000)this.close(s,'设备连接超时');
    else if(s.started&&at-s.lastBrowser>=90000)this.close(s,'网页连接已中断');
    else if(s.mode!=='alarm'&&s.started&&at-s.started>=(s.mode==='ptt'?60000:s.mode==='photo'?60000:1800000))this.close(s,'本次通信已结束');
    else this.arm(s);
  },1000);}
  offer(deviceId,origin){
    const s=[...this.sessions.values()].find(s=>s.deviceId===deviceId&&!s.roles.device);
    return s?{session_id:s.id,token:s.token,mode:s.mode,camera:s.camera,expires_at:s.created+45000,url:origin.replace(/^https:/,'wss:')+'/api/elfremote/media/device?session_id='+s.id}:null;
  }
  updateCapabilities(device){
    for(const s of this.sessions.values())if(s.deviceId===device.id&&!mediaAllowed(device,s.mode))this.close(s,'设备已不再支持本次通信');
  }
  get(id,role,token){
    const s=this.sessions.get(id);if(!s||s.closed)throw Error('通信已结束');
    if(role==='device'&&(!token||token!==s.token))throw Error('设备连接验证失败');
    if(s.roles[role])throw Error('此通信已连接');return s;
  }
  attach(s,role,ws){
    ws.accept();s.roles[role]=ws;s.chains[role]=Promise.resolve();
    ws.addEventListener('message',e=>{s.chains[role]=s.chains[role].then(()=>this.message(s,role,e.data)).catch(()=>this.close(s,'通信处理失败'));});
    ws.addEventListener('close',()=>this.close(s,'通信已结束'));
    ws.addEventListener('error',()=>this.close(s,'通信连接中断'));
    this.send(s,role,{type:'waiting'});
    const other=role==='browser'?'device':'browser';
    if(s.published[other])this.send(s,role,{type:'tracks',...s.published[other]});
    if(s.roles.browser&&s.roles.device){this.send(s,'browser',{type:'hello',mode:s.mode,camera:s.camera});this.send(s,'device',{type:'hello',mode:s.mode,camera:s.camera});}
  }
  send(s,role,message){try{s.roles[role]?.send(JSON.stringify(message));}catch{this.close(s,'通信连接中断');}}
  async sfu(path,body,method='POST'){
    const config=JSON.parse(this.env.ELF_REALTIME);
    const r=await this.fetcher('https://rtc.live.cloudflare.com/v1/apps/'+encodeURIComponent(config.appId)+path,{method,headers:{Authorization:'Bearer '+config.secret,...(body===undefined?{}:{'Content-Type':'application/json'})},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
    const x=await r.json();if(!r.ok||x.errorCode||x.tracks?.some(t=>t.errorCode))throw Error('实时媒体协商失败');return x;
  }
  async message(s,role,raw){
    if(s.closed)return;
    try{
      if(typeof raw!=='string'||raw.length>96000)throw Error('通信消息过大');
      const p=JSON.parse(raw),other=role==='browser'?'device':'browser';
      if(role==='browser')s.lastBrowser=this.now();
      if(p.type==='stop'){this.close(s,'通信已结束');return;}
      if(p.type==='ping'){this.send(s,role,{type:'pong'});return;}
      if(p.type==='ready'){
        if(role==='device'&&!s.started)s.started=this.now();
        this.send(s,other,{type:'ready',started_at:s.started});return;
      }
      if(p.type==='switch'&&role==='browser'&&['photo','video'].includes(s.mode)){
        s.camera=s.camera==='front'?'back':'front';this.send(s,'device',{type:'switch',camera:s.camera});return;
      }
      if(['result','status'].includes(p.type)&&role==='device'){
        const message={type:p.type,message:String(p.message||'').slice(0,140),camera:p.camera,cameras:Number(p.cameras)||1,report_id:p.report_id,captured_at:p.captured_at};
        this.send(s,'browser',message);return;
      }
      if(p.type!=='rpc'||!Number.isInteger(p.id))throw Error('通信消息无效');
      if(['photo','alarm'].includes(s.mode))throw Error('该操作不使用实时流');
      let result;
      try{
        if(p.action==='new'){
          if(s.rtc[role])throw Error('实时连接已创建');
          result=await this.sfu('/sessions/new');s.rtc[role]=result.sessionId;
        }else{
          const id=s.rtc[role];if(!id)throw Error('实时连接未创建');
          const prefix='/sessions/'+encodeURIComponent(id);
          if(p.action==='publish'){
            const directions=mediaDirections(s.mode,role),tracks=p.body?.tracks;
            if(!Array.isArray(tracks)||!tracks.length||tracks.length>2||tracks.some(t=>!['audio','video'].includes(t.trackName)||!directions[t.trackName]||typeof t.mid!=='string')||new Set(tracks.map(t=>t.trackName)).size!==tracks.length)throw Error('媒体方向不匹配');
            result=await this.sfu(prefix+'/tracks/new',{sessionDescription:p.body.sessionDescription,tracks:tracks.map(t=>({location:'local',mid:t.mid,trackName:t.trackName}))});
            s.published[role]={sessionId:id,tracks:tracks.map(t=>({location:'remote',sessionId:id,trackName:t.trackName}))};
          }else if(p.action==='published'){
            if(!s.published[role])throw Error('媒体尚未发布');
            this.send(s,other,{type:'tracks',...s.published[role]});result={ok:true};
          }else if(p.action==='subscribe'){
            if(!s.published[other])throw Error('对端媒体尚未就绪');
            result=await this.sfu(prefix+'/tracks/new',{tracks:s.published[other].tracks});
          }else if(p.action==='answer')result=await this.sfu(prefix+'/renegotiate',{sessionDescription:p.body.sessionDescription},'PUT');
          else throw Error('媒体协商操作无效');
        }
        if(!s.closed)this.send(s,role,{type:'rpc',id:p.id,result});
      }catch(error){this.send(s,role,{type:'rpc',id:p.id,error:error.message});}
    }catch(error){this.close(s,error.message);}
  }
  close(s,message){
    if(s.closed)return;s.closed=true;this.sessions.delete(s.id);this.cancel(s.timer);
    for(const role of ['browser','device'])if(s.roles[role]){
      try{s.roles[role].send(JSON.stringify({type:'closed',message}));s.roles[role].close(1000,'media ended');}catch{}
    }
    // 客户端释放PeerConnection使SFU回收会话，不再保留采集或播放。
    s.token='';
  }
}
