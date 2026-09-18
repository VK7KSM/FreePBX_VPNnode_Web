// 单设备分享管理：链接记录、免密/密码登录、单设备唯一独立会话（新登录踢旧）、退出与撤销。
// 权威数据全部在 Durable Object 存储里，由调用方在 blockConcurrencyWhile/transaction 内串行调用；不写 KV。
// 链接：https://<host>/m/<12 位大写字母数字>，字母表去掉 0/O/1/I，60 位随机量，二维码走字母数字模式。
export const SHARE_COOKIE='elf_share';
export const TOKEN_ALPHABET='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const TOKEN_LENGTH=12;
export const DEFAULT_TTL_MS=3600000;
export const TTL_PRESETS=Object.freeze({'1h':3600000,'6h':21600000,'1d':86400000,'7d':604800000,'30d':2592000000,permanent:null});
export const MIN_TTL_MS=3600000;
export const SESSION_LEASE_MS=180000;
export const LEASE_WRITE_INTERVAL_MS=60000;
const ITERATIONS=100000;
const enc=new TextEncoder();

function hex(bytes){return Array.from(new Uint8Array(bytes),n=>n.toString(16).padStart(2,'0')).join('');}
function randomHex(){return hex(crypto.getRandomValues(new Uint8Array(32)));}
async function digest(value){return hex(await crypto.subtle.digest('SHA-256',enc.encode(value)));}
async function passwordHash(password,salt){
  const key=await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveBits']);
  return hex(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:enc.encode(salt),iterations:ITERATIONS},key,256));
}
function equal(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;}
export function newLinkToken(){
  const bytes=crypto.getRandomValues(new Uint8Array(TOKEN_LENGTH));let out='';
  for(const b of bytes)out+=TOKEN_ALPHABET[b%32];
  return out;
}
export function normalizeToken(raw){
  const t=String(raw||'').trim().toUpperCase();
  return t.length===TOKEN_LENGTH&&[...t].every(c=>TOKEN_ALPHABET.includes(c))?t:null;
}
export function shareCookie(value,ageSeconds){return `${SHARE_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${ageSeconds}`;}
export function shareCookieToken(request){const t=(request.headers.get('Cookie')||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(SHARE_COOKIE+'='))?.slice(SHARE_COOKIE.length+1)||'';return /^[a-f0-9]{64}$/.test(t)?t:'';}
export function shareUrl(origin,token){return origin.replace(/\/$/,'')+'/m/'+token;}
export function ttlFromInput(value){
  if(value===undefined||value===null||value==='')return DEFAULT_TTL_MS;
  if(value==='permanent')return null;
  if(Object.hasOwn(TTL_PRESETS,value))return TTL_PRESETS[value];
  const ms=Number(value);
  if(!Number.isFinite(ms)||ms<MIN_TTL_MS||ms>3153600000000)throw Error('有效期无效（至少一小时）');
  return Math.floor(ms);
}
const linkKey=t=>'share/link/'+t, deviceKey=d=>'share/device/'+d, sessionKey=h=>'share/session/'+h, indexKey=d=>'share/index/'+d, requestKey=(d,r)=>'share/request/'+d+'/'+r, failKey=t=>'share/fail/'+t;

export function linkActive(link,now){return !!link&&!link.revoked_at&&(link.expires_at===null||link.expires_at>now);}
export function publicLink(link,now,current){
  return {token:link.token,created_at:link.created_at,expires_at:link.expires_at,has_password:!!link.password,source:link.source,
    remaining_ms:link.expires_at===null?null:Math.max(0,link.expires_at-now),current:!!current&&current.link_token===link.token};
}

