import {kvJson,panelEnabled,putKvJson,deleteKvJson} from './panel-kv.js';
const COOKIE = "elf_admin";
const ITERATIONS = 100000;
const SESSION_MS = 14 * 86400000;
const enc = new TextEncoder();

function hex(bytes) {
  return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, "0")).join("");
}
function random() { return hex(crypto.getRandomValues(new Uint8Array(32))); }
async function digest(value) { return hex(await crypto.subtle.digest("SHA-256", enc.encode(value))); }
async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: ITERATIONS }, key, 256));
}
function equal(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function cookie(value, age) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
}
export function authJson(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra
  } });
}
export function trustedOrigin(request) {
  const origin = request.headers.get("Origin");
  return request.headers.get("Sec-Fetch-Site") !== "cross-site"
    && (!origin || origin === new URL(request.url).origin);
}
// 设备会直接请求 /api/devices/* 下的接口。路径写错或服务端还没上线时，
// 鉴权那道门会把它当成「未登录的管理员」，回一句「请先登录」——
// 这句话对站在座机前按按钮的人毫无意义，也把「接口不存在」误导成「你没登录」。
// 所以已注册的路径照常鉴权（会话过期就该说未登录），没注册的直接 404。
// 这份清单必须和 worker.js 的路由表一致，有结构化测试钉住，漏加会红。
// 2026-09-21：这份清单最初是用 pathname === "..." 的双引号写法 grep 出来的，
// 漏掉了三条单引号写法的路由（events / trajectory-media / request-status），
// 于是「设备轨迹」页的历史媒体当场变成「接口不存在」——正是本机制最怕的那种失败：
// 不报错、不失联，只是某个功能安静地没了，看起来像从来没实现过。
// 对应的结构化测试也用了同一个正则，所以一起瞎掉。测试已改为扫全部服务端文件、两种引号。
// 2026-09-23：这三样连同 share-scope 的表、PROXY_ROLE_PATHS 等一起并入 route-table.js 一张表，
// 这里只是转口，调用方不用改 import。
export { DEVICE_ROUTES, unknownDeviceRoute, isMachineRoute } from "./route-table.js";

async function jsonInput(request) {
  const text = await request.text();
  if (text.length > 8192) throw new Error("请求过大");
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求格式错误");
  return value;
}
async function legacyValue(storage, env, key) {
  const value = await storage.get(key);
  if (value !== undefined && value !== null) return value;
  const raw = await env.SUB_STORE_KV?.get(key);
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}
// 给改密码前的「核对当前口令」用：与登录同一套哈希与比较，不另起炉灶。
export async function verifyPasswordAgainst(auth, password) {
  if (typeof password !== "string" || !password || password.length > 1024) return false;
  if (!auth?.hash || !auth.salt) return false;
  return equal(await passwordHash(password, auth.salt), auth.hash);
}

