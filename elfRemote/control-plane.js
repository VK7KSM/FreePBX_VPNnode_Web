export const CONTROL_PLANE_ONLINE_MS = 120000;
export const PAIR_CODE_TTL_MS = 60 * 60 * 1000;

export function contactState(lastSeen, nowMs, statusOnly = false, network = "cellular") {
  const at = lastSeen ? Date.parse(lastSeen) : NaN;
  if (!Number.isFinite(at) || at > nowMs) return { state: "unknown", report_due_at: null };
  const window = statusOnly ? (network === "wifi" || network === "ethernet" ? 15 : 60) * 60 * 1000 : CONTROL_PLANE_ONLINE_MS;
  // 到期后客户端可能先采样 GPS（最多 60 秒），另留 30 秒传输余量。
  return { state: nowMs - at <= CONTROL_PLANE_ONLINE_MS ? "recent_contact"
    : nowMs - at <= window + (statusOnly ? 90000 : 0) ? "awaiting_report" : "report_overdue",
    report_due_at: new Date(at + window).toISOString() };
}

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
  const order = ["pending","claimed","downloading","verifying","installing","wait_health"];
  return order.includes(from) && order.includes(to) && order.indexOf(to) > order.indexOf(from);
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
  if (!u.managed_update_v2 && String(device.app_version || "") === String(u.versionName || "")) return false;
  return u.state === "pending" || u.state === "claimed";
}

export function applyUpdateProgress(device, jobId, state, detail, nowMs = Date.now()) {
  if (!device || !device.update || device.update.job_id !== jobId) return device;
  const active = ["pending","claimed","downloading","verifying","installing","wait_health"].includes(device.update.state);
  const healthy = state === "success" && active && ["health-ok","already-healthy"].includes(detail);
  if (!canAdvanceUpdate(device.update.state, state) && !healthy) return device;
  const u = device.update;
  const nextDetail = detail == null ? "" : String(detail).slice(0, 200);
  if (u.state !== state || u.detail !== nextDetail) {
    u.updated_at = new Date(nowMs).toISOString();
    if (["success", "recovered", "rejected"].includes(state) && !["success", "recovered", "rejected"].includes(u.state)) {
      u.completed_at = u.updated_at;
    }
  }
  u.state = state;
  u.detail = nextDetail;
  return device;
}

export const CONFIG_TYPES = ["connect_wifi","contacts_read","contact_add","contact_update","contact_delete"];
export const REPAIR_TYPES = ["file_manage", "get_file", "send_file", "root_exec", "pull_logs", "heal_network", "reboot", "install_apk", "restart_adbd", "scan_wifi", "play_alarm", "stop_alarm", "locate_now", "set_lost_mode", ...CONFIG_TYPES];

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
  root_exec: "执行命令",
  file_manage: "管理文件",
  send_file: "发送文件",
  get_file: "取回文件",
  pull_logs: "拉取日志",
  heal_network: "强制自愈",
  reboot: "受控重启",
  install_apk: "覆盖安装",
  restart_adbd: "重启本机adbd",
  scan_wifi: "扫描 Wi-Fi",
  play_alarm: "播放警报",
  stop_alarm: "停止警报",
  locate_now: "立即定位",
  set_lost_mode: "设置丢失模式",
  connect_wifi: "连接 Wi-Fi", contacts_read:"读取通信录", contact_add:"添加联系人", contact_update:"修改联系人", contact_delete:"删除号码"
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
  const id = String(src.id || "").trim() || ("t" + crypto.randomUUID().replaceAll("-", ""));
  if(["root_exec","send_file","get_file","file_manage"].includes(type) && !/^[a-zA-Z0-9-]{1,64}$/.test(id)) throw new Error("任务编号无效");
  const key = String(src.idempotency_key || "").trim() || id;
  let exp = Number(src.expires_at);
  if (!Number.isFinite(exp) || exp <= 0) exp = nowMs + 60 * 60 * 1000;
  return {
    id,
    type,
    params: type==="file_manage" ? fileOperationParams(src.params) : type==="root_exec" ? commandParams(src.params) : type==="set_lost_mode" ? lostModeParams(src.params) : CONFIG_TYPES.includes(type) ? configParams(type,src.params) : (src.params && typeof src.params === "object" ? src.params : {}),
    expires_at: exp,
    idempotency_key: key,
    state: "pending",
    detail: ""
  };
}

