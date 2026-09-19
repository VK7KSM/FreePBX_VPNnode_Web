// 远程桌面信令中继：只转发 SDP/ICE 与状态；视频与控制字节走浏览器与设备之间的 DataChannel，不经 Worker。
// 与 MediaRelay 独立，不复用 SFU 发布/订阅。
export const DESKTOP_PREPARE_TIMEOUT_MS=30000;
export const DESKTOP_BROWSER_SILENCE_MS=90000;
export const DESKTOP_SESSION_LIMIT_MS=20*60*1000;
const SIGNAL_LIMIT=64000;
export const TURN_TTL_SECONDS=1800;
const DEFAULT_ICE=[{urls:'stun:stun.cloudflare.com:3478'}];
// Cloudflare TURN 短期凭据：密钥只留服务端，每个会话生成一份，有效期覆盖 20 分钟会话上限。
export function turnFetcher(env,fetcher=(url,init)=>fetch(url,init)){
  return async()=>{
    if(!env?.ELF_TURN)return DEFAULT_ICE;
    const config=JSON.parse(env.ELF_TURN);
    const r=await fetcher('https://rtc.live.cloudflare.com/v1/turn/keys/'+encodeURIComponent(config.keyId)+'/credentials/generate-ice-servers',{method:'POST',headers:{Authorization:'Bearer '+config.token,'Content-Type':'application/json'},body:JSON.stringify({ttl:TURN_TTL_SECONDS}),signal:AbortSignal.timeout(8000)});
    if(!r.ok)throw Error('TURN 凭据生成失败');
    const x=await r.json();if(!Array.isArray(x.iceServers)||!x.iceServers.length)throw Error('TURN 凭据无效');
    return x.iceServers;
  };
}
/**
 * 显示区域的长边，决定设备该编多大的画面。
 * 面板里那个小窗只有 340 像素高，而设备默认按长边 1280 编，浏览器拿到的像素比它显示的多四倍，
 * 全部被缩掉了：既不清晰也白费带宽。把实际显示尺寸带给设备，它按需编码。
 * 取 8 的倍数是编码器的要求；下限 480 是再小画面就没法看了；传不上来就返回 0，届时不下发该字段，
 * 设备走自己的保守默认值，绝不能把 0 发下去——scrcpy 的 max_size=0 表示不限制，正好是反的。
 */
