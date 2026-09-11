import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
const source=fs.readFileSync(new URL('./devices-client.js',import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function browser(fetcher){
  let now=100000;const timers=[];
  class Clock extends Date{static now(){return now;}}
  const context=vm.createContext({Date:Clock,Response,URLSearchParams,crypto,performance:{now:()=>now},
    adminSession:{authenticated:true,check(){}},document:{hidden:false,addEventListener(){},getElementById:()=>null},
    setInterval(){},setTimeout(fn,delay){timers.push({fn,at:now+delay});return timers.length;},fetch:(...args)=>fetcher(context,...args)});
  vm.runInContext(source,context);timers.length=0;
  context.renderList=()=>{};context.updateReportFeedback=()=>{};context.renderOps=()=>{};context.loadDevices=async()=>true;
  context.DEV=[{id:'fixture',managed_system_settings:true,enabled:true}];context.selDev='fixture';context.selFn='wifi';context.SYSTEM_TAB='声音与显示';
  return {context,async advance(ms){const until=now+ms;for(;;){timers.sort((a,b)=>a.at-b.at);if(!timers[0]||timers[0].at>until)break;const timer=timers.shift();now=timer.at;timer.fn();await settle();}now=until;await settle();}};
}
test('未登录或后台只暂停结果读取，不消耗查询和失败预算',async()=>{
  const requests=[],b=browser(async(_c,url)=>{requests.push(url);return Response.json({ok:true,task:{id:'original',state:'success'}});}),c=b.context,owner={};
  c.adminSession.authenticated=false;
  for(let i=0;i<200;i++)assert.equal(await c.readWatchedTask(owner,'fixture','original'),null);
  c.adminSession.authenticated=true;c.document.hidden=true;
  for(let i=0;i<200;i++)assert.equal(await c.readWatchedTask(owner,'fixture','original'),null);
  assert.equal(requests.length,0);assert.equal(owner.resultPoll.attempts,0);assert.equal(owner.resultPoll.failures,0);
  c.document.hidden=false;assert.equal((await c.readWatchedTask(owner,'fixture','original')).task.id,'original');
  assert.equal(requests.length,1);assert.equal(owner.resultPoll.attempts,1);
});
test('包装器在401失效登录后原任务保持，重新登录继续读同一个任务',async()=>{
  const requests=[],b=browser(async(c,url)=>{requests.push(url);if(requests.length===1){c.adminSession.authenticated=false;throw Error('登录已失效');}return Response.json({ok:true,task:{id:'original',state:'success'}});}),c=b.context,owner={};
  assert.equal(await c.readWatchedTask(owner,'fixture','original'),null);
  assert.equal(owner.resultPoll.failures,0);assert.equal(owner.resultPoll.attempts,0);
  await b.advance(600000);assert.equal(await c.readWatchedTask(owner,'fixture','original'),null);assert.equal(requests.length,1);
  c.adminSession.authenticated=true;assert.equal((await c.readWatchedTask(owner,'fixture','original')).task.state,'success');
  assert.equal(requests[0],requests[1]);assert.equal(owner.resultPoll.failures,0);
});
test('Workers日额度长Retry-After不会被截成15分钟，等待不消耗额外尝试',async()=>{
  let calls=0;const b=browser(async()=>{calls++;return Response.json({ok:false,code:'workers_quota_exceeded',msg:'CF Workers 日请求额度已用尽，等待恢复'},{status:429,headers:{'Retry-After':'7200'}});}),c=b.context,owner={};
  await assert.rejects(c.readWatchedTask(owner,'fixture','original'),e=>e.retryAfter===7200000);
  await b.advance(3600000);assert.equal(await c.readWatchedTask(owner,'fixture','original'),null);
  assert.equal(calls,1);assert.equal(owner.resultPoll.attempts,1);assert.equal(owner.resultPoll.failures,1);
});
test('主动拉取暂停超过旧五分钟预算后恢复原回执，命令只下发一次',async()=>{
  const calls=[],b=browser(async(c,url,options)=>{
    calls.push({url,method:options?.method||'GET'});
    if(options?.method==='POST'){c.document.hidden=true;return Response.json({ok:true,request:{request_id:'original'}});}
    return Response.json({ok:true,request:{request_id:'original',state:'completed'}});
  }),c=b.context;
  const running=c.requestDeviceStatus('fixture');await settle();await b.advance(600000);
  assert.equal(calls.length,1);assert.equal(c.STATUS.fixture,'等待设备领取');
  c.document.hidden=false;c.adminSession.authenticated=false;await b.advance(600000);assert.equal(calls.length,1);
  c.adminSession.authenticated=true;await b.advance(2000);assert.equal(await running,true);
  assert.deepEqual(calls.map(x=>x.method),['POST','GET']);assert.equal(c.STATUS.fixture,'');
});
test('系统配置暂停超过旧150秒预算仍恢复原任务，不再次下发设置',async()=>{
  const calls=[],b=browser(async(c,url,options)=>{
    calls.push({url,method:options?.method||'GET',body:options?.body});
    if(options?.method==='POST'){c.document.hidden=true;return Response.json({ok:true,task:{id:'original'}});}
    return Response.json({ok:true,task:{id:'original',state:'success',result:{text:JSON.stringify({group:'sound',sampled_at:1,brightness:42})}}});
  }),c=b.context;
  const running=c.runSystemSettings({group:'sound',action:'read'});await settle();await b.advance(600000);
  assert.equal(calls.length,1);assert.equal(c.systemSettingsState().pending,true);
  c.document.hidden=false;c.adminSession.authenticated=false;await b.advance(300000);assert.equal(calls.length,1);
  c.adminSession.authenticated=true;await b.advance(1200);await running;
  assert.deepEqual(calls.map(x=>x.method),['POST','GET']);assert.match(calls[1].url,/task_id=original/);
  assert.equal(c.systemSettingsState().pending,false);assert.equal(c.DEV[0].system_settings.sound.brightness,42);
});
