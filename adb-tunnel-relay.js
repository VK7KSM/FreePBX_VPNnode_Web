export const ADB_TUNNEL_FRAME_LIMIT = 64 * 1024;
export const ADB_TUNNEL_PENDING_LIMIT = 1024 * 1024;
export const ADB_TUNNEL_CONNECT_LIMIT_MS = 60 * 1000;
export const ADB_TUNNEL_IDLE_LIMIT_MS = 20 * 60 * 1000;
export const ADB_TUNNEL_ABSOLUTE_LIMIT_MS = 30 * 60 * 1000;

export class AdbTunnelRelay {
  constructor({now=Date.now,schedule=(fn,ms)=>setTimeout(fn,ms),cancel=id=>clearTimeout(id),log=defaultLog}={}) {
    this.now=now;
    this.schedule=schedule;
    this.cancel=cancel;
    this.log=log;
    this.sessions=new Map();
  }

  create(device,origin) {
    this.sweep();
    if(!device || device.enabled===false || device.managed_adb_tunnel_v1!==true) {
      throw Error('该设备暂不支持原生ADB隧道');
    }
    if(!/^https:\/\/[^/]+$/i.test(origin))throw Error('ADB隧道地址无效');
    for(const session of this.sessions.values()) {
      if(session.deviceId===device.id)this.close(session,'session_replaced',4001);
    }
    if(this.sessions.size>=8)throw Error('当前ADB隧道会话过多');
    const id=crypto.randomUUID(),created=this.now(),expires=created+ADB_TUNNEL_ABSOLUTE_LIMIT_MS;
    const session={
      id,deviceId:device.id,created,activity:created,expires,
      hostToken:token(),deviceToken:token(),hostTokenUsed:false,deviceTokenUsed:false,
      host:null,device:null,closed:false,
      pending:{host:[],device:[]},pendingBytes:{host:0,device:0},
      bytes:{host_to_device:0,device_to_host:0}
    };
    this.sessions.set(id,session);
    this.arm(session);
    this.log('create',logFields(session));
    const base=origin.replace(/^https:/i,'wss:');
    return {
      ok:true,
      session_id:id,
      host_url:base+'/api/elfremote/adb-tunnel/host?session_id='+encodeURIComponent(id),
      host_token:session.hostToken,
      expires_at:expires,
      expires_at_unit:'unix_ms'
    };
  }

  offer(deviceId,origin) {
    this.sweep();
    const session=[...this.sessions.values()].find(value=>value.deviceId===deviceId&&!value.closed&&!value.device&&!value.deviceTokenUsed);
    if(!session)return null;
    const base=origin.replace(/^https:/i,'wss:');
    return {
      session_id:session.id,
      device_url:base+'/api/elfremote/adb-tunnel/device?session_id='+encodeURIComponent(session.id),
      token:session.deviceToken,
      expires_at:session.expires,
      expires_at_unit:'unix_ms'
    };
  }

  status(id) {
    this.sweep();
    const session=this.sessions.get(id);
    if(!session)return {ok:true,active:false,session_id:id};
    return {ok:true,active:true,session_id:id,host_connected:!!session.host,device_connected:!!session.device,
      created_at:session.created,expires_at:session.expires,expires_at_unit:'unix_ms',last_activity_at:session.activity,
      bytes:{...session.bytes}};
  }

  get(id,role,presentedToken) {
    this.sweep();
    const session=this.sessions.get(id);
    if(!session||session.closed)throw Error('ADB隧道会话已结束');
    if(role!=='host'&&role!=='device')throw Error('ADB隧道角色无效');
    const expected=role==='host'?session.hostToken:session.deviceToken;
    if(!validToken(presentedToken)||!equal(presentedToken,expected))throw Error('ADB隧道凭据无效');
    if(session[role]||session[role+'TokenUsed'])throw Error('ADB隧道凭据已使用');
    return session;
  }

