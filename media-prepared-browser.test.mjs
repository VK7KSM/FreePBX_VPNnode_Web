import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('./media-client.js',import.meta.url),'utf8');
const flush=()=>new Promise(r=>setImmediate(r));
function fixture(){
 const device={id:'synthetic',managed_media_prepare_v1:true},peers=[],sockets=[],contexts=[],locals=[],requests=[],events={},timers=new Set();let captureCount=0,captureDeferred;
 class Stream{constructor(tracks=[]){this.tracks=tracks;}getTracks(){return this.tracks;}getAudioTracks(){return this.tracks.filter(t=>t.kind==='audio');}getVideoTracks(){return this.tracks.filter(t=>t.kind==='video');}addTrack(t){this.tracks.push(t);}}
 const track=kind=>({id:kind+Math.random(),kind,readyState:'live',stop(){this.readyState='ended';}});
 class Context{constructor(){contexts.push(this);this.state='suspended';}async resume(){this.state='running';}async close(){this.state='closed';}createMediaStreamDestination(){return {stream:new Stream([track('audio')])};}createConstantSource(){return {offset:{value:1},connect(){},start(){},stop(){}};}}
 class Peer{constructor(){peers.push(this);this.connectionState='new';this.transceivers=[];this.listeners=new Set();}addEventListener(n,f){this.listeners.add(f);}removeEventListener(n,f){this.listeners.delete(f);}addTransceiver(t){const row={mid:String(this.transceivers.length),sender:{track:typeof t==='string'?null:t,async replaceTrack(track){this.track=track;}}};this.transceivers.push(row);return row;}getTransceivers(){return this.transceivers;}async createOffer(){return {type:'offer',sdp:'local'};}async createAnswer(){return {type:'answer',sdp:'answer'};}async setLocalDescription(d){this.localDescription={...d,toJSON:()=>({...d})};}async setRemoteDescription(d){this.remoteDescription=d;}close(){this.connectionState='closed';}connect(){this.connectionState='connected';this.onconnectionstatechange();this.listeners.forEach(f=>f());}remote(kind){this.ontrack({track:track(kind)});}}
 class Socket{constructor(){sockets.push(this);this.sent=[];this.readyState=1;}send(p){this.sent.push(JSON.parse(p));}close(){this.readyState=3;}emit(p){this.onmessage({data:JSON.stringify(p)});}reply(action,result={}){const p=this.sent.find(p=>p.action===action&&!p.replied);assert.ok(p,action);p.replied=true;this.emit({type:'rpc',id:p.id,result});}}
 const sandbox={currentDev:()=>device,ElfMediaCapabilities:{allows:()=>true},renderRemoteConsole(){},document:{querySelector:()=>null,addEventListener:(n,f)=>events[n]=f},esc:s=>s,AudioContext:Context,RTCPeerConnection:Peer,WebSocket:Socket,MediaStream:Stream,navigator:{mediaDevices:{async getUserMedia(){captureCount++;const local=new Stream([track('audio')]);locals.push(local);if(captureDeferred)await captureDeferred;return local;}}},location:{origin:'https://example.test'},fetch:async(url,init)=>{requests.push({url,init});return {ok:true,headers:new Headers({'Content-Type':'application/json'}),json:async()=>({ok:true,session_id:'synthetic-session'})};},Headers,AbortSignal,URLSearchParams,Date,Promise,performance,setTimeout(fn,ms){const t=setTimeout(fn,ms);timers.add(t);return t;},clearTimeout,setInterval:()=>0,clearInterval(){},addEventListener:(n,f)=>events[n]=f};sandbox.window=sandbox;
 vm.runInNewContext(source,sandbox);const media=sandbox.ElfMedia;
 return {media,device,peers,sockets,contexts,locals,requests,events,captureCount:()=>captureCount,deferCapture(){let resolve;captureDeferred=new Promise(r=>resolve=r);return resolve;},
 async connect(){await media.toggleConnection();const ws=sockets[0];ws.emit({type:'hello'});await flush();ws.reply('new');await flush();ws.reply('publish',{sessionDescription:{type:'answer',sdp:'published'}});await flush();peers[0].connect();await flush();ws.reply('published');await flush();ws.emit({type:'tracks'});await flush();ws.reply('subscribe',{sessionDescription:{type:'offer',sdp:'remote'}});await flush();peers[0].remote('audio');peers[0].remote('video');ws.reply('answer');await flush();peers[0].connect();ws.emit({type:'transport_ready'});await flush();return ws;},
 async dispose(){await media.stop('',true);timers.forEach(clearTimeout);}};
}
test('未点击连接不能启动新协议功能，连接时准备系统默认麦克风但待命禁用，不发送真实声音',async()=>{
 const f=fixture();try{
  assert.equal((f.media.controls(f.device).match(/ disabled/g)||[]).length,6);await f.media.start('ptt');assert.equal(f.requests.length,0);
  await f.connect();assert.equal(f.captureCount(),1);assert.equal(f.locals[0].getAudioTracks()[0].enabled,false);assert.equal(f.contexts.length,1);assert.equal(f.requests.length,1);assert.equal(f.requests[0].init.body.includes('prepare'),true);
  assert.equal(f.media.controls(f.device).includes(' disabled'),false);assert.match(f.media.connectionControl(f.device),/>断开</);
 }finally{await f.dispose();}
});
test('连续两次PTT只建一次会话，停止恢复待命不关闭PC或WS',async()=>{
 const f=fixture();try{
  const ws=await f.connect();await f.media.start('ptt');const first=ws.sent.find(p=>p.type==='activate');assert.equal(first.operation,1);assert.equal(f.captureCount(),1);
  ws.emit({type:'ready',operation:1});await flush();await f.media.stop();assert.equal(f.peers[0].connectionState,'connected');assert.equal(ws.readyState,1);assert.equal(f.locals[0].getTracks()[0].readyState,'live');assert.equal(f.locals[0].getAudioTracks()[0].enabled,false);
  assert.equal((f.media.controls(f.device).match(/ disabled/g)||[]).length,6);ws.emit({type:'idle',operation:1});await flush();assert.equal(f.media.isActive(),false);
  await f.media.start('ptt');assert.equal(ws.sent.filter(p=>p.type==='activate').at(-1).operation,2);assert.equal(f.requests.length,1);assert.equal(f.peers.length,1);assert.equal(f.captureCount(),1);assert.equal(f.locals[0].getAudioTracks()[0].enabled,true);
  await f.media.toggleConnection();assert.equal(f.peers[0].connectionState,'closed');assert.equal(ws.readyState,3);assert.ok(f.contexts.every(c=>c.state==='closed'));
 }finally{await f.dispose();}
});
test('连接时麦克风授权挂起后断开，迟到输入不能复活',async()=>{
 const f=fixture();try{const release=f.deferCapture();await f.media.toggleConnection();await f.media.stop('',true);release();await flush();assert.equal(f.locals[0].getTracks()[0].readyState,'ended');assert.equal(f.media.isActive(),false);}finally{await f.dispose();}
});
test('停止后旧ready被忽略；服务端到时停止只结束本次操作',async()=>{
 const f=fixture();try{
  const ws=await f.connect();await f.media.start('ptt');await f.media.stop();ws.emit({type:'ready',operation:1});await flush();assert.match(f.media.feedback(f.device),/正在结束/);
  ws.emit({type:'idle',operation:1});await flush();await f.media.start('ptt');ws.emit({type:'stopping',operation:2,message:'本次操作已到时'});await flush();assert.equal(ws.readyState,1);assert.equal(f.peers[0].connectionState,'connected');
  ws.emit({type:'idle',operation:2});await flush();assert.equal(f.media.isActive(),false);
 }finally{await f.dispose();}
});
test('后台切换不隐式断开，页面退出和真正媒体失败完整关闭',async()=>{
 const f=fixture();try{await f.connect();assert.equal(f.events.visibilitychange,undefined);f.events.pagehide();await flush();assert.equal(f.peers[0].connectionState,'closed');}finally{await f.dispose();}
 const g=fixture();try{await g.connect();g.peers[0].connectionState='failed';g.peers[0].onconnectionstatechange();await flush();assert.equal(g.sockets[0].readyState,3);}finally{await g.dispose();}
});