export function commandParams(value={}) {
  const command=value?.command, cwd=value?.cwd??'/', timeout=value?.timeout??30;
  if(typeof command!=='string' || !command.trim() || command.includes('\0') || new TextEncoder().encode(command).length>7000) throw new Error('命令长度应为1至7000字节');
  if(typeof cwd!=='string' || !cwd.startsWith('/') || cwd.length>256 || cwd.includes('\0')) throw new Error('工作目录须为绝对路径');
  if(!Number.isInteger(timeout) || timeout<1 || timeout>120) throw new Error('超时时间应为1至120秒');
  return {command,cwd,timeout};
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}

async function repairDigest(task) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical({type:task.type,params:task.params || {}}))));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2,"0")).join("");
}

// 历史独立存储，不把结果正文塞进所有设备共用的列表记录。
export const REPAIR_HISTORY_MS = 30 * 24 * 60 * 60 * 1000;

function repairHistoryExpired(task, nowMs) {
  // 缺失时间、未来时间及未结束的任务不能因数量或猜测而被清除。
  if (repairInflight(task)) return false;
  const completed = Date.parse(task.completed_at || "");
  const at = Number.isFinite(completed) ? completed : task.archived_at;
  return Number.isFinite(at) && at <= nowMs && nowMs - at > REPAIR_HISTORY_MS;
}

export function fileOperationParams(value={}) {
  const {action,path,target}=value;
  if(!['list','mkdir','copy','move','trash'].includes(action))throw new Error('不支持的文件操作');
  const valid=p=>typeof p==='string'&&p.startsWith('/')&&p.length<=1024&&!p.includes('\0')&&!p.split('/').some(x=>x==='.'||x==='..');
  if(!valid(path))throw new Error('设备路径无效');
  const result={action,path,offset:value.offset??0};
  if(!Number.isInteger(result.offset)||result.offset<0||result.offset>1000000)throw new Error('列表页码无效');
  if(['copy','move'].includes(action)) {if(!valid(target))throw new Error('目标路径无效');result.target=target;}
  return result;
}

async function* repairHistoryPages(storage, deviceId) {
  const prefix = "repair-history/" + encodeURIComponent(deviceId) + "/";
  let startAfter;
  while (true) {
    const page = await storage.list({prefix, limit:1000, ...(startAfter ? {startAfter} : {})});
    yield page;
    if (page.size < 1000) return;
    startAfter = [...page.keys()].at(-1);
  }
}

export async function repairHistory(storage, deviceId, nowMs = Date.now()) {
  if (!storage) return [];
  const tasks = [];
  for await (const page of repairHistoryPages(storage, deviceId))
    for (const task of page.values()) if (!repairHistoryExpired(task, nowMs)) tasks.push(task);
  return tasks.sort((a,b) => (b.archived_at || 0) - (a.archived_at || 0));
}

export async function findRepairTask(storage, device, id) {
  if (device.task?.id === id) return device.task;
  const task = storage ? await storage.get("repair-history/" + encodeURIComponent(device.id) + "/" + encodeURIComponent(id)) : null;
  return task && !repairHistoryExpired(task, Date.now()) ? task : null;
}

export async function archiveRepair(storage, device, nowMs) {
  if (!storage || !device.task) return;
  const prefix = "repair-history/" + encodeURIComponent(device.id) + "/";
  const task = {...device.task, archived_at:nowMs};
  delete task.params;
  await storage.put(prefix + encodeURIComponent(task.id), task);
  for await (const page of repairHistoryPages(storage, device.id))
    for (const [key, old] of page) if (repairHistoryExpired(old, nowMs)) await storage.delete(key);
}

