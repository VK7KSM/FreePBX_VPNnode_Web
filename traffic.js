// 只保留应用 UID 实测计数；不将其解释为完整蜂窝账单。
export function normalizeTraffic(value) {
  if (value == null) return null;
  const invalid = () => { throw new Error("流量计量字段无效"); };
  if (typeof value !== "object" || Array.isArray(value)) return invalid();
  if (value.available === false) {
    const reasons = ["saved_state_unreadable", "uid_counter_unsupported", "counter_or_persistence_failed"];
    if (!reasons.includes(value.reason)) return invalid();
    return { available: false, reason: value.reason };
  }
  if (value.available !== true || value.scope !== "application_uid"
      || !["qtaguid_uid", "trafficstats_uid"].includes(value.source)) return invalid();
  const result = { available: true, scope: value.scope, source: value.source };
  for (const key of ["started_at_ms", "sampled_at_ms", "covered_ms", "gaps", "rx_bytes", "tx_bytes"]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) return invalid();
    result[key] = value[key];
  }
  if (!value.interfaces || typeof value.interfaces !== "object" || Array.isArray(value.interfaces)) return invalid();
  const entries = Object.entries(value.interfaces);
  if (entries.length > 32) return invalid();
  const interfaces = Object.create(null);
  let rx = 0, tx = 0;
  for (const [name, counts] of entries) {
    if (!/^[A-Za-z0-9_.:-]{1,32}$/.test(name) || !counts || typeof counts !== "object") return invalid();
    if (![counts.rx_bytes, counts.tx_bytes].every(n => Number.isSafeInteger(n) && n >= 0)) return invalid();
    interfaces[name] = { rx_bytes: counts.rx_bytes, tx_bytes: counts.tx_bytes };
    rx += counts.rx_bytes; tx += counts.tx_bytes;
  }
  if (!Number.isSafeInteger(rx) || !Number.isSafeInteger(tx) || rx !== result.rx_bytes || tx !== result.tx_bytes) return invalid();
  return { ...result, interfaces };
}
