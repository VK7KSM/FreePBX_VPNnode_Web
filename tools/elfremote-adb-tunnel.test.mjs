import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {EventEmitter} from 'node:events';
import {startBridge} from './elfremote-adb-tunnel.mjs';

class FakeWebSocket extends EventEmitter{
  static instances=[];
  readyState=0;bufferedAmount=0;sent=[];
  constructor(url,options){super();this.url=url;this.options=options;FakeWebSocket.instances.push(this);queueMicrotask(()=>{this.readyState=1;this.emit('open');});}
  send(data,options){this.sent.push({data:Buffer.from(data),options});}
  close(code,reason){this.readyState=3;this.closeArgs={code,reason};queueMicrotask(()=>this.emit('close',code,Buffer.from(reason)));}
}
const id='12345678-1234-1234-1234-123456789abc',token='a'.repeat(64),url='wss://v.elfradio.net/api/elfremote/adb-tunnel/host?session_id='+id;
const waitFor=async check=>{for(let i=0;i<100;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('等待测试事件超时');};

test('桥接器仅监听回环地址、只接收一个TCP客户端并保持ADB字节',async t=>{
  FakeWebSocket.instances=[];let output='';const bridge=await startBridge({url,token,WebSocketImpl:FakeWebSocket,stdout:{write:s=>output+=s},stderr:{write(){}}});
  t.after(()=>bridge.close());assert.equal(bridge.address.address,'127.0.0.1');assert.match(output,/adb connect 127\.0\.0\.1:/);
  const client=net.connect({host:'127.0.0.1',port:bridge.address.port});await new Promise(resolve=>client.once('connect',resolve));
  client.write(Buffer.from([0x43,0x4e,0x58,0x4e,0,255]));await waitFor(()=>FakeWebSocket.instances[0]?.sent.length===1);
  const ws=FakeWebSocket.instances[0];assert.equal(ws.options.headers.Authorization,'Bearer '+token);assert.equal(ws.options.perMessageDeflate,false);
  assert.deepEqual([...ws.sent[0].data],[0x43,0x4e,0x58,0x4e,0,255]);
  const received=new Promise(resolve=>client.once('data',resolve));ws.emit('message',Buffer.from([0x4f,0x4b,0,1]),true);
  assert.deepEqual([...await received],[0x4f,0x4b,0,1]);ws.close(1000,'admin_closed');await bridge.done;
});

test('桥接器拒绝非同源合同形状、URL令牌和无效host令牌',async()=>{
  for(const invalid of [
    'https://v.elfradio.net/api/elfremote/adb-tunnel/host?session_id='+id,
    'wss://other.test/api/elfremote/adb-tunnel/device?session_id='+id,
    'wss://other.test/api/elfremote/adb-tunnel/host?session_id='+id,
    url+'&token='+token
  ])await assert.rejects(startBridge({url:invalid,token,WebSocketImpl:FakeWebSocket,stdout:{write(){}},stderr:{write(){}}}),/地址|会话/);
  await assert.rejects(startBridge({url,token:'bad',WebSocketImpl:FakeWebSocket,stdout:{write(){}},stderr:{write(){}}}),/令牌/);
});
