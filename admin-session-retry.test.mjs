import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {adminSessionSource} from './admin-session.js';

function browser(fetch){
 const timers=[],elements=new Map();
 const context={fetch,URL,location:{href:'https://example.test/devices',origin:'https://example.test'},localStorage:{removeItem(){}},
  document:{hidden:false,getElementById(id){if(!elements.has(id))elements.set(id,{style:{}});return elements.get(id);}},
  setTimeout(fn,ms){timers.push({fn,ms});return timers.length;},clearTimeout(){},alert(){}};
 context.window=context;vm.runInNewContext(adminSessionSource,context);return {state:context.adminSession,timers,context};
}
test('同页面并发会话检查只发送一个请求，同一就绪回调执行一次',async()=>{
 let release,calls=0,ready=0;const b=browser(()=>{calls++;return new Promise(resolve=>{release=resolve;});}),callback=()=>ready++;
 const work=Array.from({length:20},()=>b.state.check(callback));
 assert.equal(calls,1);release(new Response('{"ok":true}'));
 await Promise.all(work);assert.equal(ready,1);assert.equal(b.state.authenticated,true);
});
test('服务连续失败采用指数退避，不把固定Retry-After当成永久一分钟轮询',async()=>{
 const b=browser(async()=>new Response('{}',{status:503,headers:{'Retry-After':'30'}}));
 await b.state.check(()=>{});await b.state.check(()=>{});await b.state.check(()=>{});
 assert.deepEqual(b.timers.map(t=>t.ms),[60000,120000,240000]);
});
test('HTTP日期Retry-After被遵守，超过十五分钟也不提前重试',async()=>{
 const future=Date.now()+3600000,b=browser(async()=>new Response('{}',{status:429,headers:{'Retry-After':new Date(future).toUTCString()}}));
 await b.state.check(()=>{});assert.ok(b.timers[0].ms>3500000);assert.ok(b.timers[0].ms<=3600000);
});
test('401结束自动检查，不继续发送重试请求',async()=>{
 const b=browser(async()=>new Response('{}',{status:401}));await b.state.check(()=>assert.fail('失效会话不能启动业务'));
 assert.equal(b.timers.length,0);assert.equal(b.state.authenticated,false);
});