export async function createLink(storage,{deviceId,ttlMs=DEFAULT_TTL_MS,password=null,source='admin',requestId=null},now=Date.now()){
  if(!deviceId)throw Error('设备编号无效');
  if(requestId){const prior=await storage.get(requestKey(deviceId,requestId));if(prior){const link=await storage.get(linkKey(prior));if(linkActive(link,now))return {link,duplicate:true};}}
  const index=(await storage.get(indexKey(deviceId)))||[];
  const alive=[];for(const t of index){const l=await storage.get(linkKey(t));if(linkActive(l,now))alive.push(t);}
  if(alive.length>=20)throw Error('本设备有效链接过多，请先删除旧链接');
  let token;do{token=newLinkToken();}while(await storage.get(linkKey(token)));
  const link={token,device_id:deviceId,created_at:now,expires_at:ttlMs===null?null:now+ttlMs,password:null,revoked_at:null,revision:randomHex().slice(0,16),source};
  if(password){if(typeof password!=='string'||!password||password.length>1024)throw Error('密码长度无效');const salt=randomHex();link.password={salt,hash:await passwordHash(password,salt)};}
  await storage.put(linkKey(token),link);
  await storage.put(indexKey(deviceId),[...alive,token]);
  if(requestId)await storage.put(requestKey(deviceId,requestId),token);
  return {link,duplicate:false};
}

export async function listLinks(storage,deviceId,now=Date.now()){
  const index=(await storage.get(indexKey(deviceId)))||[];const links=[];const keep=[];
  for(const t of index){const l=await storage.get(linkKey(t));if(linkActive(l,now)){links.push(l);keep.push(t);}}
  if(keep.length!==index.length)await storage.put(indexKey(deviceId),keep);
  const current=await currentSession(storage,deviceId,now);
  return {links:links.map(l=>publicLink(l,now,current)),session:current?{session_id:current.session_id,link_token:current.link_token,login_at:current.login_at,entry:current.entry,online:current.lease_until>now}:null};
}

async function currentSession(storage,deviceId,now){
  const s=await storage.get(deviceKey(deviceId));
  if(!s)return null;
  const link=await storage.get(linkKey(s.link_token));
  if(!linkActive(link,now)||link.revision!==s.link_revision){await clearSession(storage,s);return null;}
  return s;
}
async function clearSession(storage,s){await storage.delete([deviceKey(s.device_id),sessionKey(s.session_hash)]);}

/** 登录：链接与密码校验通过后原子替换本设备唯一独立会话。失败不影响现有会话。 */
export async function login(storage,{token:raw,password,peer='local'},now=Date.now()){
  const token=normalizeToken(raw);if(!token)return {ok:false,status:404,msg:'链接无效'};
  const link=await storage.get(linkKey(token));
  if(!linkActive(link,now))return {ok:false,status:404,msg:'链接不存在或已失效'};
  if(link.password){
    const failures=((await storage.get(failKey(token)))||[]).filter(f=>f.until>now);
    const bucket=failures.find(f=>f.peer===peer);
    if(bucket&&bucket.count>=8)return {ok:false,status:429,msg:'密码错误次数过多，请稍后重试'};
    const given=typeof password==='string'?password:'';
    if(!given||!equal(await passwordHash(given,link.password.salt),link.password.hash)){
      if(bucket)bucket.count++;else failures.push({peer,count:1,until:now+60000});
      await storage.put(failKey(token),failures.slice(-64));
      return {ok:false,status:401,msg:given?'密码错误':'此链接需要密码',needs_password:true};
    }
    if(failures.length)await storage.delete(failKey(token));
  }
  const old=await storage.get(deviceKey(link.device_id));
  const cookieValue=randomHex(),session_hash=await digest(cookieValue),generation=(old?.generation||0)+1;
  const session={device_id:link.device_id,session_id:randomHex().slice(0,16),session_hash,generation,link_token:token,link_revision:link.revision,login_at:now,lease_until:now+SESSION_LEASE_MS,lease_written:now,entry:'link'};
  await storage.put(deviceKey(link.device_id),session);
  await storage.put(sessionKey(session_hash),{device_id:link.device_id,generation});
  if(old)await storage.delete(sessionKey(old.session_hash));
  return {ok:true,cookie:cookieValue,device_id:link.device_id,session_id:session.session_id,generation,kicked:old?{session_id:old.session_id,generation:old.generation}:null,needs_password:false};
}

/** 校验分享 Cookie：必须是本设备当前会话且链接仍有效；有效时低频续租约。 */
export async function validate(storage,cookieValue,now=Date.now()){
  if(!/^[a-f0-9]{64}$/.test(cookieValue||''))return null;
  const hash=await digest(cookieValue);
  const ref=await storage.get(sessionKey(hash));if(!ref)return null;
  const s=await currentSession(storage,ref.device_id,now);
  if(!s||s.session_hash!==hash||s.generation!==ref.generation){await storage.delete(sessionKey(hash));return null;}
  if(now-s.lease_written>=LEASE_WRITE_INTERVAL_MS){s.lease_until=now+SESSION_LEASE_MS;s.lease_written=now;await storage.put(deviceKey(s.device_id),s);}
  return {kind:'share',device_id:s.device_id,session_id:s.session_id,generation:s.generation,link_token:s.link_token,login_at:s.login_at};
}

