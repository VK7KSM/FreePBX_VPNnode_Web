import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('./media-client.js',import.meta.url),'utf8');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(mode='call'){
 const device={id:'fixture',managed_media_modes:[mode]},peers=[],sockets=[],contexts=[];
 const track=(kind='audio')=>({id:'track-'+Math.random(),kind,readyState:'live',stop(){this.readyState='ended';}});
 class Stream{constructor(tracks=[]){this.tracks=tracks;}getTracks(){return this.tracks;}getAudioTracks(){return this.tracks.filter(t=>t.kind==='audio');}getVideoTracks(){return this.tracks.filter(t=>t.kind==='video');}addTrack(t){this.tracks.push(t);}}
 class Context{constructor(){contexts.push(this);this.state='suspended';}async resume(){this.state='running';}async close(){this.state='closed';}}
 class Peer{constructor(){peers.push(this);this.connectionState='new';this.transceivers=[];}addTransceiver(t){const row={mid:'0',sender:{track:t}};this.transceivers.push(row);return row;}getTransceivers(){return this.transceivers;}async createOffer(){return {type:'offer',sdp:'local'};}async createAnswer(){return {type:'answer',sdp:'answer'};}async setLocalDescription(d){this.localDescription={...d,toJSON:()=>({...d})};}async setRemoteDescription(d){this.remoteDescription=d;}close(){this.connectionState='closed';}connect(){this.connectionState='connected';this.onconnectionstatechange?.();}remote(t=track()){this.ontrack?.({track:t});return t;}}
 class Socket{constructor(){sockets.push(this);this.readyState=1;this.sent=[];}send(s){this.sent.push(JSON.parse(s));}close(){this.readyState=3;}emit(p){this.onmessage({data:JSON.stringify(p)});}reply(action,result={},error){const row=this.sent.find(p=>p.action===action&&!p.replied);assert.ok(row,'等待RPC '+action);row.replied=true;this.emit({type:'rpc',id:row.id,result,error});}}
 const local=new Stream([track()]);const timers=new Set();
 const sandbox={currentDev:()=>device,ElfMediaCapabilities:{allows:()=>true},renderRemoteConsole(){},document:{querySelector:()=>null},esc:s=>s,AudioContext:Context,RTCPeerConnection:Peer,WebSocket:Socket,MediaStream:Stream,navigator:{mediaDevices:{getUserMedia:async()=>local}},location:{origin:'https://example.test'},fetch:async()=>({ok:true,headers:new Headers({'Content-Type':'application/json'}),json:async()=>({ok:true,session_id:'test-session'})}),Headers,AbortSignal,URLSearchParams,Date,Promise,setTimeout(fn,ms){const t=setTimeout(fn,ms);timers.add(t);return t;},clearTimeout, setInterval:()=>0,clearInterval(){},addEventListener(){}};sandbox.window=sandbox;
 vm.runInNewContext(source,sandbox);const media=sandbox.ElfMedia;
 return {media,device,peers,sockets,contexts,local,track,async start(){await media.start(mode);const ws=sockets[0];ws.emit({type:'hello'});await flush();ws.reply('new');await flush();ws.reply('publish',{sessionDescription:{type:'answer',sdp:'published'}});await flush();ws.reply('published');await flush();return ws;},connecting:()=>media.feedback(device).includes('正在连接'),async dispose(){await media.stop();timers.forEach(clearTimeout);}};
}
test('双向电话不能把发送连接和设备就绪当作接收订阅完成',async()=>{
 const f=fixture();try{
  const ws=await f.start(),pc=f.peers[0];pc.connect();ws.emit({type:'ready'});await flush();assert.equal(f.connecting(),true);
  ws.emit({type:'tracks'});await flush();ws.reply('subscribe',{sessionDescription:{type:'offer',sdp:'remote'}});await flush();pc.remote();assert.equal(f.connecting(),true,'实际音轨出现但应答未确认');
  ws.reply('answer');await flush();assert.equal(f.connecting(),false);
 }finally{await f.dispose();}
});
test('双向电话应答确认后仍等待真实接收音轨，不误用发送收发器空轨',async()=>{
 const f=fixture();try{
  const ws=await f.start(),pc=f.peers[0];pc.connect();ws.emit({type:'ready'});ws.emit({type:'tracks'});await flush();ws.reply('subscribe',{sessionDescription:{type:'offer',sdp:'remote'}});await flush();ws.reply('answer');await flush();assert.equal(f.connecting(),true);
  const ended=f.track();ended.stop();pc.remote(ended);assert.equal(f.connecting(),true);pc.remote();assert.equal(f.connecting(),false);
 }finally{await f.dispose();}
});
test('设备晚就绪和重复轨通知保持单次订阅，停止后释放本地采音',async()=>{
 const f=fixture();try{
  const ws=await f.start(),pc=f.peers[0];pc.connect();ws.emit({type:'tracks'});ws.emit({type:'tracks'});await flush();ws.reply('subscribe',{sessionDescription:{type:'offer',sdp:'remote'}});await flush();pc.remote();ws.reply('answer');await flush();assert.equal(f.connecting(),true);ws.emit({type:'ready'});await flush();assert.equal(f.connecting(),false);assert.equal(ws.sent.filter(p=>p.action==='subscribe').length,1);
  await f.media.stop();assert.equal(f.media.isActive(),false);assert.equal(pc.connectionState,'closed');assert.ok(f.local.getTracks().every(t=>t.readyState==='ended'));assert.ok(f.contexts.every(c=>c.state==='closed'));
 }finally{await f.dispose();}
});
test('PTT仍只需发送与设备就绪，不等待不存在的回传订阅',async()=>{
 const f=fixture('ptt');try{const ws=await f.start();f.peers[0].connect();ws.emit({type:'ready'});await flush();assert.equal(f.connecting(),false);assert.equal(ws.sent.some(p=>p.action==='subscribe'),false);}finally{await f.dispose();}
});
