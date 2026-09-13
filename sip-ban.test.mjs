import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import worker from './worker.js';
import {fixture,request,login} from './test-support.mjs';

test('封禁操作必须经过管理员认证',async()=>{
  const f=fixture();
  const r=await worker.fetch(request('/api/sip/ban','POST',{ext:'204',action:'unban',ip:'192.0.2.1'}),f.env);
  assert.equal(r.status,401);
});

test('管理员解封只转发指定分机操作，拒绝不存在的分机',async()=>{
  const f=fixture({admin_pass:'fixture-password',sip_extensions:[{ext:'204',name:'Test'}],sip_groups:[],sip_gateways:[],sip_secrets:{},heartbeat_token:'fixture-token'});
  const cookie=await login(f), original=globalThis.fetch, calls=[];
  globalThis.fetch=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return Response.json({ok:true,banned:false});};
  try{
    const r=await worker.fetch(request('/api/sip/ban','POST',{ext:'204',action:'unban',ip:'192.0.2.1'},cookie),f.env);
    assert.equal(r.status,200);
    assert.equal((await r.json()).banned,false);
    assert.deepEqual(calls,[{url:'https://api.elfradio.net/api/sip/ban',body:{ext:'204',action:'unban',ip:'192.0.2.1'}}]);
    const bad=await worker.fetch(request('/api/sip/ban','POST',{ext:'999',action:'ban',ip:'192.0.2.1'},cookie),f.env);
    assert.equal(bad.status,404);assert.equal(calls.length,1);
  }finally{globalThis.fetch=original;}
});

test('同出口分机显示封禁，过期状态不得冒充当前状态',()=>{
  const source=fs.readFileSync(new URL('./sip-client.js',import.meta.url),'utf8');
  const start=source.indexOf('function sipBanInfo('),end=source.indexOf('function renderBanEditor(',start);
  const ctx=vm.createContext({ST:{bans:{available:true,checked_at:Date.now()/1000,banned_ips:['192.0.2.1'],endpoints:{109:{ip:'192.0.2.1'},204:{ip:'192.0.2.1'}}}},STALE:false,E:[{ext:'109'},{ext:'204'}]});
  vm.runInContext(source.slice(start,end),ctx);
  assert.equal(ctx.sipBanInfo('109').banned,true);
  assert.equal(ctx.sipBanInfo('204').affected.length,2);
  ctx.STALE=true;
  assert.equal(ctx.sipBanInfo('109').available,false);
  assert.equal(ctx.sipBanInfo('109').banned,false);
});