export async function logout(storage,cookieValue){
  if(!/^[a-f0-9]{64}$/.test(cookieValue||''))return false;
  const hash=await digest(cookieValue);const ref=await storage.get(sessionKey(hash));if(!ref)return false;
  const s=await storage.get(deviceKey(ref.device_id));
  if(s&&s.session_hash===hash)await storage.delete(deviceKey(ref.device_id));
  await storage.delete(sessionKey(hash));
  return true;
}

/** 修改选中链接：密码 set/clear、有效期；改的是当前会话所用链接时，当前会话原子跟随新代次，不被踢。 */
export async function updateLink(storage,{token:raw,password,ttl},ctx,now=Date.now()){
  const token=normalizeToken(raw);const link=token&&await storage.get(linkKey(token));
  if(!linkActive(link,now))throw Error('链接不存在或已失效');
  if(ctx?.kind==='share'&&link.device_id!==ctx.device_id)throw Error('不能修改其他设备的链接');
  let changed=false;
  if(password&&password.action==='set'){
    const value=password.value;if(typeof value!=='string'||!value||value.length>1024)throw Error('密码长度无效');
    const salt=randomHex();link.password={salt,hash:await passwordHash(value,salt)};link.revision=randomHex().slice(0,16);changed=true;
  }else if(password&&password.action==='clear'){link.password=null;link.revision=randomHex().slice(0,16);changed=true;}
  if(ttl!==undefined){const ms=ttlFromInput(ttl);link.expires_at=ms===null?null:now+ms;changed=true;}
  if(!changed)return publicLink(link,now,await currentSession(storage,link.device_id,now));
  await storage.put(linkKey(token),link);
  const s=await storage.get(deviceKey(link.device_id));
  if(s&&s.link_token===token){
    if(ctx?.kind==='share'&&ctx.session_id===s.session_id){s.link_revision=link.revision;await storage.put(deviceKey(link.device_id),s);}
    else if(s.link_revision!==link.revision)await clearSession(storage,s);
  }
  await storage.delete(failKey(token));
  return publicLink(link,now,await currentSession(storage,link.device_id,now));
}

/** 撤销链接：立即失效；当前会话若来自该链接则一并结束（返回 kicked），其他链接的会话不受影响。 */
export async function revokeLink(storage,raw,ctx,now=Date.now()){
  const token=normalizeToken(raw);const link=token&&await storage.get(linkKey(token));
  if(!link)return {ok:true,kicked:null};
  if(ctx?.kind==='share'&&link.device_id!==ctx.device_id)throw Error('不能删除其他设备的链接');
  link.revoked_at=now;await storage.put(linkKey(token),link);
  const index=((await storage.get(indexKey(link.device_id)))||[]).filter(t=>t!==token);await storage.put(indexKey(link.device_id),index);
  const s=await storage.get(deviceKey(link.device_id));
  let kicked=null;
  if(s&&s.link_token===token){kicked={session_id:s.session_id,generation:s.generation};await clearSession(storage,s);}
  return {ok:true,kicked};
}

/** 撤销本设备全部链接与会话（设备真实删除/停用时调用）。 */
export async function revokeDevice(storage,deviceId,now=Date.now()){
  const index=(await storage.get(indexKey(deviceId)))||[];
  for(const t of index){const l=await storage.get(linkKey(t));if(l&&!l.revoked_at){l.revoked_at=now;await storage.put(linkKey(t),l);}}
  await storage.put(indexKey(deviceId),[]);
  const s=await storage.get(deviceKey(deviceId));if(s)await clearSession(storage,s);
  return {revoked:index.length,kicked:!!s};
}

/** 总后台是否处于只读旁观：本设备有租约未到期的独立会话。 */
export async function observerLocked(storage,deviceId,now=Date.now()){
  const s=await currentSession(storage,deviceId,now);
  return !!s&&s.lease_until>now;
}
