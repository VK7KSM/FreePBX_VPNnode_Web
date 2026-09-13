import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('./media-client.js',import.meta.url),'utf8');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(mode){
  const device={id:'synthetic'},upload=deferred(),events=[];
  const element={srcObject:{},pause(){events.push('pause');}};
  const node={connected:true,querySelector:()=>element,replaceChildren(){events.push('clear');},remove(){this.connected=false;}};
  const pc={close(){events.push('close');}};
  const state={device,mode,prepared:true,operation:1,activationSent:true,node,pc,recording:'synthetic',parts:1,upload:upload.promise,pending:{},recordStarted:Date.now(),ws:{readyState:1,send(){},close(){}}};
  const ctx={window:{addEventListener(){}},Date,Promise,URLSearchParams,AbortSignal,clearInterval,clearTimeout,esc:s=>s,renderRemoteConsole(){events.push('render');},fetch:async()=>({ok:true,headers:new Headers({'Content-Type':'application/json'}),json:async()=>({ok:true})})};
  vm.runInNewContext(source.replace('  return {','  window.fixture={set:s=>active=s,idle:()=>{active.idleAcknowledged=true;preparedIdle(active);}};\n  return {'),ctx);
  ctx.window.fixture.set(state);
  return {state,node,element,pc,events,upload,media:ctx.window.ElfMedia,ack:ctx.window.fixture.idle};
}
for(const mode of ['microphone','video'])for(const earlyIdle of [true,false]){
  test(`${mode}结束等待保存与${earlyIdle?'提前':'延后'}待命回执期间保留预览外框`,async()=>{
    const f=fixture(mode),stopping=f.media.stop();await tick();
    assert.equal(f.state.mode,'stopping');assert.equal(f.node.connected,true);
    assert.equal(f.element.srcObject,null);assert.ok(f.events.includes('clear'));
    assert.ok(f.events.indexOf('render')<f.events.indexOf('clear'));
    assert.ok(!f.events.includes('close'));
    if(earlyIdle)f.ack();
    assert.equal(f.state.mode,'stopping');f.upload.resolve();await stopping;
    if(!earlyIdle){assert.equal(f.state.mode,'stopping');f.ack();}
    assert.equal(f.state.mode,'prepare');assert.equal(f.node.connected,true);
    assert.equal(f.media.previewNode(f.state.device),null);
  });
}
test('录制收尾等待期间只复用当前设备的媒体元素，断开仍释放播放资源',async()=>{
  const f=fixture('video'),creating=deferred();f.state.recordCreating=creating.promise;
  assert.equal(f.media.previewNode(f.state.device),f.node);
  assert.equal(f.media.previewNode({id:'other'}),null);
  const stopping=f.media.stop();assert.equal(f.media.previewNode(f.state.device),f.node);
  creating.resolve();f.upload.resolve();await stopping;
  await f.media.stop('',true);assert.ok(f.events.includes('close'));assert.equal(f.node.connected,true);
});
