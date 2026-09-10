import { pickLocation } from './remote-location.js';

const MAX_AGE = 15 * 60 * 1000;
const integer = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

export function radioRequest(radio, now = Date.now()) {
  if (!radio || !Number.isFinite(radio.sampled_at_ms) || now < radio.sampled_at_ms || now - radio.sampled_at_ms > MAX_AGE) return null;
  const payload = { considerIp: false }, seen = new Set();
  const wifi = [];
  for (const row of (Array.isArray(radio.wifiAccessPoints) ? radio.wifiAccessPoints : []).slice(0,20)) {
    const mac = String(row?.macAddress || '').toLowerCase();
    if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac) || (parseInt(mac.slice(0,2),16) & 3)
      || mac === '00:00:00:00:00:00' || mac.startsWith('00:00:5e:') || seen.has(mac)) continue;
    if (!integer(row.signalStrength,-127,-1)) continue;
    seen.add(mac); wifi.push({macAddress:mac,signalStrength:row.signalStrength});
  }
  wifi.sort((a,b)=>b.signalStrength-a.signalStrength);
  if (wifi.length >= 2) payload.wifiAccessPoints = wifi.slice(0,6);
  const radioType = radio.radioType;
  if (['gsm','wcdma','lte'].includes(radioType)) {
    const maxId = radioType === 'gsm' ? 65535 : 268435455;
    const cells = [];
    for (const row of (Array.isArray(radio.cellTowers) ? radio.cellTowers : []).slice(0,6)) {
      if (!row || !integer(row.cellId,0,maxId) || !integer(row.locationAreaCode,0,65535)
        || !integer(row.mobileCountryCode,1,999) || !integer(row.mobileNetworkCode,0,999)) continue;
      const cell = {cellId:row.cellId,locationAreaCode:row.locationAreaCode,mobileCountryCode:row.mobileCountryCode,mobileNetworkCode:row.mobileNetworkCode};
      if (integer(row.signalStrength,-150,-1)) cell.signalStrength = row.signalStrength;
      if (!cells.some(c=>c.cellId===cell.cellId&&c.locationAreaCode===cell.locationAreaCode&&c.mobileNetworkCode===cell.mobileNetworkCode)) cells.push(cell);
    }
    if (cells.length) { payload.radioType = radioType; payload.cellTowers = cells; }
  }
  return payload.wifiAccessPoints || payload.cellTowers ? payload : null;
}

async function fingerprint(payload) {
  // 相同接入点/小区的十五分钟缓存避免刷新网页或补发报告重复计费；不缓存原始无线标识。
  const shape = {wifi:(payload.wifiAccessPoints||[]).map(x=>x.macAddress).sort(),radio:payload.radioType||'',
    cells:(payload.cellTowers||[]).map(({signalStrength,...cell})=>JSON.stringify(cell)).sort()};
  const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(shape)));
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
}

// Google按结算账号汇总免费量；配置中一个id代表一个独立结算账号。
export function googleAccounts(env) {
  let rows;
  try { rows = env.GOOGLE_GEOLOCATION_ACCOUNTS ? JSON.parse(env.GOOGLE_GEOLOCATION_ACCOUNTS) : null; }
  catch { return []; }
  if (!rows) rows = env.GOOGLE_GEOLOCATION_API_KEY ? [{id:'billing-primary',key:env.GOOGLE_GEOLOCATION_API_KEY}] : [];
  if (!Array.isArray(rows)) return [];
  const ids = new Set(), keys = new Set(), accounts = [];
  for (const row of rows.slice(0,10)) {
    if (!row || !/^[a-zA-Z0-9_-]{1,50}$/.test(row.id) || typeof row.key !== 'string' || !row.key.trim()
      || ids.has(row.id) || keys.has(row.key)) continue;
    const limit = row.monthlyLimit ?? 9900;
    if (!integer(limit,1,10000)) continue;
    ids.add(row.id); keys.add(row.key); accounts.push({...row,limit});
  }
  return accounts;
}

export function googleBillingMonth(now) {
  const p = new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit'}).formatToParts(new Date(now));
  return p.find(x=>x.type==='year').value+'-'+p.find(x=>x.type==='month').value;
}

