import test from 'node:test';
import assert from 'node:assert/strict';
import {AdbTunnelRelay,ADB_TUNNEL_FRAME_LIMIT,ADB_TUNNEL_PENDING_LIMIT,
  ADB_TUNNEL_CONNECT_LIMIT_MS,ADB_TUNNEL_IDLE_LIMIT_MS,ADB_TUNNEL_ABSOLUTE_LIMIT_MS} from './adb-tunnel-relay.js';

class Socket{
  handlers={};sent=[];closes=[];bufferedAmount=0;
  accept(){this.accepted=true;}
  addEventListener(name,fn){this.handlers[name]=fn;}
  send(value){this.sent.push(new Uint8Array(value));}
  close(code,reason){this.closes.push({code,reason});}
  emit(value){this.handlers.message({data:value});}
}
function setup(){let now=1000;const logs=[];const relay=new AdbTunnelRelay({now:()=>now,schedule:()=>1,cancel:()=>{},log:(stage,data)=>logs.push({stage,data})});
  return {relay,logs,advance:value=>now+=value,device:{id:'pixel-fixture',enabled:true,managed_adb_tunnel_v1:true}};}

test('独立能力门、同源WSS地址和host/device一次性凭据',()=>{
  const {relay,device}=setup();
  assert.throws(()=>relay.create({...device,managed_adb_tunnel_v1:false},'https://example.test'),/不支持/);
  const created=relay.create(device,'https://example.test'),offer=relay.offer(device.id,'https://example.test');
  assert.match(created.host_url,/^wss:\/\/example\.test\/api\/elfremote\/adb-tunnel\/host\?session_id=/);
  assert.match(offer.device_url,/^wss:\/\/example\.test\/api\/elfremote\/adb-tunnel\/device\?session_id=/);
  assert.match(created.host_token,/^[a-f0-9]{64}$/);assert.match(offer.token,/^[a-f0-9]{64}$/);
  assert.notEqual(created.host_token,offer.token);assert.equal(created.expires_at_unit,'unix_ms');
  const host=new Socket(),deviceSocket=new Socket();
  relay.attach(relay.get(created.session_id,'host',created.host_token),'host',host);
  relay.attach(relay.get(created.session_id,'device',offer.token),'device',deviceSocket);
  assert.throws(()=>relay.get(created.session_id,'host',created.host_token),/凭据/);
  assert.equal(relay.offer(device.id,'https://example.test'),null);
});

test('ADB二进制保持原字节双向转发且文本帧关闭整条会话',()=>{
  const {relay,device}=setup(),created=relay.create(device,'https://example.test'),offer=relay.offer(device.id,'https://example.test');
  const host=new Socket(),target=new Socket();relay.attach(relay.get(created.session_id,'host',created.host_token),'host',host);
  const first=Uint8Array.from([0x43,0x4e,0x58,0x4e,0,255]);host.emit(first);
  relay.attach(relay.get(created.session_id,'device',offer.token),'device',target);
  assert.deepEqual([...target.sent[0]],[...first]);
  const reply=Uint8Array.from([0x4f,0x4b,0,1]);target.emit(reply.buffer);assert.deepEqual([...host.sent[0]],[...reply]);
  host.emit('CNXN');assert.equal(relay.sessions.size,0);assert.equal(target.closes.at(-1).reason,'binary_required');
});

test('单帧64KiB和单向等待队列1MiB边界强制关闭',()=>{
  const a=setup(),created=a.relay.create(a.device,'https://example.test'),host=new Socket();
  a.relay.attach(a.relay.get(created.session_id,'host',created.host_token),'host',host);
  host.emit(new Uint8Array(ADB_TUNNEL_FRAME_LIMIT));assert.equal(a.relay.sessions.size,1);
  for(let i=1;i<ADB_TUNNEL_PENDING_LIMIT/ADB_TUNNEL_FRAME_LIMIT;i++)host.emit(new Uint8Array(ADB_TUNNEL_FRAME_LIMIT));
  assert.equal(a.relay.sessions.size,1);
  host.emit(new Uint8Array(1));assert.equal(a.relay.sessions.size,0);assert.equal(host.closes.at(-1).reason,'backpressure_limit');
  const b=setup(),second=b.relay.create(b.device,'https://example.test'),other=new Socket();
  b.relay.attach(b.relay.get(second.session_id,'host',second.host_token),'host',other);
  other.emit(new Uint8Array(ADB_TUNNEL_FRAME_LIMIT+1));assert.equal(other.closes.at(-1).reason,'frame_too_large');
});

