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

export function pairCodeRequiredMessage(code) {
  return normalizePairCode(code) ? "" : "请用六位配对码添加设备";
}

export function managerAppLabel(appVersion) {
  const raw = String(appVersion || "").trim();
  if (!raw || /^elfremote$/i.test(raw)) return "elfRemote";
  const v = raw.split("-")[0].trim();
  if (!v || /^elfremote$/i.test(v)) return "elfRemote";
  return "elfRemote " + v;
}

export const UPDATE_STATE_LABELS = {
  pending: "待通知",
  claimed: "已领取",
  downloading: "下载中",
  verifying: "校验中",
  installing: "安装中",
  wait_health: "等待健康确认",
  success: "成功",
  rollback: "回滚中",
  recovered: "已恢复"
};

const UPDATE_ADVANCE = {
  pending: "claimed",
  claimed: "downloading",
  downloading: "verifying",
  verifying: "installing",
  installing: "wait_health",
  wait_health: "success"
};

export function updateStateLabel(state) {
  return UPDATE_STATE_LABELS[state] || "";
}

export function canAdvanceUpdate(from, to) {
  if (!from || !to) return false;
  if (from === to) return true;
  if (from === "wait_health" && (to === "success" || to === "rollback")) return true;
  if (from === "rollback" && to === "recovered") return true;
  return UPDATE_ADVANCE[from] === to;
}

export function shouldOfferUpdate(device, nowMs) {
  if (!device || !device.update || !device.update.job_id) return false;
  const u = device.update;
  if (u.state === "success" || u.state === "recovered") return false;
  if (u.expires_at) {
    let t = Number(u.expires_at);
    if (!Number.isFinite(t)) t = Date.parse(u.expires_at);
    if (Number.isFinite(t) && nowMs >= t) return false;
  }
  if (String(device.app_version || "") === String(u.versionName || "")) return false;
  return u.state === "pending" || u.state === "claimed";
}

export function applyUpdateProgress(device, jobId, state, detail) {
  if (!device || !device.update || device.update.job_id !== jobId) return device;
  if (!canAdvanceUpdate(device.update.state, state)) return device;
  device.update.state = state;
  device.update.detail = detail == null ? "" : String(detail).slice(0, 200);
  return device;
}
