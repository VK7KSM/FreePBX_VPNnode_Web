// 旧 Durable Object 数据找回：读取另一 Worker 的 ElfStore 转储，合并进当前存储。
// 旧记录为准；当前存储里因重新注册而产生的新设备编号，按令牌哈希映射回旧编号并改写相关键。
export const LEGACY_EXCLUDED_KEYS = new Set(['admin_auth', 'admin_user', 'admin_pass', 'panel_kv_authority', 'panel_kv_backup']);
const PUT_BATCH = 100;

function prefixOf(key) {
  const m = /^([^/:]+)[/:]/.exec(key);
  return m ? m[1] + (key[m[1].length] === ':' ? ':' : '/') : key;
}

function deviceBrief(d) {
  return {
    id: d.id, name: d.name, device_name: d.device_name, model_id: d.model_id, product_id: d.product_id,
    paired: d.paired !== false, enabled: d.enabled !== false, status_only: d.status_only === true,
    token: String(d.token_sha256 || '').slice(0, 10), identity: d.hardware_identity ? `${d.hardware_identity.variant}:${d.hardware_identity.value}` : '',
    app_version: d.app_version, last_seen: d.last_seen, last_reported_at: d.last_reported_at
  };
}

function enrollBrief(code, row) {
  return { code, device_id: row.device_id || '', device_name: row.device_name, model_hint: row.model_hint, app_version: row.app_version,
    paired: row.paired === true, token: String(row.token_sha256 || '').slice(0, 10), created_at: row.created_at, last_seen: row.last_seen, expires_at: row.expires_at };
}

export function summarizeStore(dump) {
  const keys = Object.keys(dump);
  const prefixes = {};
  let bytes = 0;
  for (const k of keys) { prefixes[prefixOf(k)] = (prefixes[prefixOf(k)] || 0) + 1; bytes += JSON.stringify(dump[k] ?? null).length; }
  const devices = Array.isArray(dump.remote_devices) ? dump.remote_devices.map(deviceBrief) : [];
  const enrolls = dump.remote_enrolls && typeof dump.remote_enrolls === 'object'
    ? Object.entries(dump.remote_enrolls).map(([c, r]) => enrollBrief(c, r || {})) : [];
  const releases = {};
  for (const k of keys) if (/^elfremote_releases/.test(k)) releases[k] = Array.isArray(dump[k]) ? dump[k].length : dump[k];
  const models = Array.isArray(dump.remote_device_models) ? dump.remote_device_models.map(m => m.id + ':' + m.name) : [];
  return { key_count: keys.length, approx_bytes: bytes, prefixes, devices, enrolls, releases, models };
}

export function planLegacyMerge(dump, currentDevices, currentEnrolls, currentKeys, now = Date.now()) {
  const oldDevices = Array.isArray(dump.remote_devices) ? dump.remote_devices : [];
  const byToken = new Map(oldDevices.filter(d => d.token_sha256).map(d => [d.token_sha256, d]));
  const mapping = [];
  const unmatched = [];
  for (const d of currentDevices || []) {
    const old = d.token_sha256 ? byToken.get(d.token_sha256) : null;
    if (old && old.id !== d.id) mapping.push({ from: d.id, to: old.id, name: old.name || old.device_name, current_name: d.name || d.device_name });
    else if (!old) unmatched.push(d);
  }
  const devices = oldDevices.concat(unmatched);
  const oldEnrolls = dump.remote_enrolls && typeof dump.remote_enrolls === 'object' ? dump.remote_enrolls : {};
  const enrolls = { ...oldEnrolls };
  const droppedEnrolls = [];
  const keptEnrolls = [];
  for (const [code, row] of Object.entries(currentEnrolls || {})) {
    if (enrolls[code]) continue;
    const expired = !row || !(Date.parse(row.expires_at) > now);
    if (expired || (row.token_sha256 && byToken.has(row.token_sha256))) { droppedEnrolls.push(enrollBrief(code, row || {})); continue; }
    enrolls[code] = row; keptEnrolls.push(enrollBrief(code, row || {}));
  }
  const ids = mapping.map(m => m.from);
  const rekeys = [];
  for (const key of currentKeys || []) {
    const hit = ids.find(id => key.includes(id));
    if (!hit) continue;
    const to = mapping.find(m => m.from === hit).to;
    const target = key.split(hit).join(to);
    rekeys.push({ from: key, to: target, id_from: hit, id_to: to, shadowed: Object.hasOwn(dump, target) });
  }
  const excluded = Object.keys(dump).filter(k => LEGACY_EXCLUDED_KEYS.has(k) || k.startsWith('auth/session/'));
  return {
    devices, enrolls, mapping, rekeys, excluded,
    summary: {
      old_devices: oldDevices.length, current_devices: (currentDevices || []).length, merged_devices: devices.length,
      mapped: mapping, unmatched_current: unmatched.map(deviceBrief),
      enrolls_old: Object.keys(oldEnrolls).length, enrolls_kept_current: keptEnrolls, enrolls_dropped_current: droppedEnrolls,
      rekeyed_keys: rekeys.length, rekey_samples: rekeys.slice(0, 20), excluded_keys: excluded,
      import_keys: Object.keys(dump).length - excluded.length
    }
  };
}

function rewriteIds(value, from, to) {
  if (value === undefined || value === null) return value;
  const text = JSON.stringify(value);
  return text.includes(from) ? JSON.parse(text.split(from).join(to)) : value;
}

async function putBatches(storage, entries) {
  for (let i = 0; i < entries.length; i += PUT_BATCH) {
    await storage.put(Object.fromEntries(entries.slice(i, i + PUT_BATCH)));
  }
}

export async function applyLegacyMerge(storage, dump, plan) {
  const entries = [];
  const skip = new Set(plan.excluded);
  for (const [k, v] of Object.entries(dump)) {
    if (skip.has(k) || k === 'remote_devices' || k === 'remote_enrolls') continue;
    entries.push([k, v]);
    if (!k.startsWith('legacy_done:')) entries.push(['legacy_done:' + k, true]);
  }
  entries.push(['remote_devices', plan.devices], ['legacy_done:remote_devices', true]);
  entries.push(['remote_enrolls', plan.enrolls], ['legacy_done:remote_enrolls', true]);
  const deletes = [];
  for (const r of plan.rekeys) {
    const value = await storage.get(r.from);
    deletes.push(r.from);
    if (r.shadowed || value === undefined) continue;
    entries.push([r.to, rewriteIds(value, r.id_from, r.id_to)]);
  }
  await putBatches(storage, entries);
  for (let i = 0; i < deletes.length; i += PUT_BATCH) await storage.delete(deletes.slice(i, i + PUT_BATCH));
  await storage.put('legacy_import', { at: new Date().toISOString(), keys: entries.length, deleted: deletes.length, mapping: plan.mapping });
  return { keys_written: entries.length, keys_deleted: deletes.length };
}

export async function currentStoreSnapshot(storage) {
  const all = await storage.list();
  return Object.fromEntries(all);
}