test('新会话替换同设备旧会话，任一端断开后令牌和双端立即清理',()=>{
  const {relay,device}=setup(),first=relay.create(device,'https://example.test'),offer=relay.offer(device.id,'https://example.test');
  const host=new Socket(),target=new Socket();const session=relay.get(first.session_id,'host',first.host_token);relay.attach(session,'host',host);
  relay.attach(relay.get(first.session_id,'device',offer.token),'device',target);
  const second=relay.create(device,'https://example.test');assert.equal(relay.sessions.has(first.session_id),false);
  assert.equal(host.closes.at(-1).reason,'session_replaced');assert.equal(session.hostToken,'');assert.equal(session.deviceToken,'');
  const secondOffer=relay.offer(device.id,'https://example.test'),h2=new Socket(),d2=new Socket();
  relay.attach(relay.get(second.session_id,'host',second.host_token),'host',h2);
  relay.attach(relay.get(second.session_id,'device',secondOffer.token),'device',d2);h2.handlers.close();
  assert.equal(relay.status(second.session_id).active,false);assert.equal(d2.closes.at(-1).reason,'peer_closed');
});

test('连接、空闲和绝对超时分别释放会话',()=>{
  const pending=setup(),a=pending.relay.create(pending.device,'https://example.test');pending.advance(ADB_TUNNEL_CONNECT_LIMIT_MS);
  pending.relay.sweep();assert.equal(pending.relay.status(a.session_id).active,false);
  const idle=setup(),b=idle.relay.create(idle.device,'https://example.test'),offer=idle.relay.offer(idle.device.id,'https://example.test');
  const host=new Socket(),target=new Socket();idle.relay.attach(idle.relay.get(b.session_id,'host',b.host_token),'host',host);
  idle.relay.attach(idle.relay.get(b.session_id,'device',offer.token),'device',target);idle.advance(ADB_TUNNEL_IDLE_LIMIT_MS);idle.relay.sweep();
  assert.equal(host.closes.at(-1).reason,'idle_timeout');
  const absolute=setup(),c=absolute.relay.create(absolute.device,'https://example.test'),o=absolute.relay.offer(absolute.device.id,'https://example.test');
  const h=new Socket(),d=new Socket();absolute.relay.attach(absolute.relay.get(c.session_id,'host',c.host_token),'host',h);
  absolute.relay.attach(absolute.relay.get(c.session_id,'device',o.token),'device',d);
  for(let elapsed=0;elapsed<ADB_TUNNEL_ABSOLUTE_LIMIT_MS;elapsed+=60000){absolute.advance(60000);h.emit(new Uint8Array([1]));}
  assert.equal(absolute.relay.status(c.session_id).active,false);assert.equal(d.closes.at(-1).reason,'absolute_timeout');
});

test('阶段日志仅含会话统计，不包含令牌或ADB载荷',()=>{
  const {relay,device,logs}=setup(),created=relay.create(device,'https://example.test'),offer=relay.offer(device.id,'https://example.test');
  const host=new Socket();relay.attach(relay.get(created.session_id,'host',created.host_token),'host',host);host.emit(Uint8Array.from([9,8,7,6]));
  relay.close(relay.sessions.get(created.session_id),'admin_closed');const text=JSON.stringify(logs);
  assert.equal(text.includes(created.host_token),false);assert.equal(text.includes(offer.token),false);assert.equal(text.includes('[9,8,7,6]'),false);
  assert.match(text,/host_to_device/);
});
