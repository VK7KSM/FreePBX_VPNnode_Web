import test from 'node:test';import assert from 'node:assert/strict';import {webmDuration} from './webm-duration.js';
test('补齐WebM总时长保留原始媒体字节，重复修复不增加字段',()=>{
 const header=new Uint8Array([0x18,0x53,0x80,0x67,0x01,255,255,255,255,255,255,255,0x15,0x49,0xa9,0x66,0x87,0x2a,0xd7,0xb1,0x83,0x0f,0x42,0x40,0x1f,0x43,0xb6,0x75,0x83,1,2,3]);
 const out=webmDuration(header,40000);assert.equal(out.length,header.length+11);assert.deepEqual([...out.slice(-8)],[0x1f,0x43,0xb6,0x75,0x83,1,2,3]);assert.equal(new DataView(out.buffer).getFloat64(27),40000);
 const again=webmDuration(out,41000);assert.equal(again.length,out.length);assert.equal(new DataView(again.buffer).getFloat64(27),41000);
 assert.throws(()=>webmDuration(header,-1));assert.throws(()=>webmDuration(header.slice(0,19),1000));
});
