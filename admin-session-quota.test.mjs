import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {adminSessionSource} from './admin-session.js';
const page='<!doctype html><html><body><h1><span>Error</span><span>1027</span></h1><p>This website has been temporarily rate limited.</p><footer>Cloudflare</footer></body></html>';
function browser(fetch,now){
 const Clock=now===undefined?Date:class extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};
 const elements=new Map(),context={fetch,Response,Headers,URL,Date:Clock,location:{href:'https://example.test/devices',origin:'https://example.test'},localStorage:{removeItem(){}},
  document:{getElementById(id){if(!elements.has(id))elements.set(id,{style:{}});return elements.get(id);}}};
 context.window=context;vm.runInNewContext(adminSessionSource,context);return context;
}
const htmlResponse=(body=page,status=429)=>new Response(body,{status,headers:{'Content-Type':'text/html; charset=UTF-8','Content-Length':String(body.length),'Content-Encoding':'gzip'}});
test('仅同源API的CF原生HTML 1027被转换，最多十五分钟复核且不触发退出',async()=>{
 const before=Date.parse('2026-09-12T08:00:00Z'),c=browser(async()=>htmlResponse(),before);c.adminSession.accept();
 const response=await c.fetch(new URL('https://example.test/api/devices'));
 assert.equal(response.status,429);assert.match(response.headers.get('Content-Type'),/application\/json/);
 assert.equal(response.headers.get('Content-Length'),null);assert.equal(response.headers.get('Content-Encoding'),null);
 const data=await response.json();assert.equal(data.code,'workers_quota_exceeded');assert.match(data.msg,/日请求额度已用尽/);
 const reset=(Math.floor(before/86400000)+1)*86400000;assert.equal(Date.parse(data.reset_at),reset);
 assert.equal(Date.parse(data.retry_at),before+900000);assert.equal(response.headers.get('Retry-After'),'900');
 assert.equal(c.adminSession.authenticated,true);
});
test('午夜前1027等待到午夜，午夜后残留1027不冻结下一整日',async()=>{
 for(const [time,seconds,retryAt,resetAt] of [
  ['2026-09-12T23:58:00Z',120,'2026-09-13T00:00:00Z','2026-09-13T00:00:00Z'],
  ['2026-09-13T00:00:01Z',900,'2026-09-13T00:15:01Z','2026-09-14T00:00:00Z'],
  ['2026-09-13T00:12:00Z',900,'2026-09-13T00:27:00Z','2026-09-14T00:00:00Z']
 ]){
  const c=browser(async()=>htmlResponse(),Date.parse(time)),response=await c.fetch('/api/devices'),body=await response.json();
  assert.equal(Number(response.headers.get('Retry-After')),seconds);
  assert.equal(Date.parse(body.retry_at),Date.parse(retryAt));assert.equal(Date.parse(body.reset_at),Date.parse(resetAt));
 }
});
test('CF原生页面如果已给出真实Retry-After也原样遵守，不被合成上限覆盖',async()=>{
 const now=Date.parse('2026-09-13T00:00:01Z'),original=htmlResponse();original.headers.set('Retry-After','7200');
 const c=browser(async()=>original,now),response=await c.fetch('/api/devices'),body=await response.json();
 assert.equal(response.headers.get('Retry-After'),'7200');assert.equal(Date.parse(body.retry_at),now+7200000);
});
test('普通429、其他CF错误、外站、非API及成功页面保持原响应不误判额度',async()=>{
 for(const [url,response] of [
  ['/api/login',Response.json({ok:false,msg:'登录尝试过多'},{status:429,headers:{'Retry-After':'60'}})],
  ['/api/devices',Response.json({ok:false,msg:'服务端要求等待'},{status:429,headers:{'Retry-After':'7200'}})],
  ['/api/devices',htmlResponse(page.replace('1027','1015'))],
  ['/api/devices',htmlResponse(page.replace('1027','10270'))],
  ['/api/devices',htmlResponse(page.replace('Cloudflare','Other service'))],
  ['https://other.test/api/devices',htmlResponse()],
  ['/help',htmlResponse()],
  ['/api/devices',htmlResponse(page,200)]
 ]){
  const c=browser(async()=>response),result=await c.fetch(url);assert.equal(result,response,url);
 }
});
test('401仍保持原来的会话失效语义，不伪装额度问题',async()=>{
 const c=browser(async()=>Response.json({ok:false},{status:401}));c.adminSession.accept();
 await assert.rejects(c.fetch('/api/devices'),/登录已失效/);assert.equal(c.adminSession.authenticated,false);
 const login=await c.fetch('/api/login');assert.equal(login.status,401);assert.deepEqual(await login.json(),{ok:false});
});
test('SIP读取遵守长秒数及HTTP日期Retry-After，不提前十五分钟重试',async()=>{
 const source=fs.readFileSync(new URL('./sip-client.js',import.meta.url),'utf8');
 const start=source.indexOf('var sipLoading='),end=source.indexOf('function saveAll(',start);
 for(const retry of ['7200',new Date(Date.now()+7200000).toUTCString()]){
  const context={fetch:async()=>Response.json({ok:false},{status:429,headers:{'Retry-After':retry}}),STALE:false,ST:null,renderStatus(){}};
  vm.runInNewContext(source.slice(start,end),context);await context.readSip(false);
  assert.ok(context.sipRetryAt-Date.now()>7100000);assert.ok(context.sipPollDelay()>7100000);assert.equal(context.sipPollFailures,1);
 }
});
