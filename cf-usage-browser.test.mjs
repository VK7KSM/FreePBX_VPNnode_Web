import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {cfUsageClientSource} from './cf-usage-client.js';

function browser({authenticated=true,hidden=false,response}={}) {
  let now=Date.parse('2026-09-12T01:00:00Z'),sequence=0,calls=0;
  const timers=new Map(),events={},storage=new Map();
  const element=()=>({children:[],dataset:{},appendChild(child){this.children.push(child);},replaceChildren(){this.children=[];},contains(){return false;}});
  const fields=new Map(),box=element();box.querySelector=selector=>{if(!fields.has(selector))fields.set(selector,element());return fields.get(selector);};
  class Clock extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  const context={Date:Clock,Response,document:{hidden,querySelector:()=>box,createElement:element,addEventListener:(name,fn)=>{events[name]=fn;}},
    adminSession:{authenticated},addEventListener:(name,fn)=>{events[name]=fn;},
    sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},
    setTimeout:(fn,delay)=>{const id=++sequence;timers.set(id,{fn,at:now+delay});return id;},clearTimeout:id=>timers.delete(id),
    fetch:async()=>{calls++;return response?response():Response.json({ok:true,status:'ok',generatedAt:new Clock().toISOString(),metrics:[]});}};
  context.window=context;vm.runInNewContext(cfUsageClientSource,context);
  const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
  async function advance(ms){const end=now+ms;for(;;){const next=[...timers].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;now=next[1].at;timers.delete(next[0]);await next[1].fn();await settle();}now=end;}
  return {context,box,fields,events,advance,settle,get calls(){return calls;}};
}

test('CF导航空闲每十五分钟才读一次，隐藏和未登录不产生请求',async()=>{
  const b=browser();await b.advance(1000);assert.equal(b.calls,1);
  await b.advance(899000);assert.equal(b.calls,1);
  await b.advance(1000);assert.equal(b.calls,2);
  b.context.document.hidden=true;await b.advance(3600000);assert.equal(b.calls,2);
  b.context.document.hidden=false;await b.events.visibilitychange();await b.settle();assert.equal(b.calls,3);
  b.context.adminSession.authenticated=false;await b.advance(3600000);assert.equal(b.calls,3);assert.equal(b.box.hidden,true);
});

test('CF导航服从长Retry-After，页面退出停止后台计时，缓存恢复不立即重读',async()=>{
  const b=browser({response:()=>Response.json({ok:false},{status:429,headers:{'Retry-After':'7200'}})});
  await b.advance(1000);assert.equal(b.calls,1);await b.advance(7199000);assert.equal(b.calls,1);
  await b.advance(1000);assert.equal(b.calls,2);b.events.pagehide();await b.advance(86400000);assert.equal(b.calls,2);
  const cached=browser();await cached.advance(1000);cached.events.pagehide();await cached.advance(1000);await cached.events.pageshow({persisted:true});await cached.settle();assert.equal(cached.calls,1);
});

test('已知日额度错误保持低频复核，恢复后不因指数退避额外等待数小时',async()=>{
  let exhausted=true;const b=browser({response:()=>exhausted?Response.json({ok:false,code:'workers_quota_exceeded'},{status:429,headers:{'Retry-After':'900'}}):Response.json({ok:true,metrics:[]})});
  await b.advance(1000);await b.advance(900000*4);assert.equal(b.calls,5);
  exhausted=false;await b.advance(900000);assert.equal(b.calls,6);
});

test('摘要和明细显示百分比，任一子指标超过70%警示，R2保留容量参考分母',async()=>{
  const metrics=[
    {id:'workers_requests',service:'Workers',label:'请求',period:'day',periodKey:'2026-09-12',used:394,limit:100000},
    {id:'kv_reads',service:'KV',label:'读取',period:'day',periodKey:'2026-09-12',used:520,limit:100000},
    {id:'kv_writes',service:'KV',label:'写入',period:'day',periodKey:'2026-09-12',used:710,limit:1000},
    {id:'do_requests',service:'DO',label:'请求',period:'day',periodKey:'2026-09-11',used:76664,limit:100000},
    {id:'r2_storage',service:'R2',label:'标准存储',period:'capacity',used:19306282711,unit:'bytes',limit:null,freeMonthlyAverageBytes:10000000000}
  ];
  const b=browser({response:()=>Response.json({ok:true,metrics})});await b.advance(1000);
  const summary=b.fields.get('[data-cf-summary]').children;assert.deepEqual(summary.map(x=>x.children[0].textContent),['0.4%','71%','76.7%','193.1%']);assert.match(summary[1].title,/写入/);assert.match(summary[2].title,/2026-09-11/);assert.equal(b.box.dataset.warning,'true');
  const rows=b.fields.get('[data-cf-rows]').children.filter(x=>x.className==='cf-usage-row');assert.equal(rows.at(-1).children[1].textContent,'19.3 GB / 10.0 GB');assert.equal(rows.at(-1).children[2].textContent,'193.1%');assert.match(b.fields.get('[data-cf-note]').textContent,/上次统计/);
});

test('70%本身不触发暗红底色，未知额度不伪造百分比',async()=>{
  for(const used of [700,701]){const b=browser({response:()=>Response.json({ok:true,metrics:[{id:'workers_requests',service:'Workers',label:'请求',used,limit:1000},{id:'r2_storage',service:'R2',label:'存储',used:200,limit:null}]})});await b.advance(1000);assert.equal(b.box.dataset.warning,String(used>700));assert.equal(b.fields.get('[data-cf-summary]').children[3].children[0].textContent,'—');}
});
