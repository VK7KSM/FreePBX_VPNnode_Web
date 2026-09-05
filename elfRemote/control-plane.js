export const CONTROL_PLANE_ONLINE_MS = 120000;
export const PAIR_CODE_TTL_MS = 60 * 60 * 1000;

export function isControlPlaneOnline(lastSeen, nowMs) {
  if (!lastSeen) return false;
  const t = Date.parse(lastSeen);
  if (!Number.isFinite(t)) return false;
  return (nowMs - t) <= CONTROL_PLANE_ONLINE_MS;
}

export function normalizePairCode(raw) {
  const s = String(raw || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(s)) return "";
  return s;
}

export function makePairCode(bytes) {
  const b = bytes || [];
  const n =
    ((b[0] || 0) * 65536 + (b[1] || 0) * 256 + (b[2] || 0)) % 900000;
  return String(100000 + n);
}

export function tokenSha256HexLooksValid(hex) {
  return /^[a-f0-9]{64}$/.test(String(hex || "").toLowerCase());
}
