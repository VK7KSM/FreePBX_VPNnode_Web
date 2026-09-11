import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {panelLifecycleSource} from './panel-lifecycle.js';
test('静态版本检查后台暂停、并发合并，新版本仅提示刷新而不打断操作',async()=>{
 let tick,now=1000,calls=0,finish,reloads=0,button;const listeners={};
 const doc={hidden:true,querySelector:q=>q.startsWith('meta')?{content:'old'}:{before:b=>button=b},createElement:()=>({style:{}}),addEventListener:(n,f)=>listeners[n]=f};
 const c={Date:class extends Date{static now(){return now;}},document:doc,adminSession:{authenticated:true},setInterval:f=>tick=f,fetch:()=>{calls++;return new Promise(r=>finish=r);},location:{reload:()=>reloads++},addEventListener:(n,f)=>listeners[n]=f};c.window=c;vm.runInNewContext(panelLifecycleSource,c);
 await tick();assert.equal(calls,0);doc.hidden=false;const a=tick();await tick();assert.equal(calls,1);
 finish({ok:true,json:async()=>({version:'new'})});await a;assert.equal(reloads,0);assert.equal(button.textContent,'新版页面 · 刷新');
 now+=600000;await tick();assert.equal(calls,1);button.onclick();assert.equal(reloads,1);
});