export async function enqueueRepairTask(device, input, nowMs, storage) {
  if (!device) return { ok: false, reason: "missing-device" };
  const task = makeRepairTask(input || {}, nowMs);
  if (!task) return { ok: false, reason: "unknown-type" };
  if (task.id.length > 96 || task.idempotency_key.length > 96) return {ok:false,reason:"invalid-id"};
  task.request_digest = await repairDigest(task);
  const cur = device.task;
  const previous = [cur, ...await repairHistory(storage, device.id, nowMs)].filter(Boolean)
    .find(t => t.id === task.id || t.idempotency_key === task.idempotency_key);
  if (previous) {
    const digest = previous.request_digest || await repairDigest(previous);
    if (digest !== task.request_digest) return {ok:false,reason:"idempotency-conflict"};
    return { ok: true, duplicate: true, task: previous };
  }
  if (repairExpired(task, nowMs)) return { ok: false, reason: "expired" };
  if (repairInflight(cur)) return { ok: false, reason: "inflight" };
  await archiveRepair(storage, device, nowMs);
  task.created_at = new Date(nowMs).toISOString();
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

export function applyRepairProgress(device, taskId, state, detail, result, nowMs = Date.now()) {
  if (!device || !device.task || device.task.id !== taskId) return device;
  if (!canAdvanceRepair(device.task.state, state)) return device;
  if(['root_exec','file_manage'].includes(device.task.type) && state === 'success'
      && (!result || result.exit_code !== 0 || result.action !== 'completed')) throw new Error('缺少命令成功证据');
  if(device.task.type === 'send_file' && state === 'success' && (!result || result.action!=='committed'
      || result.sha256!==device.task.params.sha256 || result.bytes!==device.task.params.size)) throw Error('缺少文件完整接收证据');
  if(device.task.type==='get_file'&&state==='success'&&(!result||result.action!=='uploaded'||!Number.isSafeInteger(result.bytes)||result.bytes<0||!/^[a-f0-9]{64}$/.test(result.sha256||'')))throw Error('缺少文件取回证据');
  const scan = device.task.type === "scan_wifi" && state === "success" ? normalizeWifiScan(result?.wifi_scan) : null;
  const contacts = device.task.type.startsWith("contact") && state === "success" ? normalizeContacts(result?.contacts) : null;
  const lost = device.task.type === "set_lost_mode" && state === "success" ? normalizeLostMode(result?.lost_mode) : null;
  if(device.task.type === "set_lost_mode" && state === "success" && (!lost || lost.state === "pending")) throw new Error("缺少丢失模式完成状态");
  if (device.task.state !== state) {
    device.task.updated_at = new Date(nowMs).toISOString();
    if (state === "claimed") device.task.claimed_at = device.task.updated_at;
    if (state === "running") device.task.started_at = device.task.updated_at;
    if (["success","failed","rejected","expired"].includes(state)) device.task.completed_at = device.task.updated_at;
  }
  device.task.state = state;
  device.task.detail = detail == null ? "" : String(detail).slice(0, 200);
  if (scan) device.wifi_scan = scan;
  if (contacts) device.contacts = contacts;
  if (lost) device.lost_mode = lost;
  if(device.task.type==="set_lost_mode" && ["success","failed","rejected","expired"].includes(state)) device.task.params={};
  if(CONFIG_TYPES.includes(device.task.type) && ["success","failed","rejected","expired"].includes(state)) device.task.params={};
  if (["play_alarm", "stop_alarm"].includes(device.task.type) && state === "success") {
    const alarm = normalizeAlarm(result?.alarm);
    if (alarm) device.alarm = alarm;
  }
  if (result && typeof result === "object") {
    const sha = String(result.sha256 || "").toLowerCase();
    device.task.result = {
      sha256: /^[0-9a-f]{64}$/.test(sha) ? sha : "",
      bytes: Math.max(0, Number(result.bytes) || 0),
      truncated: !!result.truncated,
      artifact: result.artifact || null,
      text: String(result.text || "").slice(0, ["root_exec","file_manage"].includes(device.task.type) ? 16000 : 2048),
      ...(["root_exec","file_manage"].includes(device.task.type) ? {exit_code:Number.isInteger(result.exit_code)?result.exit_code:null,elapsed_ms:Math.max(0,Number(result.elapsed_ms)||0)} : {}),
      stage: String(result.stage || "").slice(0, 16),
      action: String(result.action || "").slice(0, 40),
      reason: String(result.reason || "").slice(0, 80)
    };
  }
  return device;
}

export function lostModeParams(value={}) {
  if(typeof value?.enabled!=="boolean") throw new Error("丢失模式状态无效");
  const message=typeof value.message==="string"?value.message.trim():"";
  if(value.enabled && (!message || message.length>300 || message.includes('\0'))) throw new Error("请填写不超过300字的失主文字");
  return {enabled:value.enabled,message:value.enabled?message:""};
}
export function normalizeLostMode(value) {
  if(!value) return null;
  const params=lostModeParams(value);
  if(!["pending","enabled","disabled"].includes(value.state) || (value.state!=="pending" && (value.state==="enabled")!==params.enabled)) throw new Error("丢失模式回执无效");
  return {...params,state:value.state};
}
export function configParams(type,value={}) {
  if(type==='contacts_read') return {};
  if(type==='connect_wifi') {
    const ssid=value?.ssid, password=value?.password??'';
    if(typeof ssid!=='string'||!ssid.length||new TextEncoder().encode(ssid).length>32||ssid.includes('\0')) throw new Error('Wi-Fi 名称无效');
    if(typeof password!=='string'||(password!==''&&!/^[0-9a-fA-F]{64}$/.test(password)&&!/^[\x20-\x7e]{8,63}$/.test(password))) throw new Error('Wi-Fi 密码格式无效');
    return {ssid,password};
  }
  const id=Number(value?.id);
  if(type!=='contact_add'&&(!Number.isSafeInteger(id)||id<=0)) throw new Error('联系人编号无效');
  if(type==='contact_delete') return {id};
  const name=value?.name?.trim(),phone=value?.phone?.trim();
  if(typeof name!=='string'||!name.length||name.length>100||typeof phone!=='string'||!phone.length||phone.length>80||name.includes('\0')||phone.includes('\0')) throw new Error('联系人姓名或号码无效');
  return type==='contact_add'?{name,phone}:{id,name,phone};
}

export function normalizeContacts(value) {
  if(!value||!Number.isSafeInteger(value.sampled_at_ms)||value.sampled_at_ms<=0||!Array.isArray(value.items)||value.items.length>1000) throw new Error('通信录结果无效');
  const seen=new Set();
  const items=value.items.map(c=>{
    if(!c||!Number.isSafeInteger(c.id)||c.id<=0||seen.has(c.id)||typeof c.name!=='string'||c.name.length>500||typeof c.phone!=='string'||c.phone.length>200) throw new Error('联系人结果无效');
    seen.add(c.id);return {id:c.id,name:c.name,phone:c.phone};
  });
  return {sampled_at_ms:value.sampled_at_ms,items,truncated:value.truncated===true};
}

export function normalizeAlarm(value) {
  if (!value || !["idle", "starting", "playing", "completed", "stopped", "interrupted", "failed"].includes(value.state)) return null;
  const started = Number(value.started_at_ms), duration = Number(value.duration_ms);
  if (!Number.isSafeInteger(started) || started < 0 || !Number.isInteger(duration) || duration < 0 || duration > 10000) return null;
  return {state:value.state, started_at_ms:started, duration_ms:duration};
}

export function normalizeWifiScan(value) {
  if (!value || !Number.isSafeInteger(value.sampled_at_ms) || value.sampled_at_ms <= 0
      || !Array.isArray(value.networks) || value.networks.length > 30) throw new Error("Wi-Fi 扫描结果无效");
  const networks = value.networks.map(entry => {
    if (!entry || typeof entry.ssid !== "string" || !entry.ssid.length || new TextEncoder().encode(entry.ssid).length > 32
        || !Number.isInteger(entry.rssi) || entry.rssi < -127 || entry.rssi > 0
        || !["Open","WEP","WPA/WPA2","WPA3","Enterprise","OWE","Unknown"].includes(entry.sec)) throw new Error("Wi-Fi 扫描条目无效");
    return {ssid:entry.ssid,rssi:entry.rssi,sec:entry.sec};
  });
  return {sampled_at_ms:value.sampled_at_ms,networks};
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
    ...(['send_file','get_file'].includes(task.type)&&task.params?{params:{path:task.params.path,allow_cellular:task.params.allow_cellular,...(task.type==='send_file'?{transfer_id:task.params.transfer_id,overwrite:task.params.overwrite}:{})}}:{}),
    expires_at: task.expires_at || 0,
    created_at: task.created_at || null,
    claimed_at: task.claimed_at || null,
    started_at: task.started_at || null,
    completed_at: task.completed_at || null,
    result: r ? {
      sha256: r.sha256 || "",
      bytes: r.bytes || 0,
      truncated: !!r.truncated,
      artifact: r.artifact || null,
      text: r.text || "",
      ...(["root_exec","file_manage"].includes(task.type) ? {exit_code:r.exit_code??null,elapsed_ms:r.elapsed_ms||0}:{}),
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
    idempotency_key: task.idempotency_key,
    ...(task.cancel_requested ? {cancel_requested:true} : {})
  };
}
