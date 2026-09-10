import test from 'node:test';import assert from 'node:assert/strict';
import {fixture} from './test-support.mjs';import {recordingMetadata,recordingHttp,cleanupRecordings} from './media-recordings.js';
test('录制分段顺序、内容校验、七天过期以及部分数据保留',async()=>{
  const f=fixture(),at=Date.now();
  const call=(p,now=at)=>recordingMetadata(f.storage,new Request('https://store',{method:'POST',body:JSON.stringify({device_id:'xx',id:'record',...p})}),async()=>[{id:'xx'}],now);
  assert.equal((await call({action:'create',type:'audio',mime:'audio/webm;codecs=opus'})).status,200);
  const part={action:'part',index:0,bytes:20,sha256:'a'.repeat(64),duration_ms:5000};
  assert.equal((await call({...part,index:1})).status,400);assert.equal((await call(part)).status,200);assert.equal((await call(part)).status,200);
  assert.equal((await call({...part,sha256:'b'.repeat(64)})).status,409);
  let list=await (await call({action:'list'})).json();assert.equal(list.records[0].complete,false);assert.equal(list.records[0].bytes,20);
  assert.equal((await call({action:'finish',parts:2})).status,400);assert.equal((await call({action:'finish',parts:1,duration_ms:6000})).status,200);
  assert.equal((await call({action:'get'},at+7*86400000)).status,404);
});
test('跨分段Range读取支持播放器拖动，存储失败不确认上传',async()=>{
  const f=fixture(),objects=new Map();const stub={fetch:(_,init)=>recordingMetadata(f.storage,new Request('https://store',{method:'POST',body:init.body}),async()=>[{id:'xx'}])};
  const env={ELF_ARTIFACTS:{async put(k,b){objects.set(k,b);},async get(k,{range}){const b=objects.get(k);return b?{body:new Response(b.slice(range.offset,range.offset+range.length)).body}:null;}}};
  const url='https://test/api/elfremote/media-recordings?device_id=xx&id=one';
  await recordingHttp(env,new Request(url+'&action=create',{method:'POST',body:JSON.stringify({type:'audio',mime:'audio/webm;codecs=opus'})}),stub);
  for(let i=0;i<2;i++)assert.equal((await recordingHttp(env,new Request(url+'&index='+i,{method:'PUT',body:new Uint8Array([i*3+1,i*3+2,i*3+3])}),stub)).status,200);
  const response=await recordingHttp(env,new Request(url,{headers:{Range:'bytes=2-4'}}),stub);
  assert.equal(response.status,206);assert.equal(response.headers.get('Content-Range'),'bytes 2-4/6');assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[3,4,5]);
  env.ELF_ARTIFACTS.put=async()=>{throw Error('storage unavailable');};
  assert.equal((await recordingHttp(env,new Request(url+'&index=2',{method:'PUT',body:new Uint8Array([7])}),stub)).status,400);
  assert.equal(f.data.get('media-record/xx/one').parts.length,2);
});