export function displayLongEdge(value){
  const n=Math.round(Number(value));
  if(!Number.isFinite(n)||n<=0)return 0;
  const clamped=Math.min(1920,Math.max(480,n));
  return clamped-clamped%8;
}
export function desktopAllowed(device){return !!device&&device.enabled!==false&&device.managed_desktop_v1===true;}
export class DesktopRelay {
  constructor({now=Date.now,schedule=(fn,ms)=>setTimeout(fn,ms),cancel=id=>clearTimeout(id),iceServers=async()=>DEFAULT_ICE}={}){
    this.now=now;this.schedule=schedule;this.cancel=cancel;this.iceServers=iceServers;this.sessions=new Map();
  }
  async create(device,quality='wifi',maxSize=0){
    if(!desktopAllowed(device))throw Error('设备尚不支持远程桌面');
    if(!['wifi','cellular'].includes(quality))throw Error('画质档位无效');
    for(const s of this.sessions.values())this.expire(s);
    const existing=[...this.sessions.values()].find(s=>s.deviceId===device.id);
    if(existing)return {ok:true,session_id:existing.id,existing:true};
    if(this.sessions.size>=8)throw Error('当前远程桌面会话过多');
    // TURN 凭据失败不阻止会话：退回 STUN 直连，状态里说明。
    let ice=DEFAULT_ICE,turn=true;try{ice=await this.iceServers();}catch{turn=false;}
    const id=crypto.randomUUID(),token=crypto.randomUUID()+crypto.randomUUID(),created=this.now();
    const s={id,token,deviceId:device.id,quality,maxSize:displayLongEdge(maxSize),created,started:0,lastBrowser:created,roles:{},closed:false,generation:1,phase:'preparing',lastInput:created,iceServers:ice,turn};
    this.sessions.set(id,s);this.arm(s);
    return {ok:true,session_id:id,turn};
  }
  expire(s){
    if(!s.closed&&this.now()-s.created>=DESKTOP_SESSION_LIMIT_MS)this.close(s,'远程桌面已满20分钟，已自动关闭');
    return s.closed;
  }
  arm(s){
    if(this.expire(s))return;
    if(s.timer!==undefined)this.cancel(s.timer);
    const deadlines=[s.created+DESKTOP_SESSION_LIMIT_MS,s.lastBrowser+DESKTOP_BROWSER_SILENCE_MS];
    if(!s.started)deadlines.push(s.created+DESKTOP_PREPARE_TIMEOUT_MS);
    s.timer=this.schedule(()=>{
      if(this.expire(s))return;
      const at=this.now();
      if(!s.started&&at-s.created>=DESKTOP_PREPARE_TIMEOUT_MS)this.close(s,'设备准备超时');
      else if(at-s.lastBrowser>=DESKTOP_BROWSER_SILENCE_MS)this.close(s,'网页连接已中断');
      else this.arm(s);
    },Math.max(1,Math.min(...deadlines)-this.now()));
  }
  offer(deviceId,origin){
    const s=[...this.sessions.values()].find(s=>s.deviceId===deviceId&&!s.roles.device);
    return s&&!this.expire(s)?{session_id:s.id,token:s.token,quality:s.quality,...(s.maxSize?{max_size:s.maxSize}:{}),generation:s.generation,ice_servers:s.iceServers,expires_at:s.created+DESKTOP_PREPARE_TIMEOUT_MS,url:origin.replace(/^https:/,'wss:')+'/api/elfremote/desktop/device?session_id='+s.id}:null;
  }
  status(deviceId){
    const s=[...this.sessions.values()].find(s=>s.deviceId===deviceId&&!s.closed);
    return s?{active:true,session:{phase:s.phase,created_at:s.created,started_at:s.started}}:{active:false,session:null};
  }
  updateCapabilities(device){for(const s of this.sessions.values())if(s.deviceId===device.id&&!desktopAllowed(device))this.close(s,'设备已不再支持远程桌面');}
  get(id,role,token){
    const s=this.sessions.get(id);if(!s||this.expire(s))throw Error('远程桌面会话已结束');
    if(role==='device'&&(!token||token!==s.token))throw Error('设备连接验证失败');
    if(s.roles[role])throw Error('此会话已连接');return s;
  }
  attach(s,role,ws){
    ws.accept();s.roles[role]=ws;
    ws.addEventListener('message',e=>{try{this.message(s,role,e.data);}catch(error){this.close(s,error.message);}});
    ws.addEventListener('close',()=>this.close(s,role==='browser'?'网页已关闭桌面':'设备已断开'));
    ws.addEventListener('error',()=>this.close(s,'连接中断'));
    this.send(s,role,{type:'waiting',generation:s.generation});
    if(s.roles.browser&&s.roles.device){
      const hello={type:'hello',quality:s.quality,...(s.maxSize?{max_size:s.maxSize}:{}),generation:s.generation,ice_servers:s.iceServers,turn:s.turn};
      this.send(s,'browser',hello);this.send(s,'device',hello);
    }
  }
  send(s,role,message){try{s.roles[role]?.send(JSON.stringify(message));}catch{this.close(s,'连接中断');}}
  message(s,role,raw){
    if(this.expire(s))return;
    if(typeof raw!=='string'||raw.length>SIGNAL_LIMIT+4096)throw Error('信令消息过大');
    const p=JSON.parse(raw),other=role==='browser'?'device':'browser';
    if(role==='browser')s.lastBrowser=this.now();
    if(p.type==='stop'){this.close(s,'远程桌面已关闭');return;}
    if(p.type==='ping'){this.send(s,role,{type:'pong'});return;}
    if(p.type==='signal'){
      // SDP/ICE 原样转发；只校验代次、长度与来源，不解析内容也不记日志。
      if(p.generation!==s.generation)return;
      if(!['offer','answer','candidate'].includes(p.kind)||typeof p.payload!=='string'||p.payload.length>SIGNAL_LIMIT)throw Error('信令内容无效');
      if(p.kind==='offer'&&role!=='device'||p.kind==='answer'&&role!=='browser')throw Error('信令角色无效');
      if(!s.roles[other])throw Error('对端尚未连接');
      this.send(s,other,{type:'signal',kind:p.kind,payload:p.payload,generation:s.generation});return;
    }
    if(p.type==='restart'&&role==='browser'){
      if(s.generation>=4)throw Error('重连次数已达上限');
      s.generation+=1;const m={type:'restart',generation:s.generation};this.send(s,'device',m);this.send(s,'browser',m);return;
    }
    if(p.type==='ready'&&role==='device'){
      if(!s.started)s.started=this.now();s.phase='active';
      const info={type:'ready',started_at:s.started,generation:s.generation,width:Number(p.width)||0,height:Number(p.height)||0,encoder:String(p.encoder||'').slice(0,64)};
      this.send(s,'browser',info);return;
    }
    if(p.type==='status'&&role==='device'){this.send(s,'browser',{type:'status',message:String(p.message||'').slice(0,140),stage:String(p.stage||'').slice(0,32)});return;}
    if(p.type==='activity'&&role==='browser'){s.lastInput=this.now();return;}
    throw Error('信令消息无效');
  }
  close(s,message){
    if(s.closed)return;s.closed=true;this.sessions.delete(s.id);this.cancel(s.timer);
    console.log('desktop_session_closed',s.id,message,'browser='+!!s.roles.browser,'device='+!!s.roles.device,'started='+s.started,'age_ms='+(this.now()-s.created));
    for(const role of ['browser','device'])if(s.roles[role]){
      try{s.roles[role].send(JSON.stringify({type:'closed',message}));s.roles[role].close(1000,'desktop ended');}catch{}
    }
    s.token='';
  }
}
