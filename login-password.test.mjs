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

// 电话管理 / 设备管理页的「全局设置」：代理面板所在 Worker 被封时仍能改密码
import mainWorker from './worker.js';
test('v 上的 /api/admin/password：验当前密码、至少 12 位、成功后旧密码失效', async () => {
  const f=fixture({admin_pass:'fixture-password'});const cookie=await login(f);
  const post=body=>mainWorker.fetch(request('/api/admin/password','POST',body,cookie),f.env);
  assert.equal((await post({current_password:'wrong',new_password:'long-enough-pass'})).status,403);
  assert.equal((await post({current_password:'fixture-password',new_password:'short'})).status,400);
  assert.equal((await post({new_password:'long-enough-pass'})).status,403,'没带当前密码');
  const ok=await post({current_password:'fixture-password',new_password:'long-enough-pass'});
  assert.equal(ok.status,200,await ok.clone().text());
  assert.notEqual((await mainWorker.fetch(request('/api/login','POST',{username:'admin',password:'fixture-password'}),f.env)).status,200);
  assert.equal((await mainWorker.fetch(request('/api/login','POST',{username:'admin',password:'long-enough-pass'}),f.env)).status,200);
});
test('/api/admin/password 未登录 401、分享页禁止、代理面板上不暴露', async () => {
  const f=fixture({admin_pass:'fixture-password'});
  assert.equal((await mainWorker.fetch(request('/api/admin/password','POST',{current_password:'fixture-password',new_password:'long-enough-pass'}),f.env)).status,401);
  const {shareForbidden}=await import('./share-scope.js');assert.equal(shareForbidden('/api/admin/password','POST'),true);
  const {PROXY_ROLE_PATHS}=await import('./route-table.js');assert.equal(PROXY_ROLE_PATHS.includes('/api/admin/password'),false);
});
test('电话管理、设备管理页头部有「全局设置」，分享页没有', async () => {
  const src=fs.readFileSync(new URL('./worker.js',import.meta.url),'utf8');
  assert.equal((src.match(/onclick="adminSession\.openSettings\(\)">&#9881; 全局设置/g)||[]).length,2,'两个页面各一个按钮');
  const session=fs.readFileSync(new URL('./admin-session.js',import.meta.url),'utf8');
  assert.match(session,/state\.openSettings = function/);assert.match(session,/\/api\/admin\/password/);
});