export async function credentials(storage, env) {
  const existing = await storage.get("admin_auth");
  if (existing) return existing;
  // 仅迁移真实存储或显式配置，禁止重新启用代码中的默认密码。
  const username = await legacyValue(storage, env, "admin_user") || env.ADMIN_USER || "admin";
  const password = await legacyValue(storage, env, "admin_pass") || env.ADMIN_PASSWORD;
  if (typeof username !== "string" || !username || typeof password !== "string" || !password) return null;
  const salt = random();
  const result = { username, salt, hash: await passwordHash(password, salt), revision: random() };
  await storage.put("admin_auth", result);
  await storage.put("admin_user", username);
  await storage.delete("admin_pass");
  if (env.SUB_STORE_KV?.delete) await env.SUB_STORE_KV.delete("admin_pass");
  return result;
}
async function sessionKey(request) {
  const token = (request.headers.get("Cookie") || "").split(";").map(s => s.trim())
    .find(s => s.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? "auth/session/" + await digest(token) : null;
}
async function validSession(storage, request, now) {
  const key = await sessionKey(request);
  if (!key) return false;
  const [entry, auth] = await Promise.all([storage.get(key), storage.get("admin_auth")]);
  if (entry && auth && entry.expires > now && entry.revision === auth.revision) return true;
  if (entry) await storage.delete(key);
  return false;
}

// 由现有 Durable Object 串行调用，迁移、改密码与会话变更不会相互覆盖。
export async function handleAdminAuth(storage, env, request, now = Date.now()) {
  const action = new URL(request.url).pathname;
  if(panelEnabled(env))return handleKvAuth(env,request,action.slice('/__auth/'.length),undefined,now,storage);
  try {
    if (action === "/__auth/login" && request.method === "POST") {
      const body = await jsonInput(request);
      const peer = await digest(request.headers.get("CF-Connecting-IP") || "local");
      const failures = (await storage.get("auth/failures")) || [];
      const recent = failures.filter(e => e.until > now);
      const bucket = recent.find(e => e.peer === peer);
      if (bucket?.count >= LOGIN_MAX_FAILURES) return authJson({ ok: false, msg: "登录失败次数过多，请 15 分钟后再试" }, 429, { "Retry-After": "900" });
      const auth = await credentials(storage, env);
      if (!auth) return authJson({ ok: false, msg: "管理员登录尚未配置" }, 503);
      const inputOk = typeof body.username === "string" && typeof body.password === "string" && body.password.length <= 1024;
      const hash = await passwordHash(inputOk ? body.password : "", auth.salt);
      if (!inputOk || !equal(hash, auth.hash) || body.username !== auth.username) {
        if (bucket) bucket.count++;
        else recent.push({ peer, count: 1, until: now + LOGIN_WINDOW_MS });
        await storage.put("auth/failures", recent.slice(-128));
        return authJson({ ok: false, msg: "账号或密码错误" }, 401);
      }
      await storage.put("auth/failures", recent.filter(e => e.peer !== peer));
      const old = await storage.list({ prefix: "auth/session/" });
      for (const [key, value] of old) if (value.expires <= now || value.revision !== auth.revision) await storage.delete(key);
      const token = random();
      await storage.put("auth/session/" + await digest(token), { revision: auth.revision, expires: now + SESSION_MS });
      return authJson({ ok: true }, 200, { "Set-Cookie": cookie(token, SESSION_MS / 1000) });
    }
    if (action === "/__auth/logout" && request.method === "POST") {
      const key = await sessionKey(request);
      if (key) await storage.delete(key);
      return authJson({ ok: true }, 200, { "Set-Cookie": cookie("", 0) });
    }
    if (!await validSession(storage, request, now)) return authJson({ ok: false, msg: "请先登录" }, 401);
    if (action === "/__auth/password" && request.method === "POST") {
      const { password } = await jsonInput(request);
      if (typeof password !== "string" || password.length < 12 || password.length > 1024) return authJson({ ok: false, msg: "新密码至少 12 位" }, 400);
      const auth = await storage.get("admin_auth");
      const salt = random();
      await storage.put("admin_auth", { username: auth.username, salt, hash: await passwordHash(password, salt), revision: random() });
      await storage.delete("admin_pass");
      if (env.SUB_STORE_KV?.delete) await env.SUB_STORE_KV.delete("admin_pass");
      return authJson({ ok: true, credentials_changed: true }, 200, { "Set-Cookie": cookie("", 0) });
    }
    if (action === "/__auth/session" && request.method === "GET") return authJson({ ok: true });
    return authJson({ ok: false, msg: "接口不存在" }, 404);
  } catch {
    return authJson({ ok: false, msg: "登录服务请求失败" }, 400);
  }
}

export async function adminRpc(env, request, action, body) {
  if(panelEnabled(env))return handleKvAuth(env,request,action,body);
  if (!env.ELF_DO) return authJson({ ok: false, msg: "登录存储不可用" }, 503);
  const headers = new Headers(request.headers);
  headers.delete("Content-Length");
  const method = action === "session" ? "GET" : "POST";
  return env.ELF_DO.get(env.ELF_DO.idFromName("main")).fetch(new Request("https://elf-store/__auth/" + action, {
    method, headers, ...(method === "POST" ? { body: body === undefined ? await request.text() : JSON.stringify(body) } : {})
  }));
}

function cookieToken(request){return (request.headers.get('Cookie')||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(COOKIE+'='))?.slice(COOKIE.length+1)||'';}
async function mac(auth,payload){
 const key=await crypto.subtle.importKey('raw',enc.encode(auth.session_key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return hex(await crypto.subtle.sign('HMAC',key,enc.encode(payload)));
}
const attempts=new WeakMap();
// 登录失败计数。有 DO 存储就落盘（auth/failures，与 DO 登录路径同一把钥匙），实例回收也不清零；
// 没有 DO 的代理面板（s.elfradio.net）只能记在实例内存里——那里没有 DO 可落，也不写 KV：
// 每次失败写 KV 的同一个键，攻击者就能用错密码把 1000 次/日的写额度耗光。
// 窗口 15 分钟、错 8 次锁到窗口结束：每个来源每天最多试约 770 次，主人手滑输错几次不受影响。
const LOGIN_WINDOW_MS=15*60000,LOGIN_MAX_FAILURES=8;
// s.elfradio.net 没有 DO：以前只记在实例内存里，实例一换就清零，是全系统防猜密码最弱的一处。
// 改用 Cloudflare 边缘缓存（Cache API）记账：不占 KV 写额度、实例回收不清零；同一来源通常落在同一机房。
function cacheThrottle(cache,request,now){
 const keyFor=peer=>new Request(new URL('/__login-throttle/'+peer,request.url).toString());
 const read=async peer=>{try{const hit=await cache.match(keyFor(peer));const v=hit?await hit.json():null;return v&&v.until>now?v:null;}catch{return null;}};
 const write=async(peer,v)=>{try{await cache.put(keyFor(peer),new Response(JSON.stringify(v),{headers:{'Content-Type':'application/json','Cache-Control':'max-age='+Math.max(1,Math.ceil((v.until-now)/1000))}}));}catch{}};
 let current;
 return {
  load:async peer=>{current=await read(peer);},
  blocked:()=>!!current&&current.count>=LOGIN_MAX_FAILURES,
  fail:async peer=>{current=current?{...current,count:current.count+1}:{count:1,until:now+LOGIN_WINDOW_MS};await write(peer,current);},
  clear:async peer=>{if(current){try{await cache.delete(keyFor(peer));}catch{}}}
 };
}
async function loginThrottle(kv,storage,now,request,cache){
 if(!storage&&cache&&request){const t=cacheThrottle(cache,request,now);return t;}
 if(storage){
  const recent=((await storage.get('auth/failures'))||[]).filter(e=>e.until>now);
  const bucket=peer=>recent.find(e=>e.peer===peer);
  return {
   blocked:peer=>(bucket(peer)?.count||0)>=LOGIN_MAX_FAILURES,
   fail:async peer=>{const b=bucket(peer);if(b)b.count++;else recent.push({peer,count:1,until:now+LOGIN_WINDOW_MS});await storage.put('auth/failures',recent.slice(-128));},
   clear:async peer=>{if(bucket(peer))await storage.put('auth/failures',recent.filter(e=>e.peer!==peer));}
  };
 }
 let peers=attempts.get(kv);if(!peers){peers=new Map();attempts.set(kv,peers);}
 return {
  blocked:peer=>{const r=peers.get(peer);return !!r&&r.until>now&&r.count>=LOGIN_MAX_FAILURES;},
  fail:peer=>{const r=peers.get(peer);if(peers.size>=128)peers.delete(peers.keys().next().value);
   peers.set(peer,{count:r&&r.until>now?r.count+1:1,until:r&&r.until>now?r.until:now+LOGIN_WINDOW_MS});},
  clear:peer=>{peers.delete(peer);}
 };
}
export async function handleKvAuth(env,request,action,body,now=Date.now(),storage=null){
 const kv=env.SUB_STORE_KV;if(!kv)return authJson({ok:false,msg:'登录存储不可用'},503);
 try{
  const token=cookieToken(request);
  if(action!=='login'&&!/^(?:[a-f0-9]{64}|v2\.[A-Za-z0-9_-]{1,1800}\.[a-f0-9]{64})$/.test(token)){
   return action==='logout'?authJson({ok:true},200,{'Set-Cookie':cookie('',0)}):authJson({ok:false,msg:'请先登录'},401);
  }
  // 登录和改密码读最新口令；其余只是核对会话，用 60 秒的实例缓存（见 panel-kv.js AUTH_TTL）。
  const fresh=action==='login'||action==='password'||env.__authFresh===true;
  const auth=await kvJson(env,'panel/auth',{request,fresh});
  if(!auth?.hash||!auth.session_key)return authJson({ok:false,msg:'登录资料正在同步，请稍后重试'},503,{'Retry-After':'30'});
  if(action==='login'){
   const input=body===undefined?await jsonInput(request):body;
   const throttle=await loginThrottle(kv,storage,now,request,env.__loginCache||(typeof caches!=='undefined'?caches.default:null));
   const peer=await digest(request.headers.get('CF-Connecting-IP')||'local');
   if(throttle.load)await throttle.load(peer);
   if(throttle.blocked(peer))return authJson({ok:false,msg:'登录失败次数过多，请 15 分钟后再试'},429,{'Retry-After':'900'});
   const valid=typeof input.username==='string'&&typeof input.password==='string'&&input.password.length<=1024;
   const hash=await passwordHash(valid?input.password:'',auth.salt);
   if(!valid||input.username!==auth.username||!equal(hash,auth.hash)){
    await throttle.fail(peer);
    return authJson({ok:false,msg:'账号或密码错误'},401);
   }
   await throttle.clear(peer);
   const payload=btoa(JSON.stringify({id:random(),revision:auth.revision,expires:now+SESSION_MS})).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
   const value='v2.'+payload+'.'+await mac(auth,payload);
   return authJson({ok:true},200,{'Set-Cookie':cookie(value,SESSION_MS/1000)});
  }
  let entry=null;
  if(token.startsWith('v2.')&&token.length<2048){
   const parts=token.split('.');
   if(parts.length===3&&equal(await mac(auth,parts[1]),parts[2])){
    try{entry=JSON.parse(atob(parts[1].replace(/-/g,'+').replace(/_/g,'/')));}catch{}
    if(entry&&await kvJson(env,'panel/revoked/'+await digest(token),{request}))entry=null;
   }
  }else if(/^[a-f0-9]{64}$/.test(token))entry=await kvJson(env,'panel/legacy-session/'+await digest(token),{request,fresh});
  if(action==='logout'){
   if(entry?.expires>now){
    if(token.startsWith('v2.'))await putKvJson(env,'panel/revoked/'+await digest(token),true,{expirationTtl:Math.max(60,Math.ceil((entry.expires-now)/1000))});
    else await deleteKvJson(env,'panel/legacy-session/'+await digest(token));
   }
   return authJson({ok:true},200,{'Set-Cookie':cookie('',0)});
  }
  if(!entry||entry.expires<=now||entry.revision!==auth.revision){
   // 缓存里的登录资料可能比另一实例刚改的旧（例如刚改完密码、用新口令登录后第一次请求落到别的实例）：
   // 判不过时用最新资料重核一次再下结论，只在失败时多读一次 KV，不会把新会话误判成未登录。
   if(!fresh)return handleKvAuth({...env,__authFresh:true},request,action,body,now,storage);
   return authJson({ok:false,msg:'请先登录'},401);
  }
  if(action==='session')return authJson({ok:true});
  if(action==='password'){
   const input=body===undefined?await jsonInput(request):body,password=input.password;
   if(typeof password!=='string'||password.length<12||password.length>1024)return authJson({ok:false,msg:'新密码至少 12 位'},400);
   const salt=random();await putKvJson(env,'panel/auth',{...auth,salt,hash:await passwordHash(password,salt),revision:random(),session_key:random()});
   return authJson({ok:true,credentials_changed:true},200,{'Set-Cookie':cookie('',0)});
  }
  return authJson({ok:false,msg:'接口不存在'},404);
 }catch{return authJson({ok:false,msg:'登录服务暂不可用，请稍后重试'},503,{'Retry-After':'30'});}
}

export async function migratePanelAuth(storage,env,now=Date.now()){
 const auth=await credentials(storage,env);if(!auth)throw Error('当前登录资料不存在');
 const snapshot={...auth,session_key:random()};await putKvJson(env,'panel/auth',snapshot);
 let sessions=0;
 for(const [key,value] of await storage.list({prefix:'auth/session/'}))if(value.expires>now&&value.revision===auth.revision){
  await putKvJson(env,'panel/legacy-session/'+key.slice('auth/session/'.length),value,{expirationTtl:Math.max(60,Math.ceil((value.expires-now)/1000))});sessions++;
 }
 return {sessions,auth_revision:auth.revision};
}
