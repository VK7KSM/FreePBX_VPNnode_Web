// MCP 操作员令牌：agent 向服务器证明自己有权操作**某一台**设备。
//
// 方向与设备令牌相反——设备令牌是设备证明自己是谁（token_sha256，设备 → 服务器），
// 这里是 agent 证明自己有权（agent → 服务器）。
//
// 一个令牌只对应一台设备。这样工具签名里根本不需要 device_id 参数，
// 设备由令牌决定，模型不可能传错设备；泄露一个令牌也只丢一台。
//
// 权威数据在 Durable Object 存储里，由调用方在 blockConcurrencyWhile/transaction 内串行调用；
// 不写 KV——KV 免费额度每天只有 1000 次写入，而使用计数的写入上界是 1440/天。
const enc=new TextEncoder();
const tokenKey=h=>'mcp/token/'+h, indexKey=d=>'mcp/index/'+d;

export const TTL_PRESETS=Object.freeze({'1h':3600000,'12h':43200000,'1d':86400000,'7d':604800000});
export const DEFAULT_TTL='12h';
// 有效期刻意做得短：这是操作硬件，不是操作程序，过期重新创建。
export const MAX_TTL_MS=TTL_PRESETS['7d'];
export const MAX_PER_DEVICE=8;

// 勾选框上的全部权限。「不提供」的那些（媒体、丢失模式、擦除、轨迹历史）根本不在这里，
// 不是默认不勾——要用就人去网页上点。媒体一项另有计划文档的明确约束。
export const SCOPES=Object.freeze([
  {id:'device_info', label:'读取设备状态', default:true},
  {id:'run',         label:'执行 root 命令', default:true},
  {id:'pull_logs',   label:'拉取日志', default:true},
  {id:'task_status', label:'查看任务与结果', default:true},
  {id:'releases',    label:'列出可用版本', default:true},
  {id:'install',     label:'下发更新 / 安装 APK', default:true},
  {id:'files',       label:'文件管理', default:false},
  {id:'system_config',label:'系统配置', default:false}
]);
export const SCOPE_IDS=Object.freeze(SCOPES.map(s=>s.id));
export const DEFAULT_SCOPES=Object.freeze(SCOPES.filter(s=>s.default).map(s=>s.id));

// 计数落盘：满这么久或攒够这么多次就写一次。
// 只按时间的话，DO 内存状态被回收时那一批计数会白丢；只按次数的话，零星调用永远不落盘。
export const USAGE_FLUSH_MS=60000;
export const USAGE_FLUSH_CALLS=20;

function hex(bytes){return Array.from(new Uint8Array(bytes),n=>n.toString(16).padStart(2,'0')).join('');}
export function newSecret(){return hex(crypto.getRandomValues(new Uint8Array(32)));}
export async function tokenHash(secret){return hex(await crypto.subtle.digest('SHA-256',enc.encode(secret)));}
/** 明文只在创建那一刻存在；此后一律按哈希查找，所以不需要遍历比较，也就不需要防时序攻击。 */
export function normalizeSecret(raw){const t=String(raw||'').trim();return /^[0-9a-f]{64}$/.test(t)?t:null;}

