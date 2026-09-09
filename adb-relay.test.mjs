import test from 'node:test';import assert from 'node:assert/strict';import {AdbRelay} from './adb-relay.js';
class Socket {
  handlers={};sent=[];closed=false;
  accept(){}
  addEventListener(name,fn){this.handlers[name]=fn;}
  send(raw){this.sent.push(JSON.parse(raw));}
  close(){this.closed=true;}
  emit(data){this.handlers.message({data:JSON.stringify(data)});}
}
function fixture(){let time=1000;const relay=new AdbRelay({now:()=>time,schedule:()=>1,cancel:()=>{}});return {relay,advance:n=>time+=n};}
function create(relay){return relay.create({id:'fixture-device',enabled:true,managed_adb_session:true});}
test('终端分别验证管理员入口会话与设备一次性连接凭据',()=>{
  const {relay}=fixture(),created=create(relay),offer=relay.offer('fixture-device','https://example.test');
  assert.equal(relay.offer('unrelated','https://example.test'),null);assert.equal(created.token,undefined);
  assert.throws(()=>relay.get(created.session_id,'device','invalid'),/凭据/);
  const browser=new Socket(),device=new Socket();
  relay.attach(relay.get(created.session_id,'browser'),'browser',browser);
  relay.attach(relay.get(created.session_id,'device',offer.token),'device',device);
  assert.throws(()=>relay.get(created.session_id,'device',offer.token),/使用/);
  assert.equal(browser.sent.at(-1).type,'connecting');
  device.emit({type:'ready'});assert.equal(browser.sent.at(-1).type,'ready');
  browser.emit({type:'input',data:'Aw=='});assert.equal(device.sent.at(-1).data,'Aw==');
  device.emit({type:'output',data:'aGVsbG8='});assert.equal(browser.sent.at(-1).data,'aGVsbG8=');
  browser.handlers.close();assert.equal(relay.sessions.size,0);assert.ok(device.closed);
  assert.throws(()=>relay.get(created.session_id,'device',offer.token),/结束/);
});
test('未握手成功不能执行输入且畸形消息不会转发',()=>{
  const {relay}=fixture(),created=create(relay),browser=new Socket();relay.attach(relay.get(created.session_id,'browser'),'browser',browser);
  browser.emit({type:'input',data:'aGk='});assert.ok(browser.closed);assert.equal(relay.sessions.size,0);
  const next=create(relay),offer=relay.offer('fixture-device','https://example.test'),device=new Socket();relay.attach(relay.get(next.session_id,'device',offer.token),'device',device);
  device.emit({type:'ready'});device.emit({type:'output',data:'not base64'});assert.ok(device.closed);assert.equal(relay.sessions.size,0);
});
test('等待连接及空闲会话按时释放而新会话关闭旧连接',()=>{
  const {relay,advance}=fixture();const old=create(relay),browser=new Socket();relay.attach(relay.get(old.session_id,'browser'),'browser',browser);
  create(relay);assert.ok(browser.closed);assert.equal(relay.sessions.size,1);
  advance(60000);relay.sweep();assert.equal(relay.sessions.size,0);
  const session=create(relay),offer=relay.offer('fixture-device','https://example.test'),device=new Socket();relay.attach(relay.get(session.session_id,'device',offer.token),'device',device);
  device.emit({type:'ready'});advance(300000);relay.sweep();assert.ok(device.closed);assert.equal(relay.sessions.size,0);
});
test('浏览器稍晚接入仍取得真实连接状态与有界缓存输出',()=>{
  const {relay}=fixture(),created=create(relay),offer=relay.offer('fixture-device','https://example.test'),device=new Socket();
  relay.attach(relay.get(created.session_id,'device',offer.token),'device',device);device.emit({type:'ready'});device.emit({type:'output',data:'aGk='});
  const browser=new Socket();relay.attach(relay.get(created.session_id,'browser'),'browser',browser);
  assert.deepEqual(browser.sent.map(x=>x.type),['ready','output']);
  device.emit({type:'closed',message:'命令结束',exit:7});assert.equal(browser.sent.at(-1).exit,7);assert.equal(relay.sessions.size,0);
  assert.throws(()=>relay.create({id:'disabled',enabled:false,managed_adb_session:true}),/不支持/);
});
