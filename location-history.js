import { normalizeTraffic } from "./traffic.js";

function timestamp(value, fallback = null) {
  if (value == null || value === "") return fallback;
  const at = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(at)) throw new Error("时间字段无效");
  return new Date(at).toISOString();
}
async function sha(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}
function prefix(device) { return "history/" + encodeURIComponent(device) + "/"; }

export function normalizeReportEvent(value) {
  if(value==null)return null;
  if(value.type==='movement'){
    if(!Number.isInteger(value.distance_m)||value.distance_m<=3000||value.distance_m>21000000)throw new Error('位移事件无效');
    const at=timestamp(value.at);if(!at)throw new Error('位移事件缺少时间');
    return {type:'movement',distance_m:value.distance_m,at};
  }
  if(value.type!=="low_battery"||!Number.isInteger(value.level)||value.level<0||value.level>100
    ||!Array.isArray(value.thresholds)||!value.thresholds.length||value.thresholds.length>3
    ||value.thresholds.some(t=>![10,5,2].includes(t)||value.level>=t)
    ||new Set(value.thresholds).size!==value.thresholds.length)throw new Error("低电量事件无效");
  const at=timestamp(value.at);if(!at)throw new Error("低电量事件缺少时间");
  return {type:"low_battery",thresholds:[...value.thresholds].sort((a,b)=>b-a),level:value.level,at};
}

export async function appendLocationHistory(storage, device, data, ip, loc, now = Date.now(), installation = null) {
  const supplied = data.report_id;
  if (supplied != null && (typeof supplied !== "string" || !/^[a-zA-Z0-9_.:-]{1,96}$/.test(supplied))) throw new Error("上报编号无效");
  const id = supplied || crypto.randomUUID();
  const reported = timestamp(data.reported_at);
  const received = new Date(now).toISOString();
  // 原始设备时间照常保留；错误的未来时钟不能冻结最新状态或把历史送到未来。
  const timeline = reported && reported <= received ? reported : received;
  const dedupKey = "history-id/" + encodeURIComponent(device) + "/" + id;
  const traffic = normalizeTraffic(data.traffic);
  const event=normalizeReportEvent(data.report_event);
  const content = JSON.stringify({ reported_at: reported, gps: data.gps || null, wifi: data.wifi || null,
    cell: data.cell || null, network: data.network || "unknown", battery: data.battery ?? null,
    charging: typeof data.charging === "boolean" ? data.charging : null, battery_present: typeof data.battery_present === "boolean" ? data.battery_present : null,
    app_version: data.app_version || "", os_version: data.os_version || "", ready: data.ready ?? null,
    status_request_id: data.status_request_id || null, ...(data.radio ? {radio:data.radio} : {}), ...(traffic == null ? {} : { traffic }),...(event?{report_event:event}:{}) });
  const hash = await sha(content);
  const previous = await storage.get(dedupKey);
  if (previous) {
    let expected = hash;
    // 旧去重合同没有充电字段；升级不能拒绝客户端队列中的原报告重试。
    if (previous.hash_version !== 2) {
      const legacy = JSON.parse(content); delete legacy.charging; delete legacy.battery_present;
      expected = await sha(JSON.stringify(legacy));
    }
    if (previous.hash !== expected) throw new Error("同一上报编号的内容不一致");
    return { duplicate: true, record: await storage.get(previous.key) };
  }
  const record = { device_id: device, installation_id: installation, report_id: id, reported_at: reported, received_at: received,
    report_reason: event?.type || String(data.report_reason || (data.status_request_id ? "requested" : "unknown")).slice(0,40),
    timeline_at: timeline, sample_at: timestamp(loc?.at), network: String(data.network || "unknown").slice(0,32),
    battery: data.battery!=null&&Number.isFinite(Number(data.battery))?Math.max(0,Math.min(100,Math.round(Number(data.battery)))):null,
    charging:typeof data.charging==='boolean'?data.charging:null,battery_present:typeof data.battery_present==='boolean'?data.battery_present:null,
    report_interval_ms:data.network==='wifi'||data.network==='ethernet'?900000:3600000,
    ip, ip_observed_at: received, location: loc, location_status: loc ? (loc.source === "ip" ? "ip_area" : (loc.at ? "sampled" : "sample_time_unknown")) : "unavailable",
    location_reason: String(data.location_reason || "").slice(0,120), ...(data.network_location_reason ? {network_location_reason:String(data.network_location_reason).slice(0,40)} : {}), legacy_report: !supplied, traffic,...(event?{report_event:event}:{}) };
  const key = prefix(device) + timeline + "/" + id;
  await storage.put(key, record);
  await storage.put(dedupKey, { key, hash, hash_version: 2 });
  return { duplicate: false, record };
}

export async function queryLocationHistory(storage, url) {
  const p = url.searchParams;
  const device = p.get("device_id");
  if (!device || device.length > 128) throw new Error("缺少有效设备编号");
  const start = timestamp(p.get("from"), "1970-01-01T00:00:00.000Z");
  const end = timestamp(p.get("to"), new Date().toISOString());
  if (start > end) throw new Error("时间范围无效");
  const limit = p.has("limit") ? Number(p.get("limit")) : 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("每页记录数须为 1 至 500");
  const base = prefix(device);
  const cursor = p.get("cursor");
  if (cursor && (!cursor.startsWith(base) || cursor < base + start || cursor >= base + end + "~")) throw new Error("分页位置无效");
  const entries = await storage.list({ prefix: base, ...(cursor ? { startAfter: cursor } : { start: base + start }), end: base + end + "~", limit: limit + 1 });
  const rows = [...entries];
  const page = rows.slice(0,limit);
  return { ok: true, records: page.map(([,value]) => value), next_cursor: rows.length > limit ? page.at(-1)[0] : null };
}
