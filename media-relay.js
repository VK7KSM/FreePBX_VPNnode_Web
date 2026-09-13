// WebSocket仅承载控制和协商；音视频经Cloudflare Realtime传输。
import {MEDIA_MODES,mediaAllowed} from './media-capabilities.js';
export {MEDIA_MODES};
export function mediaDirections(mode,role){
  if(mode==='prepare')return {audio:true,video:role==='device'};
  return {audio:role==='browser'?['ptt','call'].includes(mode):['call','microphone','video'].includes(mode),video:role==='device'&&mode==='video'};
}
export class MediaRelay {
  constructor(env,{now=Date.now,schedule=(fn,ms)=>setTimeout(fn,ms),cancel=id=>clearTimeout(id),fetcher=(url,init)=>fetch(url,init),authorizePhoto}={}){
    this.env=env;this.now=now;this.schedule=schedule;this.cancel=cancel;this.fetcher=fetcher;this.authorizePhoto=authorizePhoto;this.sessions=new Map();
  }
  create(device,mode,camera='front'){
    if(!mediaAllowed(device,mode))throw Error('设备尚不支持此通信操作');
    if(!(MEDIA_MODES.includes(mode)||mode==='prepare')||!['front','back'].includes(camera))throw Error('通信操作无效');
    if(!['photo','alarm'].includes(mode)&&!this.env.ELF_REALTIME)throw Error('实时服务未配置');
    if([...this.sessions.values()].some(s=>s.deviceId===device.id))throw Error('请先结束该设备当前通信');
    if(this.sessions.size>=16)throw Error('当前通信过多');
    const id=crypto.randomUUID(),token=crypto.randomUUID()+crypto.randomUUID(),created=this.now();
    const s={id,token,deviceId:device.id,mode,camera,created,started:0,lastBrowser:created,roles:{},published:{},rtc:{},chains:{},closed:false,prepared:mode==='prepare',modes:MEDIA_MODES.filter(m=>mediaAllowed(device,m)),operation:0,phase:'preparing'};
    this.sessions.set(id,s);try{this.arm(s);}catch(error){this.sessions.delete(id);throw error;}
    return {ok:true,session_id:id,mode};
  }
  arm(s){
    if(s.timer!==undefined)this.cancel(s.timer);
    const deadlines=[s.lastBrowser+90000];
    if((s.prepared&&s.phase==='preparing')||(!s.prepared&&!s.started))deadlines.push(s.created+45000);
    if(s.prepared&&s.phase==='activating')deadlines.push(s.operationCreated+15000);
    if(s.prepared&&s.phase==='stopping')deadlines.push(s.stopCreated+10000);
    if(s.started&&s.mode!=='alarm')deadlines.push(s.started+(s.mode==='ptt'||s.mode==='photo'?60000:1800000));
    s.timer=this.schedule(()=>{
    if(s.closed)return;
    const at=this.now();
    if(s.prepared&&s.phase==='preparing'&&at-s.created>=45000)this.close(s,'设备连接超时');
    else if(s.prepared&&s.phase==='activating'&&at-s.operationCreated>=15000)this.close(s,'设备启动超时');
    else if(s.prepared&&s.phase==='stopping'&&at-s.stopCreated>=10000)this.close(s,'设备停止未确认');
    else if(!s.prepared&&!s.started&&at-s.created>=45000)this.close(s,'设备连接超时');
    else if(at-s.lastBrowser>=90000)this.close(s,'网页连接已中断');
    else if(s.mode!=='alarm'&&s.started&&at-s.started>=(s.mode==='ptt'?60000:s.mode==='photo'?60000:1800000)){
      if(s.prepared)this.deactivate(s,'本次操作已到时');else this.close(s,'本次通信已结束');
    }
    else this.arm(s);
  },Math.max(1,Math.min(...deadlines)-this.now()));}
  deactivate(s,message=''){
    if(!['activating','active'].includes(s.phase))return;
    s.phase='stopping';s.started=0;s.stopCreated=this.now();
    this.send(s,'device',{type:'deactivate',operation:s.operation});
    this.send(s,'browser',{type:'stopping',operation:s.operation,message});
    this.arm(s);
  }
  offer(deviceId,origin){
    const s=[...this.sessions.values()].find(s=>s.deviceId===deviceId&&!s.roles.device);
    return s?{session_id:s.id,token:s.token,mode:s.mode,camera:s.camera,expires_at:s.created+45000,url:origin.replace(/^https:/,'wss:')+'/api/elfremote/media/device?session_id='+s.id}:null;
  }
  updateCapabilities(device){
    for(const s of this.sessions.values())if(s.deviceId===device.id){if(!mediaAllowed(device,s.prepared?'prepare':s.mode)||s.mode!=='prepare'&&!mediaAllowed(device,s.mode))this.close(s,'设备已不再支持本次通信');else s.modes=MEDIA_MODES.filter(m=>mediaAllowed(device,m));}
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
    const x=await r.json();if(!r.ok||x.errorCode||x.tracks?.some(t=>t.errorCode)){
      const code=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,96}$/.test(value)?value:'unknown';
      const error=Error('实时媒体协商失败');
      // 仅返回有限诊断码，不透出服务端原文、会话身份、SDP或凭据。
      error.diagnostic={status:r.status,code:x.errorCode?code(x.errorCode):null,tracks:(Array.isArray(x.tracks)?x.tracks:[]).filter(t=>t.errorCode).slice(0,2).map(t=>code(t.errorCode))};
      throw error;
    }return x;
  }
  async message(s,role,raw){
    if(s.closed)return;
    try{
      if(typeof raw!=='string'||raw.length>96000)throw Error('通信消息过大');
      const p=JSON.parse(raw),other=role==='browser'?'device':'browser';
      if(role==='browser')s.lastBrowser=this.now();
      if(p.type==='stop'){this.close(s,'通信已结束');return;}
      if(p.type==='ping'){this.send(s,role,{type:'pong'});return;}
      if(s.prepared&&p.type==='activate'&&role==='browser'){
        if(s.phase!=='idle'||!Number.isSafeInteger(p.operation)||p.operation!==s.operation+1||!s.modes.includes(p.mode)||!['front','back'].includes(p.camera))throw Error('预备通信激活状态无效');
        s.phase='activating';s.mode=p.mode;s.operation=p.operation;s.camera=p.camera;s.operationCreated=this.now();s.started=0;
        const reportId=s.id+'-'+s.operation;
        if(p.mode==='photo'){if(!this.authorizePhoto)throw Error('拍照授权未接通');await this.authorizePhoto(s.deviceId,reportId);if(s.closed)return;}
        this.send(s,'device',{type:'activate',operation:s.operation,mode:s.mode,camera:s.camera,report_id:reportId});return;
      }
      if(s.prepared&&p.type==='deactivate'&&role==='browser'){
        if(p.operation!==s.operation||!['activating','active','stopping'].includes(s.phase))return;
        this.deactivate(s);return;
      }
      if(s.prepared&&p.type==='transport_ready'&&role==='device'){
        if(s.phase==='preparing'){
          if(!s.published.browser||!s.published.device)throw Error('预备媒体尚未发布');
          s.phase='idle';this.send(s,'browser',{type:'transport_ready'});
        }return;
      }
      if(s.prepared&&p.type==='idle'&&role==='device'){
        if(p.operation!==s.operation||s.phase!=='stopping')return;
        s.phase='idle';s.mode='prepare';s.started=0;this.send(s,'browser',{type:'idle',operation:s.operation});return;
      }
      if(s.prepared&&['ready','status','result','photo_preview'].includes(p.type)&&role==='device'){
        if(p.operation!==s.operation||!['activating','active'].includes(s.phase))return;
        if(p.type==='photo_preview'){
          if(s.mode!=='photo'||typeof p.jpeg!=='string'||p.jpeg.length>88000||!/^[A-Za-z0-9+/]+={0,2}$/.test(p.jpeg)||!Number.isSafeInteger(p.captured_at))throw Error('照片预览无效');
          this.send(s,'browser',{type:'photo_preview',operation:s.operation,jpeg:p.jpeg,captured_at:p.captured_at});return;
        }
      }
      if(p.type==='ready'){
        if(s.prepared&&role!=='device')return;
        if(s.prepared)s.phase='active';
        if(role==='device'&&!s.started)s.started=this.now();
        this.send(s,other,{type:'ready',started_at:s.started,...(s.prepared?{operation:s.operation}:{})});return;
      }
      if(p.type==='switch'&&role==='browser'&&['photo','video'].includes(s.mode)){
        if(s.prepared&&(s.phase!=='active'||p.operation!==s.operation))return;
        s.camera=s.camera==='front'?'back':'front';this.send(s,'device',{type:'switch',camera:s.camera,...(s.prepared?{operation:s.operation}:{})});return;
      }
      if(['result','status'].includes(p.type)&&role==='device'){
        const message={type:p.type,message:String(p.message||'').slice(0,140),camera:p.camera,cameras:Number(p.cameras)||1,report_id:p.report_id,captured_at:p.captured_at,...(s.prepared?{operation:s.operation}:{})};
        this.send(s,'browser',message);return;
      }
      if(p.type!=='rpc'||!Number.isInteger(p.id))throw Error('通信消息无效');
      if(!s.prepared&&['photo','alarm'].includes(s.mode))throw Error('该操作不使用实时流');
      let result;
      try{
        if(p.action==='new'){
          if(s.rtc[role])throw Error('实时连接已创建');
          result=await this.sfu('/sessions/new');s.rtc[role]=result.sessionId;
        }else{
          const id=s.rtc[role];if(!id)throw Error('实时连接未创建');
          const prefix='/sessions/'+encodeURIComponent(id);
          if(p.action==='publish'){
            const directions=mediaDirections(s.prepared?'prepare':s.mode,role),tracks=p.body?.tracks;
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
      }catch(error){this.send(s,role,{type:'rpc',id:p.id,error:error.message,...(error.diagnostic?{diagnostic:error.diagnostic}:{})});}
    }catch(error){this.close(s,error.message);}
    finally{if(!s.closed)this.arm(s);}
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
