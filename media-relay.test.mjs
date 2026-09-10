import test from 'node:test';import assert from 'node:assert/strict';
import {MediaRelay,mediaDirections} from './media-relay.js';
function fixture(){let at=1000;const messages={browser:[],device:[]},relay=new MediaRelay({ELF_REALTIME:JSON.stringify({appId:'app',secret:'secret'})},{now:()=>at,schedule:()=>0,cancel(){},fetcher:async()=>Response.json({sessionId:'rtc',tracks:[],sessionDescription:{type:'answer',sdp:'sdp'}})});const created=relay.create({id:'xx',managed_media:true},'ptt');const s=relay.sessions.get(created.session_id);for(const role of ['browser','device'])s.roles[role]={send:v=>messages[role].push(JSON.parse(v)),close(){}};return {relay,s,messages,setTime:n=>at=n};}
test('PTT只允许网页发送音频，设备不能发布麦克风或视频',async()=>{
  const {relay,s,messages}=fixture();assert.deepEqual(mediaDirections('ptt','device'),{audio:false,video:false});
  await relay.message(s,'device',JSON.stringify({type:'rpc',id:1,action:'new'}));
  await relay.message(s,'device',JSON.stringify({type:'rpc',id:2,action:'publish',body:{tracks:[{trackName:'audio',mid:'0'}]}}));
  assert.match(messages.device.at(-1).error,/方向/);assert.equal(s.published.device,undefined);
  await relay.message(s,'browser',JSON.stringify({type:'rpc',id:3,action:'new'}));
  await relay.message(s,'browser',JSON.stringify({type:'rpc',id:4,action:'publish',body:{tracks:[{trackName:'audio',mid:'0'}],sessionDescription:{type:'offer',sdp:'offer'}}}));
  assert.equal(s.published.browser.tracks[0].sessionId,'rtc');
});
test('浏览器和设备均连接后才通知开始，关闭任一端关闭整段通信',()=>{
  const {relay,s,messages}=fixture();s.roles={};const events={};
  function ws(role){return {accept(){},send:v=>messages[role].push(JSON.parse(v)),close(){},addEventListener:(name,fn)=>events[role+name]=fn};}
  relay.attach(s,'device',ws('device'));assert.equal(messages.device.some(m=>m.type==='hello'),false);
  relay.attach(s,'browser',ws('browser'));assert.equal(messages.device.filter(m=>m.type==='hello').length,1);
  events.browserclose();assert.equal(relay.sessions.size,0);assert.equal(messages.device.at(-1).type,'closed');
});
test('设备会话凭据与目标绑定，关闭后不能重用，不能跨会话订阅任意轨道',async()=>{
  const {relay,s,messages}=fixture();assert.throws(()=>relay.get(s.id,'device','wrong'),/验证/);
  await relay.message(s,'device',JSON.stringify({type:'rpc',id:1,action:'new'}));
  await relay.message(s,'device',JSON.stringify({type:'rpc',id:2,action:'subscribe',body:{tracks:[{sessionId:'other'}]}}));assert.match(messages.device.at(-1).error,/尚未就绪/);
  relay.close(s,'stop');assert.throws(()=>relay.get(s.id,'device',s.token),/结束/);
});
test('PTT60秒硬截止从真实就绪起算，结束后可立即再次开启',async()=>{
  let at=0,timer;const r=new MediaRelay({ELF_REALTIME:'{}'},{now:()=>at,schedule:f=>(timer=f,0),cancel(){}});
  const d={id:'xx',managed_media:true},first=r.create(d,'ptt'),s=r.sessions.get(first.session_id);at=10000;await r.message(s,'device','{"type":"ready"}');
  at=69999;timer();assert.equal(r.sessions.size,1);at=70000;timer();assert.equal(r.sessions.size,0);assert.ok(r.create(d,'ptt').session_id);
});

test('SFU创建无轨道会话必须省略正文，空JSON会触发服务器SDP校验',async()=>{
 const {relay,s}=fixture();let seen=false;
 relay.fetcher=async(url,init)=>{assert.ok(url.endsWith('/sessions/new'));assert.equal(init.body,undefined);assert.equal(init.headers['Content-Type'],undefined);seen=true;return Response.json({sessionId:'rtc'});};
 await relay.message(s,'browser',JSON.stringify({type:'rpc',id:1,action:'new'}));assert.ok(seen);assert.equal(s.rtc.browser,'rtc');
});
test('浏览器断网未发关闭帧时结束警报，容忍后台标签页一分钟节流',async()=>{
 let at=1000,timer;const relay=new MediaRelay({},{now:()=>at,schedule:f=>(timer=f,0),cancel(){}});
 const {session_id}=relay.create({id:'xx',managed_media:true},'alarm'),s=relay.sessions.get(session_id);
 await relay.message(s,'device','{"type":"ready"}');at+=60000;timer();assert.equal(s.closed,false);
 await relay.message(s,'browser','{"type":"ping"}');at+=89999;timer();assert.equal(s.closed,false);
 at++;timer();assert.equal(s.closed,true);assert.equal(relay.sessions.size,0);
});
test('实时录音和录像即使心跳正常也在30分钟结束',async()=>{
 for(const mode of ['microphone','video']){
  let at=1000,timer;const relay=new MediaRelay({ELF_REALTIME:'{}'},{now:()=>at,schedule:f=>(timer=f,0),cancel(){}});
  const {session_id}=relay.create({id:'xx',managed_media:true},mode),s=relay.sessions.get(session_id);
  await relay.message(s,'device','{"type":"ready"}');at+=1799999;
  await relay.message(s,'browser','{"type":"ping"}');timer();assert.equal(s.closed,false);
  at++;timer();assert.equal(s.closed,true);
 }
});