  attach(session,role,socket) {
    if(!this.sessions.has(session.id)||session.closed||session[role]||session[role+'TokenUsed']) {
      throw Error('ADB隧道会话已结束或已连接');
    }
    session[role+'TokenUsed']=true;
    if(role==='host')session.hostToken='';else session.deviceToken='';
    socket.binaryType='arraybuffer';
    socket.accept();
    session[role]=socket;
    session.activity=this.now();
    socket.addEventListener('message',event=>this.message(session,role,event.data));
    socket.addEventListener('close',()=>this.close(session,'peer_closed',1000));
    socket.addEventListener('error',()=>this.close(session,'peer_error',1011));
    this.log('attach',{...logFields(session),role});
    this.flush(session,role);
  }

  message(session,role,raw) {
    this.sweep();
    if(!this.sessions.has(session.id)||session.closed)return;
    const bytes=binary(raw);
    if(!bytes){this.close(session,'binary_required',1003);return;}
    if(bytes.byteLength>ADB_TUNNEL_FRAME_LIMIT){this.close(session,'frame_too_large',1009);return;}
    session.activity=this.now();
    const other=role==='host'?'device':'host';
    session.bytes[role==='host'?'host_to_device':'device_to_host']+=bytes.byteLength;
    const peer=session[other];
    if(peer) {
      if(Number(peer.bufferedAmount||0)+bytes.byteLength>ADB_TUNNEL_PENDING_LIMIT) {
        this.close(session,'backpressure_limit',1009);return;
      }
      try{peer.send(bytes);}catch{this.close(session,'peer_send_failed',1011);}
      return;
    }
    if(session.pendingBytes[other]+bytes.byteLength>ADB_TUNNEL_PENDING_LIMIT) {
      this.close(session,'backpressure_limit',1009);return;
    }
    session.pending[other].push(bytes);
    session.pendingBytes[other]+=bytes.byteLength;
  }

  flush(session,role) {
    const socket=session[role];
    if(!socket)return;
    for(const bytes of session.pending[role]) {
      if(Number(socket.bufferedAmount||0)+bytes.byteLength>ADB_TUNNEL_PENDING_LIMIT) {
        this.close(session,'backpressure_limit',1009);return;
      }
      try{socket.send(bytes);}catch{this.close(session,'peer_send_failed',1011);return;}
    }
    session.pending[role]=[];
    session.pendingBytes[role]=0;
  }

  arm(session) {
    session.timer=this.schedule(()=>{
      this.sweep();
      if(this.sessions.has(session.id))this.arm(session);
    },10000);
  }

  sweep() {
    const now=this.now();
    for(const session of this.sessions.values()) {
      if(now>=session.expires)this.close(session,'absolute_timeout',1001);
      else if((!session.host||!session.device)&&now-session.created>=ADB_TUNNEL_CONNECT_LIMIT_MS)this.close(session,'connect_timeout',1001);
      else if(session.host&&session.device&&now-session.activity>=ADB_TUNNEL_IDLE_LIMIT_MS)this.close(session,'idle_timeout',1001);
    }
  }

  close(session,reason='admin_closed',code=1000) {
    if(!session||session.closed||!this.sessions.delete(session.id))return false;
    session.closed=true;
    this.cancel(session.timer);
    session.hostToken='';session.deviceToken='';
    for(const socket of [session.host,session.device])if(socket)try{socket.close(code,reason);}catch{}
    session.pending.host=[];session.pending.device=[];
    session.pendingBytes.host=0;session.pendingBytes.device=0;
    this.log('close',{...logFields(session),reason});
    return true;
  }
}

function token(){return Array.from(crypto.getRandomValues(new Uint8Array(32)),value=>value.toString(16).padStart(2,'0')).join('');}
function validToken(value){return typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);}
function equal(a,b){if(a.length!==b.length)return false;let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);return diff===0;}
function binary(value){
  if(value instanceof ArrayBuffer)return new Uint8Array(value);
  if(ArrayBuffer.isView(value))return new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
  return null;
}
function logFields(session){return {session_id:session.id,created_at:session.created,expires_at:session.expires,
  host_connected:!!session.host,device_connected:!!session.device,bytes:{...session.bytes}};}
function defaultLog(stage,fields){console.info('adb_tunnel_'+stage,JSON.stringify(fields));}
