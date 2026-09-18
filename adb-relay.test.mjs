import test from 'node:test';
import assert from 'node:assert/strict';
import { AdbRelay, ADB_HISTORY_BYTES } from './adb-relay.js';

function sock(){const s={sent:[],closed:null,listeners:{}};s.accept=()=>{};s.send=m=>s.sent.push(m);s.close=(c,r)=>{s.closed={c,r};};s.addEventListener=(n,f)=>{s.listeners[n]=f;};s.emit=(n,d)=>s.listeners[n]?.({data:d});return s;}
const device={id:'dev1',enabled:true,managed_adb_session:true};
const b64=t=>Buffer.from(t).toString('base64');

test('旁观者收到尺寸、就绪与输出副本，上行被忽略，关闭只移除自己', () => {
  const r=new AdbRelay({schedule:()=>1,cancel:()=>{}});
  const {session_id}=r.create(device);const s=r.sessions.get(session_id);
  const browser=sock(),dev=sock();r.attach(s,'browser',browser);r.attach(s,'device',dev);
  dev.emit('message',JSON.stringify({type:'ready'}));
  browser.emit('message',JSON.stringify({type:'resize',rows:24,columns:80}));
  dev.emit('message',JSON.stringify({type:'output',data:b64('hello')}));
  const ob=sock();r.attachObserver(s,ob);
  const first=JSON.parse(ob.sent[0]);
  assert.equal(first.type,'observing');assert.equal(first.rows,24);assert.equal(first.columns,80);assert.equal(first.history,1);
  assert.equal(JSON.parse(ob.sent[1]).type,'output');
  dev.emit('message',JSON.stringify({type:'output',data:b64('more')}));
  assert.equal(ob.sent.length,3);
  const devSent=dev.sent.length;
  ob.emit('message',JSON.stringify({type:'input',data:b64('rm -rf')}));
  assert.equal(dev.sent.length,devSent,'旁观者的消息不转给设备');
  ob.emit('close');
  assert.equal(s.observers.size,0);assert.ok(r.sessions.has(session_id),'主会话不受影响');
  assert.equal(r.observeStatus('dev1').active,true);
});

test('历史缓冲有界；主会话关闭时旁观者收到 closed', () => {
  const r=new AdbRelay({schedule:()=>1,cancel:()=>{}});
  const {session_id}=r.create(device);const s=r.sessions.get(session_id);
  const browser=sock(),dev=sock();r.attach(s,'browser',browser);r.attach(s,'device',dev);
  dev.emit('message',JSON.stringify({type:'ready'}));
  for(let i=0;i<40;i++)dev.emit('message',JSON.stringify({type:'output',data:b64('x'.repeat(3000))}));
  assert.ok(s.historySize<=ADB_HISTORY_BYTES+4200);
  const ob=sock();r.attachObserver(s,ob);
  r.close(s,'ADB 已断开');
  assert.equal(JSON.parse(ob.sent.at(-1)).type,'closed');assert.equal(ob.closed.c,1000);
  assert.equal(r.observeStatus('dev1').active,false);
});
