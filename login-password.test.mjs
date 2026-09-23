import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker from './worker-proxy.js';import {fixture,request,login} from './test-support.mjs';
import {handleKvAuth} from './admin-auth.js';

// 代理面板（s.elfradio.net）没有 DO：登录失败计数改记在边缘缓存，实例换了也不清零。
function fakeCache(){const m=new Map();return {m,
  async match(req){const v=m.get(req.url);return v?new Response(v):undefined;},
  async put(req,res){m.set(req.url,await res.text());},
  async delete(req){return m.delete(req.url);}};}
async function migrated(){
  const f=fixture({admin_pass:'fixture-password',remote_devices:[]});
  const values=new Map();f.env.SUB_STORE_KV={async get(k,o){const r=values.get(k);return r===undefined?null:o?.type==='json'?JSON.parse(r):r;},async put(k,v){values.set(k,v);},async delete(k){values.delete(k);}};
  const cookie=await login(f);
  assert.equal((await worker.fetch(request('/api/admin/prepare-kv','POST',{},cookie),f.env)).status,200);
  f.env.PANEL_KV_ENABLED='1';return f;
}
test('没有 DO 时登录失败计数记在边缘缓存：换一个实例（新的内存）照样锁，窗口 15 分钟', async () => {
  const f=await migrated(),cache=fakeCache();
  const env={...f.env,__loginCache:cache};delete env.ELF_DO;
  const wrong=()=>request('/api/login','POST',{username:'admin',password:'wrong'},undefined,{'CF-Connecting-IP':'203.0.113.9'});
  const t0=Date.now();
  for(let i=0;i<8;i++)assert.equal((await handleKvAuth(env,wrong(),'login',undefined,t0)).status,401);
  assert.equal(cache.m.size,1,'计数落在缓存里');
  // 模拟实例回收：内存计数用的是另一个 KV 对象，缓存还是同一个
  const fresh={...env,SUB_STORE_KV:{...env.SUB_STORE_KV}};
  const blocked=await handleKvAuth(fresh,wrong(),'login',undefined,t0+60000);
  assert.equal(blocked.status,429);assert.equal(blocked.headers.get('Retry-After'),'900');
  const right=()=>request('/api/login','POST',{username:'admin',password:'fixture-password'},undefined,{'CF-Connecting-IP':'203.0.113.9'});
  assert.equal((await handleKvAuth(fresh,right(),'login',undefined,t0+60000)).status,429,'锁住期间正确密码也不放');
  const ok=await handleKvAuth(fresh,right(),'login',undefined,t0+15*60000+1000);
  assert.equal(ok.status,200,'窗口过了恢复：'+await ok.clone().text());
});
test('缓存不可用时不放开：退回实例内计数', async () => {
  const f=await migrated();
  const broken={async match(){throw Error('x');},async put(){throw Error('x');},async delete(){throw Error('x');}};
  const env={...f.env,__loginCache:broken};delete env.ELF_DO;
  // 缓存读写全失败时每次都读不到计数——这里只要求不抛异常、照常回 401，不会因缓存故障把登录弄坏
  const r=await handleKvAuth(env,request('/api/login','POST',{username:'admin',password:'wrong'}),'login');
  assert.equal(r.status,401);
});

test('改密码：新密码少于 12 位服务端拒绝，不改', async () => {
  const f=fixture({admin_pass:'fixture-password'});const cookie=await login(f);
  const r=await worker.fetch(request('/api/save','POST',{current_password:'fixture-password',new_password:'short'},cookie),f.env);
  assert.equal(r.status,400);assert.match((await r.json()).msg,/至少 12 位/);
  assert.equal((await worker.fetch(request('/api/login','POST',{username:'admin',password:'fixture-password'}),f.env)).status,200,'旧密码仍有效');
});

test('代理面板的改密码表单要当前密码、再输一次，且失败时不改页面显示', () => {
  const src=fs.readFileSync(new URL('./proxy-panel.js',import.meta.url),'utf8');
  assert.match(src,/id="sCur"/);assert.match(src,/id="sPass2"/);
  assert.match(src,/payload\.current_password=\$\("sCur"\)\.value/);
  assert.match(src,/三个面板共用这一个账号/);
  const save=src.slice(src.indexOf("'function saveSettings(){'"),src.indexOf("'function copyMihomo"));
  assert.ok(save.indexOf('D.cf_ip = payload.cf_ip')>save.indexOf('if(!d.ok) throw'),'服务端确认成功后才改本地数据');
});
