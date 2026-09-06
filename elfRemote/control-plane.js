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
  recovered: "已恢复",
  rejected: "已拒绝"
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
  if (from === "installing" && to === "wait_health") return true;
  if (to === "rollback" && (from === "claimed" || from === "downloading"
      || from === "verifying" || from === "installing" || from === "wait_health")) {
    return true;
  }
  if (from === "wait_health" && to === "success") return true;
  if (from === "rollback" && to === "recovered") return true;
  if (to === "rejected" && (from === "claimed" || from === "downloading" || from === "verifying")) {
    return true;
  }
  return UPDATE_ADVANCE[from] === to;
}

export function shouldOfferUpdate(device, nowMs) {
  if (!device || !device.update || !device.update.job_id) return false;
  const u = device.update;
  if (u.state === "success" || u.state === "recovered" || u.state === "rejected") return false;
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

export const REPAIR_TYPES = ["pull_logs", "heal_network", "reboot", "install_apk", "restart_adbd"];

export const REPAIR_STATE_LABELS = {
  pending: "待领取",
  claimed: "已领取",
  running: "执行中",
  success: "成功",
  failed: "失败",
  expired: "已过期",
  rejected: "已拒绝"
};

export const REPAIR_TYPE_LABELS = {
  pull_logs: "拉取日志",
  heal_network: "强制自愈",
  reboot: "受控重启",
  install_apk: "覆盖安装",
  restart_adbd: "重启本机adbd"
};

export function installParamsFromRelease(rel, baseUrl) {
  if (!rel || !rel.manifest_raw) return null;
  let m;
  try { m = JSON.parse(rel.manifest_raw); } catch (e) { return null; }
  const sha = String(m.sha256 || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha)) return null;
  const name = String(rel.versionName || m.versionName || "");
  const job = String(rel.job_id || m.job_id || "");
  const url = String(baseUrl || "https://v.elfradio.net").replace(/\/$/, "")
    + "/api/elfremote/apk/" + job;
  if (!name || !job) return null;
  return {
    versionCode: Number(rel.versionCode || m.versionCode || 0),
    versionName: name,
    url,
    sha256: sha,
    size: Number(m.size || 0),
    package: String(m.package || "net.elfradio.elfremote"),
    certSha256: String(m.certSha256 || "").toLowerCase(),
    job_id: job
  };
}

const REPAIR_ADVANCE = {
  pending: ["claimed", "rejected", "expired", "failed"],
  claimed: ["running", "rejected", "expired", "failed"],
  running: ["success", "failed", "rejected"]
};

export function isAllowedRepairType(type) {
  return REPAIR_TYPES.indexOf(String(type || "")) >= 0;
}

export function repairStateLabel(state) {
  return REPAIR_STATE_LABELS[state] || "";
}

export function repairTypeLabel(type) {
  return REPAIR_TYPE_LABELS[type] || "";
}

export function repairExpired(task, nowMs) {
  if (!task) return true;
  let t = Number(task.expires_at);
  if (!Number.isFinite(t)) t = Date.parse(task.expires_at);
  return Number.isFinite(t) && nowMs >= t;
}

function repairInflight(task) {
  if (!task) return false;
  return task.state === "pending" || task.state === "claimed" || task.state === "running";
}

export function makeRepairTask(input, nowMs) {
  const src = input || {};
  const type = String(src.type || "");
  if (!isAllowedRepairType(type)) return null;
  const id = String(src.id || "").trim() || ("t" + nowMs.toString(36));
  const key = String(src.idempotency_key || "").trim() || id;
  let exp = Number(src.expires_at);
  if (!Number.isFinite(exp) || exp <= 0) exp = nowMs + 60 * 60 * 1000;
  return {
    id,
    type,
    params: src.params && typeof src.params === "object" ? src.params : {},
    expires_at: exp,
    idempotency_key: key,
    state: "pending",
    detail: ""
  };
}

export function enqueueRepairTask(device, input, nowMs) {
  if (!device) return { ok: false, reason: "missing-device" };
  const task = makeRepairTask(input || {}, nowMs);
  if (!task) return { ok: false, reason: "unknown-type" };
  if (repairExpired(task, nowMs)) return { ok: false, reason: "expired" };
  const cur = device.task;
  if (cur && String(cur.idempotency_key || "") === task.idempotency_key) {
    return { ok: true, duplicate: true, task: cur };
  }
  if (repairInflight(cur)) return { ok: false, reason: "inflight" };
  device.task = task;
  return { ok: true, duplicate: false, task };
}

export function shouldOfferRepair(device, nowMs) {
  if (!device || !device.task || !device.task.id) return false;
  const t = device.task;
  if (!isAllowedRepairType(t.type)) return false;
  if (repairExpired(t, nowMs)) return false;
  if (t.state === "success" || t.state === "failed" || t.state === "rejected" || t.state === "expired") {
    return false;
  }
  return t.state === "pending" || t.state === "claimed" || t.state === "running";
}

export function canAdvanceRepair(from, to) {
  if (!from || !to) return false;
  if (from === to) return true;
  const next = REPAIR_ADVANCE[from] || [];
  return next.indexOf(to) >= 0;
}

export function applyRepairProgress(device, taskId, state, detail, result) {
  if (!device || !device.task || device.task.id !== taskId) return device;
  if (!canAdvanceRepair(device.task.state, state)) return device;
  device.task.state = state;
  device.task.detail = detail == null ? "" : String(detail).slice(0, 200);
  if (result && typeof result === "object") {
    const sha = String(result.sha256 || "").toLowerCase();
    device.task.result = {
      sha256: /^[0-9a-f]{64}$/.test(sha) ? sha : "",
      bytes: Math.max(0, Number(result.bytes) || 0),
      truncated: !!result.truncated,
      text: String(result.text || "").slice(0, 2048),
      stage: String(result.stage || "").slice(0, 16),
      action: String(result.action || "").slice(0, 40),
      reason: String(result.reason || "").slice(0, 80)
    };
  }
  return device;
}

export function publicRepair(task) {
  if (!task) {
    return { id: "", type: "", type_label: "", state: "", label: "", detail: "", result: null };
  }
  const r = task.result || null;
  return {
    id: task.id || "",
    type: task.type || "",
    type_label: repairTypeLabel(task.type || ""),
    state: task.state || "",
    label: repairStateLabel(task.state || ""),
    detail: task.detail || "",
    expires_at: task.expires_at || 0,
    result: r ? {
      sha256: r.sha256 || "",
      bytes: r.bytes || 0,
      truncated: !!r.truncated,
      text: r.text || "",
      stage: r.stage || "",
      action: r.action || "",
      reason: r.reason || ""
    } : null
  };
}

export function repairOfferPayload(task) {
  if (!task) return null;
  return {
    id: task.id,
    type: task.type,
    params: task.params || {},
    expires_at: task.expires_at,
    idempotency_key: task.idempotency_key
  };
}