export function ttlFromInput(value){
  const key=value===undefined||value===null||value===''?DEFAULT_TTL:String(value);
  if(!Object.hasOwn(TTL_PRESETS,key))throw Error('有效期无效');
  return TTL_PRESETS[key];
}
export function scopesFromInput(value){
  if(value===undefined||value===null)return [...DEFAULT_SCOPES];
  if(!Array.isArray(value))throw Error('权限格式错误');
  const picked=[...new Set(value.map(v=>String(v)))];
  for(const id of picked)if(!SCOPE_IDS.includes(id))throw Error('未知权限：'+id);
  if(!picked.length)throw Error('至少要勾选一项权限');
  return SCOPE_IDS.filter(id=>picked.includes(id));   // 固定顺序，便于比对与显示
}
export function normalizeName(raw,fallback){
  const name=String(raw||'').trim().replace(/\s+/g,' ');
  if(!name)return fallback;
  if(name.length>48)throw Error('名称过长');
  return name;
}
/** MCP 客户端里的服务器名：只留字母数字与连字符，避免配置里出现要转义的字符。 */
export function serverName(deviceName){
  const slug=String(deviceName||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
  return 'elfremote'+(slug?'-'+slug:'');
}

export function tokenActive(record,now){
  return !!record&&!record.revoked_at&&Number(record.expires_at)>now;
}
export function publicToken(record,now){
  return {id:record.id,name:record.name,scopes:record.scopes,created_at:record.created_at,
    expires_at:record.expires_at,remaining_ms:Math.max(0,record.expires_at-now),
    last_used_at:record.last_used_at||null,calls:record.calls||0,
    source:record.source,link_token:record.link_token||null};
}

/** 列出某台设备仍然有效的令牌，顺带把过期的从索引里摘掉。 */
export async function listTokens(storage,deviceId,now=Date.now()){
  const index=(await storage.get(indexKey(deviceId)))||[];
  const out=[],keep=[];
  for(const h of index){
    const record=await storage.get(tokenKey(h));
    if(tokenActive(record,now)){out.push(publicToken(record,now));keep.push(h);}
    else if(record)await storage.delete(tokenKey(h));
  }
  if(keep.length!==index.length)await storage.put(indexKey(deviceId),keep);
  out.sort((a,b)=>b.created_at-a.created_at);
  return out;
}

/**
 * 建一个令牌。返回的 secret 是**唯一一次**能拿到明文的机会，调用方原样回给网页后即丢弃。
 * source 为 'share' 时必须带 link_token：删除那条分享链接时要连带吊销。
 */
export async function createToken(storage,{deviceId,deviceName,name,ttl,scopes,source='admin',link_token=null},now=Date.now()){
  if(!deviceId)throw Error('设备编号无效');
  if(source==='share'&&!link_token)throw Error('缺少来源链接');
  const live=await listTokens(storage,deviceId,now);
  if(live.length>=MAX_PER_DEVICE)throw Error('该设备的令牌已达上限，请先删除不用的');
  const secret=newSecret(),hash=await tokenHash(secret);
  const record={id:'mcp_'+hash.slice(0,16),device_id:deviceId,token_sha256:hash,
    name:normalizeName(name,serverName(deviceName)),scopes:scopesFromInput(scopes),
    created_at:now,expires_at:now+ttlFromInput(ttl),source,link_token,
    last_used_at:null,calls:0};
  const index=(await storage.get(indexKey(deviceId)))||[];
  await storage.put(tokenKey(hash),record);
  await storage.put(indexKey(deviceId),[...index.filter(h=>h!==hash),hash]);
  return {secret,token:publicToken(record,now),server_name:serverName(deviceName)};
}

export async function revokeToken(storage,deviceId,id,now=Date.now()){
  const index=(await storage.get(indexKey(deviceId)))||[];
  for(const h of index){
    const record=await storage.get(tokenKey(h));
    if(!record||record.id!==id)continue;
    await storage.delete(tokenKey(h));
    await storage.put(indexKey(deviceId),index.filter(x=>x!==h));
    return true;
  }
  return false;
}

/**
 * 删除分享链接时连带吊销由它生成的令牌。
 * 不是「有效期跟着链接走」——链接给人用、令牌给 agent 用，本就是两码事；
 * 但收回访问时必须一起收回，否则链接没了钥匙还在。
 */
export async function revokeByLink(storage,deviceId,linkToken){
  const index=(await storage.get(indexKey(deviceId)))||[];
  const keep=[];let removed=0;
  for(const h of index){
    const record=await storage.get(tokenKey(h));
    if(record&&record.link_token===linkToken){await storage.delete(tokenKey(h));removed++;}
    else if(record)keep.push(h);
  }
  if(removed)await storage.put(indexKey(deviceId),keep);
  return removed;
}

/** 认证：返回记录，或抛出给 agent 看得懂的理由。 */
export async function authenticate(storage,secret,now=Date.now()){
  const clean=normalizeSecret(secret);
  if(!clean)throw Object.assign(Error('令牌格式无效'),{status:401});
  const record=await storage.get(tokenKey(await tokenHash(clean)));
  if(!record)throw Object.assign(Error('令牌无效或已被删除，请在设备管理页重新生成'),{status:401});
  if(!tokenActive(record,now))throw Object.assign(Error('令牌已过期，请在设备管理页重新生成'),{status:401});
  return record;
}
export function allows(record,scope){return Array.isArray(record?.scopes)&&record.scopes.includes(scope);}

/**
 * 记一次使用。攒在内存里，满 USAGE_FLUSH_MS 或 USAGE_FLUSH_CALLS 才落盘一次。
 * pending 由调用方持有（DO 实例内存），返回 true 表示这次需要写盘。
 */
export function noteUsage(pending,hash,now){
  const entry=pending.get(hash)||{calls:0,since:now};
  entry.calls++;entry.last=now;
  pending.set(hash,entry);
  return entry.calls>=USAGE_FLUSH_CALLS||now-entry.since>=USAGE_FLUSH_MS;
}
export async function flushUsage(storage,pending,hash){
  const entry=pending.get(hash);
  if(!entry)return false;
  pending.delete(hash);
  const record=await storage.get(tokenKey(hash));
  if(!record)return false;
  record.calls=(record.calls||0)+entry.calls;
  record.last_used_at=entry.last;
  await storage.put(tokenKey(hash),record);
  return true;
}

// ── 会话：一个令牌同时只让一个 agent 连着 ──────────────────────────────
//
// 两个 agent 拿同一个令牌操作同一台设备，会互相覆盖对方的任务槽、抢对方的结果，
// 现场表现是命令莫名其妙丢失。MCP 的 Streamable HTTP 本身是一问一答、没有长连接，
// 所以「连着」用会话来表达：initialize 时领一个会话编号，之后每次请求都要带上它。
//
// 会话只存在于内存里（与 ADB/媒体会话一致）。进程回收时会话随之消失，
// 表现为「锁自己开了」——宁可这样，也不要让一个崩掉的 agent 把令牌锁死到过期。
export const SESSION_IDLE_MS=900000;

export function pruneSessions(sessions,now){
  for(const [hash,s] of sessions)if(now-s.last>=SESSION_IDLE_MS)sessions.delete(hash);
}
export function activeSession(sessions,hash,now){
  pruneSessions(sessions,now);
  return sessions.get(hash)||null;
}
/** initialize：没人占就领走；已被别的 agent 占着就明确拒绝，不抢。 */
export function claimSession(sessions,record,requested,now=Date.now()){
  const hash=record.token_sha256;
  const current=activeSession(sessions,hash,now);
  if(current&&current.id!==requested)
    throw Object.assign(Error('这个令牌正被另一个 agent 使用（自 '+new Date(current.started).toISOString()
      +'）。同一个令牌同时只允许一个 agent，请换一个令牌，或在设备管理页的 MCP 弹窗里断开它。'),{status:409});
  const session=current||{id:crypto.randomUUID(),device_id:record.device_id,
    name:record.name,started:now,last:now};
  session.last=now;
  sessions.set(hash,session);
  return {session,resumed:!!current};
}
/**
 * 后续请求：必须带着自己那个会话编号。带错或没带，都说明是另一个 agent。
 *
 * 没带编号且当前也没有会话时放行，是留给不握手的简单脚本用的。
 * 但**带了编号却没有会话**不能放行——那说明这个会话已经被面板断开或超时清掉了，
 * 放行等于「断开连接」按钮按了个寂寞，原来那个 agent 照样能接着操作设备。
 */
export function touchSession(sessions,record,requested,now=Date.now()){
  const hash=record.token_sha256;
  const current=activeSession(sessions,hash,now);
  if(!current){
    if(requested)throw Object.assign(Error('这个会话已被断开或超时失效，请重新 initialize。'),{status:404});
    return null;                                // 从未握手的简单客户端，放行
  }
  if(current.id!==requested)
    throw Object.assign(Error('这个令牌正被另一个 agent 使用，或你的会话已超时失效，请重新 initialize。'),{status:404});
  current.last=now;
  return current;
}
export function releaseSession(sessions,record,requested,now=Date.now()){
  const current=activeSession(sessions,record.token_sha256,now);
  if(!current||(requested&&current.id!==requested))return false;
  sessions.delete(record.token_sha256);
  return true;
}
/** 面板用：这台设备上有没有 agent 连着。 */
export function deviceSession(sessions,deviceId,now=Date.now()){
  pruneSessions(sessions,now);
  for(const s of sessions.values())
    if(s.device_id===deviceId)return {name:s.name,started:s.started,last:s.last};
  return null;
}
/** 面板断开：按设备清掉所有会话，用于 agent 崩掉后立刻放行。 */
export function releaseDevice(sessions,deviceId){
  let removed=0;
  for(const [hash,s] of sessions)if(s.device_id===deviceId){sessions.delete(hash);removed++;}
  return removed;
}
