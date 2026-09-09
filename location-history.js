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
  const content = JSON.stringify({ reported_at: reported, gps: data.gps || null, wifi: data.wifi || null,
    cell: data.cell || null, network: data.network || "unknown", battery: data.battery ?? null,
    app_version: data.app_version || "", os_version: data.os_version || "", ready: data.ready ?? null,
    status_request_id: data.status_request_id || null, ...(traffic == null ? {} : { traffic }) });
  const hash = await sha(content);
  const previous = await storage.get(dedupKey);
  if (previous) {
    if (previous.hash !== hash) throw new Error("同一上报编号的内容不一致");
    return { duplicate: true, record: await storage.get(previous.key) };
  }
  const record = { device_id: device, installation_id: installation, report_id: id, reported_at: reported, received_at: received,
    timeline_at: timeline, sample_at: timestamp(loc?.at), network: String(data.network || "unknown").slice(0,32),
    ip, ip_observed_at: received, location: loc, location_status: loc ? (loc.source === "ip" ? "ip_area" : (loc.at ? "sampled" : "sample_time_unknown")) : "unavailable",
    location_reason: String(data.location_reason || "").slice(0,120), legacy_report: !supplied, traffic };
  const key = prefix(device) + timeline + "/" + id;
  await storage.put(key, record);
  await storage.put(dedupKey, { key, hash });
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
