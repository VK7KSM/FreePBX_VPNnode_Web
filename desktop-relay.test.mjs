import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopRelay, desktopAllowed, turnFetcher } from './desktop-relay.js';

function fakeSocket(){
  const s={sent:[],listeners:{},closed:null};
  s.accept=()=>{};s.send=m=>s.sent.push(JSON.parse(m));s.close=(code,reason)=>{s.closed={code,reason};};
  s.addEventListener=(name,fn)=>{s.listeners[name]=fn;};
  s.emit=(name,data)=>s.listeners[name]?.({data});
  return s;
}
function relay(){
  let now=1000;const timers=[];
  const r=new DesktopRelay({now:()=>now,schedule:(fn,ms)=>{timers.push({fn,at:now+ms});return timers.length;},cancel:()=>{}});
  return {r,tick:ms=>{now+=ms;for(const t of timers.splice(0))if(t.at<=now)t.fn();else timers.push(t);}};
}
const device={id:'dev1',enabled:true,managed_desktop_v1:true};

test('desktopAllowed 只认显式能力字段', () => {
  assert.equal(desktopAllowed(device),true);
  assert.equal(desktopAllowed({id:'x',managed_desktop_v1:'true'}),false);
  assert.equal(desktopAllowed({...device,enabled:false}),false);
});

test('turnFetcher 用密钥生成短期凭据，缺配置时退回 STUN', async () => {
  assert.deepEqual(await turnFetcher({})(),[{urls:'stun:stun.cloudflare.com:3478'}]);
  let seen;const f=turnFetcher({ELF_TURN:JSON.stringify({keyId:'k1',token:'t1'})},async(url,init)=>{seen={url,init};return {ok:true,json:async()=>({iceServers:[{urls:['turn:x']},{urls:['turn:y'],username:'u',credential:'c'}]})};});
  const ice=await f();
  assert.match(seen.url,/\/turn\/keys\/k1\/credentials\/generate-ice-servers$/);
  assert.equal(seen.init.headers.Authorization,'Bearer t1');assert.equal(JSON.parse(seen.init.body).ttl,1800);
  assert.equal(ice[1].credential,'c');
});

test('创建、领取与双端 hello；重复创建返回原会话', async () => {
  const {r}=relay();
  const created=await r.create(device);
  assert.equal((await r.create(device)).session_id,created.session_id);
  const offer=r.offer('dev1','https://v.example');
  assert.match(offer.url,/^wss:\/\/v.example\/api\/elfremote\/desktop\/device\?session_id=/);
  assert.equal(offer.generation,1);
  const b=fakeSocket(),d=fakeSocket();
  r.attach(r.get(created.session_id,'browser'),'browser',b);
  assert.throws(()=>r.get(created.session_id,'device','wrong'),/验证失败/);
  r.attach(r.get(created.session_id,'device',offer.token),'device',d);
  assert.equal(b.sent.at(-1).type,'hello');assert.equal(d.sent.at(-1).type,'hello');
  assert.equal(r.offer('dev1','https://v.example'),null);
});

test('信令按代次与角色转发，ready 记录开始时间', async () => {
  const {r}=relay();
  const {session_id}=await r.create(device);const s=r.sessions.get(session_id);
  const b=fakeSocket(),d=fakeSocket();
  r.attach(s,'browser',b);r.attach(s,'device',d);
  d.emit('message',JSON.stringify({type:'signal',kind:'offer',payload:'v=0',generation:1}));
  assert.deepEqual(b.sent.at(-1),{type:'signal',kind:'offer',payload:'v=0',generation:1});
  b.emit('message',JSON.stringify({type:'signal',kind:'answer',payload:'v=0a',generation:1}));
  assert.equal(d.sent.at(-1).kind,'answer');
  b.emit('message',JSON.stringify({type:'signal',kind:'candidate',payload:'c',generation:0}));
  assert.equal(d.sent.at(-1).kind,'answer');
  b.emit('message',JSON.stringify({type:'signal',kind:'offer',payload:'x',generation:1}));
  assert.equal(s.closed,true);
});

test('浏览器可请求重启协商，代次递增并通知双方', async () => {
  const {r}=relay();
  const {session_id}=await r.create(device);const s=r.sessions.get(session_id);
  const b=fakeSocket(),d=fakeSocket();r.attach(s,'browser',b);r.attach(s,'device',d);
  b.emit('message',JSON.stringify({type:'restart'}));
  assert.equal(s.generation,2);assert.equal(d.sent.at(-1).generation,2);assert.equal(b.sent.at(-1).type,'restart');
  d.emit('message',JSON.stringify({type:'ready',width:240,height:320,encoder:'OMX.MTK.VIDEO.ENCODER.AVC'}));
  assert.equal(b.sent.at(-1).type,'ready');assert.equal(b.sent.at(-1).width,240);assert.equal(s.phase,'active');
});

test('准备超时与网页静默会关闭会话并通知', async () => {
  const {r,tick}=relay();
  const {session_id}=await r.create(device);const s=r.sessions.get(session_id);
  const d=fakeSocket();r.attach(s,'device',d);
  tick(30000);
  assert.equal(s.closed,true);assert.equal(d.sent.at(-1).type,'closed');assert.equal(d.closed.code,1000);
  assert.equal(r.status('dev1').active,false);
});
