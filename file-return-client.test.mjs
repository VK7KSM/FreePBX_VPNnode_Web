import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const source=fs.readFileSync(new URL('./devices-client.js',import.meta.url),'utf8');
function setup(store=new Map(),fetcher=async()=>Response.json({ok:true})){let now=1000;const ctx=vm.createContext({localStorage:{getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)},Date:class extends Date{static now(){return now;}},URLSearchParams,AbortSignal,fetch:fetcher,readServiceJson:async r=>{if(!r.ok){const e=Error('模拟失败');e.retryAfter=120000;throw e;}return r.json();}});vm.runInContext(source.slice(source.indexOf('var RETURN_CLEANUP_BUSY='),source.indexOf('function returnUrl(')),ctx);return {ctx,store,time:n=>now=n};}
const receipt={device_id:'synthetic',task_id:'synthetic-file',size:10,sha256:'a'.repeat(64)};
test('取回删除回执跨刷新恢复、失败遵守退避、成功移出队列',async()=>{
 let calls=0;const h=setup(new Map(),async()=>{calls++;return new Response('',{status:503});});h.ctx.queueReturnCleanup(receipt);await h.ctx.retryReturnCleanups();assert.equal(calls,1);await h.ctx.retryReturnCleanups();assert.equal(calls,1);
 const restored=setup(h.store,async()=>{calls++;return Response.json({ok:true,cleanup_pending:true});});restored.time(121001);await restored.ctx.retryReturnCleanups();assert.equal(calls,2);assert.equal(restored.ctx.returnCleanupQueue().length,0);
});
test('损坏本机缓存不会打断设备页面或产生错误清理请求',async()=>{
 const store=new Map([['elf-return-cleanup-v1','[null,{},"wrong"]']]);let calls=0;const h=setup(store,async()=>{calls++;return Response.json({ok:true});});await h.ctx.retryReturnCleanups();assert.equal(calls,0);
});