export async function googleLocation(env, deviceId, data, now = Date.now(), fetcher = (...args) => fetch(...args)) {
  // 现成有效GPS或系统网络坐标不产生Google请求。
  if (pickLocation(data,null)) return {location:null,reason:'not_needed'};
  const payload = radioRequest(data.radio,now);
  if (!payload) return {location:null,reason:'no_radio_data'};
  const accounts = googleAccounts(env);
  if (!accounts.length) return {location:null,reason:'not_configured'};
  // 使用现有DO命名空间中的单独实例串行记账；报告事务回滚或重放不能抹掉已发生的Google调用。
  if (env.ELF_DO && !env.__googleLocal) {
    try {
      const response = await env.ELF_DO.get(env.ELF_DO.idFromName('google-geolocation')).fetch('https://internal/__geolocation',{
        method:'POST',body:JSON.stringify({deviceId,radio:data.radio})});
      return response.ok ? await response.json() : {location:null,reason:'location_service_http_'+response.status};
    } catch { return {location:null,reason:'location_service_failed'}; }
  }
  const signature = await fingerprint(payload), key = 'google-geolocation/'+encodeURIComponent(deviceId);
  const cached = await env.__storage.get(key);
  if (cached?.signature === signature && now >= cached.at && now-cached.at < (cached.location ? MAX_AGE : 60000))
    return {location:cached.location,reason:cached.reason};
  let location = null, reason = 'free_limit_reached', stage = 'billing_period';
  const controller = new AbortController(), timer = setTimeout(()=>controller.abort(),4500);
  try {
   const month = googleBillingMonth(now);
   for (const account of accounts) {
    const usageKey = 'google-usage/'+account.id;
    stage='usage_read';
    let usage = await env.__storage.get(usageKey);
    if (usage?.month !== month) usage = {month,used:0,blockedUntil:0};
    if (!Number.isSafeInteger(usage.used) || usage.used < 0) { reason='usage_unavailable'; continue; }
    if (usage.used >= account.limit) continue;
    if (usage.blockedUntil > now) { reason='quota_exceeded'; continue; }
    if (controller.signal.aborted) { reason='timeout'; break; }
    // 请求发出前持久化；失败/超时也保守计数，防止重试产生意外费用。
    usage = {...usage,used:usage.used+1};
    stage='usage_write';
    await env.__storage.put(usageKey,usage);
    stage='google_request';
    const response = await fetcher('https://www.googleapis.com/geolocation/v1/geolocate?key='+encodeURIComponent(account.key),
      {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:controller.signal,redirect:'manual'});
    if (!response.ok) {
      let error;try { error=(await response.json()).error; } catch {}
      const exhausted=error?.status==='RESOURCE_EXHAUSTED'||error?.errors?.some(e=>['dailyLimitExceeded','userRateLimitExceeded','rateLimitExceeded','quotaExceeded'].includes(e.reason));
      reason = exhausted||response.status===429 ? 'quota_exceeded' : response.status===404 ? 'not_found'
        : [401,403].includes(response.status) ? 'access_denied' : 'http_'+response.status;
      if (reason==='quota_exceeded' || reason==='access_denied') {
        usage.blockedUntil = now + (reason==='access_denied' ? 3600000 : 60000);
        await env.__storage.put(usageKey,usage);
        continue;
      }
    }
    else {
      const value = await response.json(), lat = value.location?.lat, lng = value.location?.lng, accuracy = value.accuracy;
      if (typeof lat==='number' && Number.isFinite(lat) && Math.abs(lat)<=90 && typeof lng==='number' && Number.isFinite(lng) && Math.abs(lng)<=180
        && typeof accuracy==='number' && Number.isFinite(accuracy) && accuracy>0) {
        location = {lat,lng,acc_m:Math.max(1,Math.round(accuracy)),source:payload.wifiAccessPoints ? (payload.cellTowers ? 'network':'wifi'):'cell',
          provider:'google',at:new Date(data.radio.sampled_at_ms).toISOString()};
        reason='located';
      } else reason='invalid_response';
    }
    break;
   }
  } catch (error) { reason = controller.signal.aborted ? 'timeout' : /illegal invocation/i.test(String(error?.message)) ? 'fetch_binding_failed' : stage==='google_request' ? 'unavailable' : stage+'_failed'; }
  finally { clearTimeout(timer); }
  await env.__storage.put(key,{signature,at:now,location,reason});
  return {location,reason};
}
