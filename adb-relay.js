// 仅在管理员打开终端期间中继；设备与浏览器均向Worker发起连接。
export class AdbRelay {
  constructor({now=Date.now,schedule=(fn,ms)=>setTimeout(fn,ms),cancel=id=>clearTimeout(id)}={}) {
    this.now=now;this.schedule=schedule;this.cancel=cancel;this.sessions=new Map();
  }
  create(device) {
    this.sweep();
    if(!device || device.enabled===false || device.managed_adb_session!==true)throw Error('该设备暂不支持ADB交互终端');
    for(const session of this.sessions.values())if(session.deviceId===device.id)this.close(session,'已打开新的ADB终端');
    if(this.sessions.size>=16)throw Error('当前终端会话过多');
    const id=crypto.randomUUID(),at=this.now();
    const token=Array.from(crypto.getRandomValues(new Uint8Array(32)),v=>v.toString(16).padStart(2,'0')).join('');
    const session={id,deviceId:device.id,token,created:at,activity:at,ready:false,browser:null,device:null,buffer:[],bufferSize:0};
    this.sessions.set(id,session);this.arm(session);
    return {ok:true,session_id:id,expires_at:at+60000};
  }
  arm(session) {
    session.timer=this.schedule(()=>{this.sweep();if(this.sessions.has(session.id))this.arm(session);},10000);
  }
  sweep() {
    const now=this.now();
    for(const session of this.sessions.values()) {
      if(!session.ready&&now-session.created>=60000)this.close(session,'设备连接超时');
      else if(now-session.created>=1800000)this.close(session,'本次终端已到时，请重新连接');
      else if(session.ready&&now-session.activity>=300000)this.close(session,'终端空闲，已断开');
    }
  }
  offer(deviceId,origin) {
    this.sweep();
    const session=Array.from(this.sessions.values()).find(s=>s.deviceId===deviceId&&!s.device);
    if(!session)return null;
    return {session_id:session.id,token:session.token,expires_at:session.created+60000,
      url:origin.replace(/^https:/,'wss:')+'/api/elfremote/adb/device?session_id='+session.id};
  }
  get(id,role,token) {
    this.sweep();const session=this.sessions.get(id);
    if(!session)throw Error('ADB会话已结束，请重新连接');
    if(role==='device'&&(!token||token.length!==session.token.length||!equal(token,session.token)))throw Error('ADB连接凭据无效');
    if(session[role])throw Error('此ADB连接已被使用');
    return session;
  }
  attach(session,role,socket) {
    if(!this.sessions.has(session.id)||session[role])throw Error('ADB会话已结束或已连接');
    socket.accept();session[role]=socket;
    socket.addEventListener('message',event=>this.message(session,role,event.data));
    socket.addEventListener('close',()=>this.close(session,'ADB 已断开'));
    socket.addEventListener('error',()=>this.close(session,'ADB连接中断'));
    if(role==='browser') {
      socket.send(JSON.stringify({type:session.ready?'ready':'connecting'}));
      for(const value of session.buffer)socket.send(value);
      session.buffer=[];session.bufferSize=0;
    }
  }
  message(session,role,raw) {
    if(!this.sessions.has(session.id))return;
    try {
      if(typeof raw!=='string'||raw.length>90000)throw Error('终端消息过大');
      const data=JSON.parse(raw);
      if(role==='browser') {
        if(data.type==='close'){this.close(session,'ADB 已断开');return;}
        if(!session.ready||!session.device)throw Error('ADB尚未连接');
        if(data.type==='input') {
          if(typeof data.data!=='string'||data.data.length>87384||!base64(data.data))throw Error('终端输入无效');
        }else if(data.type==='resize') {
          if(!Number.isInteger(data.rows)||!Number.isInteger(data.columns)||data.rows<1||data.rows>500||data.columns<1||data.columns>500)throw Error('终端尺寸无效');
        }else throw Error('不支持的终端操作');
        session.activity=this.now();session.device.send(raw);
      }else {
        if(data.type==='ready'){session.ready=true;session.activity=this.now();}
        else if(data.type==='output') {
          if(!session.ready||typeof data.data!=='string'||data.data.length>87384||!base64(data.data))throw Error('ADB输出无效');
          session.activity=this.now();
        }else if(data.type==='closed'){this.close(session,typeof data.message==='string'?data.message.slice(0,120):'ADB 已断开',data.exit);return;}
        else throw Error('ADB返回未知消息');
        if(session.browser)session.browser.send(raw);
        else if(data.type==='output') {
          if(session.bufferSize+raw.length>65536)throw Error('浏览器尚未连接');
          session.buffer.push(raw);session.bufferSize+=raw.length;
        }
      }
    }catch(error){this.close(session,error.message||'ADB连接中断');}
  }
  close(session,message,exit=null) {
    if(!this.sessions.delete(session.id))return;
    this.cancel(session.timer);session.token='';
    for(const socket of [session.browser,session.device])if(socket) {
      try{socket.send(JSON.stringify({type:'closed',message,exit:Number.isInteger(exit)?exit:null}));socket.close(1000,'ADB session closed');}catch{}
    }
    session.buffer=[];
  }
}
function equal(a,b){let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);return diff===0;}
function base64(value){return value.length%4===0&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);}
