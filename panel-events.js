import {nextContactChange} from './report-recovery.js';

const TAG='panel-events';
export function panelKey(key) {
  return typeof key==='string' && (['remote_devices','remote_device_models','remote_enrolls'].includes(key)
    || key.startsWith('push/request/') || key.startsWith('elfremote_releases'));
}

// 只发失效通知；设备资料仍由原有登录鉴权接口读取。
export class PanelEvents {
  constructor(ctx) {
    this.ctx=ctx;
    if(ctx.setWebSocketAutoResponse && typeof WebSocketRequestResponsePair!=='undefined')
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('panel:ping','panel:pong'));
  }
  accept(socket) {
    this.ctx.acceptWebSocket(socket,[TAG]);
    socket.serializeAttachment({kind:TAG});
    socket.send('{"type":"ready"}');
  }
  changed() {
    for(const socket of this.ctx.getWebSockets?.(TAG)||[]) {
      try { socket.send('{"type":"changed"}'); }
      catch { try {socket.close(1011,'通知连接失效');} catch {} }
    }
  }
  message(socket,message) {
    if(socket.deserializeAttachment()?.kind!==TAG)return;
    if(message==='panel:ping')socket.send('panel:pong');
    else socket.close(1008,'此连接仅接收状态通知');
  }
  close(socket,code) { try {socket.close(code===1005?1000:code);} catch {} }
  async transaction(run) {
    let dirty=false;
    const result=await this.ctx.storage.transaction(async storage=>{
      const tracked=new Proxy(storage,{get(target,key){
        if(key==='put')return async (name,value,...rest)=>{
          const result=await target.put(name,value,...rest);
          if(panelKey(name)||(name&&typeof name==='object'&&Object.keys(name).some(panelKey)))dirty=true;
          return result;
        };
        if(key==='delete')return async name=>{
          const result=await target.delete(name);
          if((Array.isArray(name)?name:[name]).some(panelKey))dirty=true;
          return result;
        };
        const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
      }});
      return run(tracked);
    });
    // 事务失败不通知；所有写入完成后每事务最多通知一次。
    if(dirty)this.changed();
    return result;
  }
}

export function panelRefreshDelay(devices,enrolls=[],now=Date.now()) {
  let deadline=now+300000;
  const consider=value=>{const at=typeof value==='number'?value:Date.parse(value);if(at>now&&at<deadline)deadline=at;};
  for(const d of devices) {
    consider(nextContactChange(d,now));
    if(d.task && ['pending','claimed','running'].includes(d.task.state))consider(d.task.expires_at);
    if(d.update && !['success','recovered','rejected','failed','expired'].includes(d.update.state))consider(d.update.expires_at);
  }
  for(const d of enrolls)consider(d.expires_at);
  return Math.max(1000,deadline-now);
}
