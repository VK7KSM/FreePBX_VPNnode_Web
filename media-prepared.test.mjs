import test from 'node:test';
import assert from 'node:assert/strict';
import {MediaRelay} from './media-relay.js';
import {mediaAllowed,mediaCapabilityFields,applyMediaCapabilities} from './media-capabilities.js';
function fixture(){
 let at=1000,timer,delay;const messages={browser:[],device:[]},photos=[];
 const device={id:'synthetic',managed_media:true,managed_media_prepare_v1:true};
 const relay=new MediaRelay({ELF_REALTIME:'{}'},{now:()=>at,schedule:(f,ms)=>(timer=f,delay=ms,1),cancel(){},authorizePhoto:async(...args)=>photos.push(args)});
 const {session_id}=relay.create(device,'prepare'),s=relay.sessions.get(session_id);
 for(const role of ['browser','device'])s.roles[role]={send:p=>messages[role].push(JSON.parse(p)),close(){}};
 s.published={browser:{},device:{}};
 const send=(role,p)=>relay.message(s,role,JSON.stringify(p));
 return {relay,s,device,messages,photos,send,now(v){at=v;},tick(){timer();},delay:()=>delay,
  async ready(){await send('device',{type:'transport_ready'});},
  async activate(mode='ptt',operation=s.operation+1){await send('browser',{type:'activate',mode,operation,camera:'front'});}};
}
test('预建能力必须显式声明，未知或撤回能力不能启用',()=>{
 for(const flag of [undefined,false,'true',1])assert.equal(mediaAllowed({managed_media:true,managed_media_prepare_v1:flag},'prepare'),false);
 assert.equal(mediaAllowed({managed_media:true,managed_media_prepare_v1:true},'prepare'),true);
 assert.equal(mediaAllowed({managed_media:true,managed_media_modes:[],managed_media_prepare_v1:true},'prepare'),false);
 const d={managed_media:true};applyMediaCapabilities(d,{managed_media_prepare_v1:true});assert.equal(d.managed_media_prepare_v1,true);
 applyMediaCapabilities(d,{});assert.equal(d.managed_media_prepare_v1,false);
 assert.equal(mediaCapabilityFields({managed_media_prepare_v1:true}).managed_media_prepare_v1,true);
});
test('无双向发布不能宣布待命；建链45秒无结果释放',async()=>{
 const f=fixture();delete f.s.published.browser;await f.ready();assert.equal(f.s.closed,true);
 const g=fixture();assert.equal(g.delay(),45000);g.now(46000);g.tick();assert.equal(g.s.closed,true);
});
test('停止当前功能保留同一会话，收到清理确认后才允许下个递增操作',async()=>{
 const f=fixture();await f.ready();await f.activate();await f.send('device',{type:'ready',operation:1});assert.equal(f.s.phase,'active');
 await f.send('browser',{type:'deactivate',operation:1});assert.equal(f.s.phase,'stopping');
 await f.send('device',{type:'ready',operation:1});assert.equal(f.s.phase,'stopping');
 await f.send('device',{type:'idle',operation:0});assert.equal(f.s.phase,'stopping');
 await f.send('device',{type:'idle',operation:1});assert.equal(f.s.phase,'idle');assert.equal(f.s.closed,false);
 await f.activate('photo');assert.equal(f.s.operation,2);assert.deepEqual(f.photos,[[f.device.id,f.s.id+'-2']]);
 const n=f.messages.browser.length;await f.send('device',{type:'result',operation:1,report_id:'stale'});assert.equal(f.messages.browser.length,n);
});
test('操作编号不可重放或跨号；清理未确认不允许新操作',async()=>{
 for(const operation of [0,2,1.5,'1']){const f=fixture();await f.ready();await f.activate('ptt',operation);assert.equal(f.s.closed,true);}
 const f=fixture();await f.ready();await f.activate();await f.send('browser',{type:'deactivate',operation:1});await f.activate('call');assert.equal(f.s.closed,true);
});
test('每次激活使用最新能力，撤掉PTT后仍能保持其它操作的待命能力',async()=>{
 const f=fixture();await f.ready();f.relay.updateCapabilities({...f.device,managed_media_modes:['photo']});assert.equal(f.s.closed,false);
 await f.activate('ptt');assert.equal(f.s.closed,true);
 const g=fixture();await g.ready();g.relay.updateCapabilities({...g.device,managed_media_prepare_v1:false});assert.equal(g.s.closed,true);
});
test('待命连接不受30分钟操作上限影响，后台一分钟心跳不误断',async()=>{
 const f=fixture();await f.ready();f.now(60001);f.tick();assert.equal(f.s.closed,false);
 await f.send('browser',{type:'ping'});f.now(3600001);await f.send('browser',{type:'ping'});f.tick();assert.equal(f.s.closed,false);
 assert.equal(f.delay(),90000);f.now(3690001);f.tick();assert.equal(f.s.closed,true);
});
test('PTT满60秒只停本次操作，停止确认10秒超时才关闭整条连接',async()=>{
 const f=fixture();await f.ready();await f.activate();await f.send('device',{type:'ready',operation:1});
 f.now(61000);await f.send('browser',{type:'ping'});f.tick();assert.equal(f.s.phase,'stopping');assert.equal(f.s.closed,false);
 assert.equal(f.messages.device.at(-1).type,'deactivate');assert.equal(f.messages.browser.at(-1).type,'stopping');
 f.now(71000);f.tick();assert.equal(f.s.closed,true);
});
test('激活超时关闭连接；断开无论待命还是操作中均释放身份',async()=>{
 const f=fixture();await f.ready();await f.activate();f.now(16000);f.tick();assert.equal(f.s.closed,true);
 const g=fixture();await g.ready();await g.send('browser',{type:'stop'});assert.equal(g.s.closed,true);assert.equal(g.relay.sessions.size,0);assert.equal(g.s.token,'');
});
test('照片即时预览只接受当前拍照操作，不能串到其它操作或历史',async()=>{
 const f=fixture();await f.ready();await f.activate('photo');
 await f.send('device',{type:'photo_preview',operation:1,jpeg:'/9j/2Q==',captured_at:1234});assert.equal(f.messages.browser.at(-1).type,'photo_preview');
 const n=f.messages.browser.length;await f.send('device',{type:'photo_preview',operation:0,jpeg:'/9j/2Q==',captured_at:1234});assert.equal(f.messages.browser.length,n);
 await f.send('device',{type:'photo_preview',operation:1,jpeg:'x'.repeat(88001),captured_at:1234});assert.equal(f.s.closed,true);
});

test('预备连接每端独立初始化，已有音轨排在hello之后且不重复hello',()=>{
 const relay=new MediaRelay({ELF_REALTIME:'{}'},{schedule:()=>0,cancel(){}});
 const id=relay.create({id:'test',managed_media:true,managed_media_prepare_v1:true},'prepare').session_id,s=relay.sessions.get(id);
 const ws=()=>({messages:[],accept(){},addEventListener(){},send(raw){this.messages.push(JSON.parse(raw));},close(){}});
 const browser=ws(),device=ws();relay.attach(s,'browser',browser);assert.deepEqual(browser.messages.map(m=>m.type),['waiting','hello']);
 s.published.browser={tracks:[]};relay.attach(s,'device',device);assert.deepEqual(device.messages.map(m=>m.type),['waiting','hello','tracks']);assert.equal(browser.messages.filter(m=>m.type==='hello').length,1);
});
