import {systemSettingsParams,applySystemSettingsResult,systemSettingAllowed} from "../system-settings.js";
import {isManagementPackage} from "../gateway-product.js";
import {isNetworkTask,prepareNetworkTask,applyNetworkProgress,publicNetwork} from '../network-confirmation.js';
import {normalizeContactsPageParams,normalizeContactsPageResult,validateContactsPageSnapshot} from '../contacts-pages.js';
import {sipDestination,sipKey,sipAllowed,checkSipTarget,validateSipResult,sipConfigurationResult,redactSipText} from '../sip-accounts.js';
export const CONTROL_PLANE_ONLINE_MS = 120000;
export const PAIR_CODE_TTL_MS = 60 * 60 * 1000;

export function contactState(lastSeen, nowMs, statusOnly = false, network = "cellular", reportIntervalMs = null) {
  const at = lastSeen ? Date.parse(lastSeen) : NaN;
  if (!Number.isFinite(at) || at > nowMs) return { state: "unknown", report_due_at: null };
  const window = statusOnly ? (Number.isSafeInteger(reportIntervalMs)&&reportIntervalMs>=60000&&reportIntervalMs<=86400000
    ? reportIntervalMs : (network === "wifi" || network === "ethernet" ? 15 : 60) * 60 * 1000) : CONTROL_PLANE_ONLINE_MS;
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
// remove_proxy：代理核心改为按需下载之后，装上了也要能单独卸掉。
export const PROXY_TASK_TYPES = ["configure_proxy","start_proxy","stop_proxy","test_proxy","remove_proxy","select_proxy_node","set_proxy_apps"];
// 管理程序不得进入代理名单。设备侧也拦，但这道必须在服务端：
// 万一面板出 bug 或有人直接敲接口把管理程序勾进去，设备会连管理连接一起送进隧道，
// 结果是失联且无法远程恢复——这种代价的单点不能只靠一侧把守。
// 判据见 gateway-product.js 的 isManagementPackage：只认管理程序这几个包，
// 不是整个 net.elfradio 命名空间（那样会误伤 Zello 守护等普通自家应用）。
// 下发这条路拒整条任务是合适的：失败只影响这条任务，不波及遥测。
const PROXY_APP_PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(.[A-Za-z0-9_]+)+$/;
const MAX_PROXY_APPS = 64;
export const LOST_MESSAGE_TASK_TYPES = ["show_lost_message","clear_lost_message"];
export const PIXEL_COMPANION_TASK_TYPE = "stage_pixel_companion";
export const REPAIR_TYPES = ["contacts_page", "system_config", "configure_zello", "configure_sip", "file_manage", "get_file", "send_file", "root_exec", "pull_logs", "heal_network", "reboot", "install_apk", "restart_adbd", "scan_wifi", "play_alarm", "stop_alarm", "locate_now", "set_lost_mode", "wipe_data", "show_share_link", PIXEL_COMPANION_TASK_TYPE, ...LOST_MESSAGE_TASK_TYPES, ...PROXY_TASK_TYPES, ...CONFIG_TYPES];

// 任务类型 → 设备能力位。status_only 的设备只接它在上报里声明过能力的任务。
// 以前散在三处：入队处一段二十行的 || 链、网页端 MAINTENANCE_CAPS、REPAIR_TYPES；
// 加一种任务要改三处，漏一处就是「客户端明明支持却报尚未接通」。现在只改这里。
// 值为字符串 = 任一机型都看这一位；为对象 = 按是否网关（Pixel Gateway）分别看，缺省项即该机型不支持。
export const TASK_CAPABILITIES = Object.freeze({
  contacts_page: "managed_contacts_page_v1",
  root_exec: "managed_exec_tasks",
  file_manage: "managed_file_operations",
  system_config: "managed_system_settings",
  configure_sip: "managed_sip_account",
  configure_zello: "managed_zello_account",
  get_file: "managed_file_return",
  send_file: "managed_file_tasks",
  pull_logs: "managed_log_tasks",
  heal_network: "managed_heal_tasks",
  reboot: "managed_reboot_tasks",
  restart_adbd: "managed_adbd_tasks",
  scan_wifi: "managed_wifi_scan_tasks",
  play_alarm: "managed_alarm_tasks",
  stop_alarm: "managed_alarm_tasks",
  show_share_link: "managed_share_link_tasks",
  locate_now: "managed_locate_tasks",
  set_lost_mode: "managed_lost_tasks",
  wipe_data: "managed_wipe_v1",
  // install_apk 在入队更早的分支里按发布清单处理，不经能力位。
  ...Object.fromEntries(PROXY_TASK_TYPES.map(type => [type, "managed_proxy_tasks"])),
  ...Object.fromEntries(LOST_MESSAGE_TASK_TYPES.map(type => [type, { gateway: "managed_lost_message_v1" }])),
  [PIXEL_COMPANION_TASK_TYPE]: { gateway: "managed_pixel_companion_v1" },
  connect_wifi: { gateway: "managed_wifi_config_tasks", device: "managed_config_tasks" },
  ...Object.fromEntries(CONFIG_TYPES.filter(type => type !== "connect_wifi").map(type => [type, { device: "managed_config_tasks" }]))
});
/** 该任务类型在此机型上要看哪一位；不支持返回 null。 */
export function taskCapability(type, gateway) {
  const entry = TASK_CAPABILITIES[String(type || "")];
  if (!entry) return null;
  if (typeof entry === "string") return entry;
  return (gateway ? entry.gateway : entry.device) || null;
}
/** status_only 设备能否接这个任务：能力位必须是严格的 true。 */
export function taskCapable(device, type, gateway) {
  const bit = taskCapability(type, gateway);
  return !!bit && device?.[bit] === true;
}

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
  contacts_page: "读取通讯录页",
  system_config: "系统配置",
  configure_sip: "配置Linphone账号",
  configure_zello: "配置Zello账号",
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
  wipe_data: "清除设备数据",
  show_lost_message: "显示丢失信息",
  clear_lost_message: "清除丢失信息",
  configure_proxy: "配置代理",
  start_proxy: "启动代理",
  stop_proxy: "停止代理",
  test_proxy: "检测代理",
  remove_proxy: "移除代理核心",
  stage_pixel_companion: "暂存Pixel根组件",
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

// 每台设备只有一个任务槽，默认有效期一小时。任务进了 claimed/running 之后设备端崩溃、
// 重启、断网，以前服务端不会把它标过期——这台设备一小时内拒绝一切新任务，
// 网页和 MCP 都只看到「已有任务进行中」。现在按任务自己的超时加一分钟宽限判死：
// 过了这个点还没回报，说明执行器那边早就结束了，占着槽位没有意义。
// pending 的不动：它还没被设备领走，本来就该等到 expires_at。
export const REPAIR_STALE_GRACE_MS = 60000;
export function repairStaleAfter(task) {
  if (!task) return null;
  if (task.state === "claimed" || task.state === "running") {
    const started = Date.parse(task.started_at || task.claimed_at || task.updated_at || task.created_at || "");
    if (!Number.isFinite(started)) return null;
    const timeout = Number(task.params?.timeout);
    // 没写超时的任务类型按 10 分钟算；写了的按它自己的。
    return started + (Number.isFinite(timeout) && timeout > 0 ? timeout * 1000 : 600000) + REPAIR_STALE_GRACE_MS;
  }
  return null;
}
/** 把卡死的任务标成 expired（终态，留在槽位里直到被新任务顶掉并归档）；返回 true 表示改了。 */
export function reclaimStaleRepair(device, nowMs = Date.now()) {
  const task = device?.task;
  const deadline = repairStaleAfter(task);
  if (deadline === null || nowMs < deadline) return false;
  task.state = "expired";
  task.updated_at = task.completed_at = new Date(nowMs).toISOString();
  task.detail = "设备未回报结果，任务已超时释放";
  return true;
}

export function makeRepairTask(input, nowMs) {
  const src = input || {};
  const type = String(src.type || "");
  if (!isAllowedRepairType(type)) return null;
  const id = String(src.id || "").trim() || ("t" + crypto.randomUUID().replaceAll("-", ""));
  const typedIdMax=PROXY_TASK_TYPES.includes(type)?96:64;
  if(["system_config","root_exec","send_file","get_file","file_manage","configure_sip","configure_zello",...LOST_MESSAGE_TASK_TYPES,...PROXY_TASK_TYPES].includes(type)
      && !(new RegExp('^[a-zA-Z0-9-]{1,'+typedIdMax+'}$')).test(id)) throw new Error("任务编号无效");
  const key = String(src.idempotency_key || "").trim() || id;
  let exp = Number(src.expires_at);
  if (!Number.isFinite(exp) || exp <= 0) exp = nowMs + 60 * 60 * 1000;
  if(type===PIXEL_COMPANION_TASK_TYPE)exp=Math.min(exp,nowMs+30*60*1000);
  const params=type===PIXEL_COMPANION_TASK_TYPE?pixelCompanionParams(src.params):type==='contacts_page'?normalizeContactsPageParams(src.params):type==="system_config" ? systemSettingsParams(src.params) : type==="configure_zello" ? zelloAccountParams(src.params) : type==="configure_sip" ? sipAccountParams(src.params) : type==="file_manage" ? fileOperationParams(src.params) : type==="root_exec" ? commandParams(src.params) : type==="set_lost_mode" ? lostModeParams(src.params) : type==="wipe_data" ? wipeParams(src.params) : LOST_MESSAGE_TASK_TYPES.includes(type) ? lostMessageParams(type,src.params) : PROXY_TASK_TYPES.includes(type) ? proxyTaskParams(type,src.params) : CONFIG_TYPES.includes(type) ? configParams(type,src.params) : (src.params && typeof src.params === "object" ? src.params : {});
  return {
    id,
    type,
    params,
    ...(type==='configure_proxy'?{proxy_config_sha256:params.sha256}:{}),
    expires_at: exp,
    idempotency_key: key,
    state: "pending",
    detail: ""
  };
}

const PIXEL_COMPANION_FAILURES=new Set(['companion-task-expired','companion-task-cancelled','gateway-not-confirmed-idle','companion-security-rejected','companion-stage-failed']);
export function pixelCompanionParams(value={}){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length)throw Error('Pixel伴随组件暂存任务不接受参数');
  return {};
}
function pixelCompanionResult(value){
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Pixel伴随组件成功回执无效');
  const fields=['stage','action','state','units_enabled','rollback_available','legacy_modules','units','legacy'];
  const keys=Object.keys(value);
  if(keys.length!==fields.length||keys.some(key=>!fields.includes(key))||value.stage!=='pixel_companion'||value.action!=='staged'
      ||!['installed','unchanged','upgraded'].includes(value.state)||value.units_enabled!==false
      ||value.rollback_available!==true||!['preserved','partial','absent'].includes(value.legacy_modules))
    throw Error('Pixel伴随组件成功回执无效');
  const unitFields=['charge','audio','adb_tcp'];
  if(!value.units||typeof value.units!=='object'||Array.isArray(value.units)
      ||Object.keys(value.units).length!==unitFields.length||Object.keys(value.units).some(key=>!unitFields.includes(key))
      ||unitFields.some(key=>value.units[key]!==false))throw Error('Pixel伴随组件单元状态无效');
  const legacyFields=['charge_bypass','sip_audio_access'],moduleFields=['installed','disabled','recognized'];
  if(!value.legacy||typeof value.legacy!=='object'||Array.isArray(value.legacy)
      ||Object.keys(value.legacy).length!==legacyFields.length||Object.keys(value.legacy).some(key=>!legacyFields.includes(key)))
    throw Error('Pixel旧模块状态无效');
  const legacy={};
  for(const key of legacyFields){
    const module=value.legacy[key];
    if(!module||typeof module!=='object'||Array.isArray(module)
        ||Object.keys(module).length!==moduleFields.length||Object.keys(module).some(field=>!moduleFields.includes(field))
        ||moduleFields.some(field=>typeof module[field]!=='boolean')
        ||(!module.installed&&(module.disabled||module.recognized))||(module.recognized&&!module.installed))
      throw Error('Pixel旧模块状态无效');
    legacy[key]=Object.fromEntries(moduleFields.map(field=>[field,module[field]]));
  }
  const installed=legacyFields.filter(key=>legacy[key].installed);
  if(value.legacy_modules==='preserved'
      &&(installed.length!==2||legacyFields.some(key=>legacy[key].disabled||!legacy[key].recognized)))
    throw Error('Pixel旧模块保留状态不一致');
  if(value.legacy_modules==='partial'
      &&(installed.length!==1||legacyFields.some(key=>legacy[key].installed&&(legacy[key].disabled||!legacy[key].recognized))))
    throw Error('Pixel旧模块部分保留状态不一致');
  if(value.legacy_modules==='absent'&&installed.length!==0)throw Error('Pixel旧模块缺失状态不一致');
  return {
    stage:value.stage,action:value.action,state:value.state,units_enabled:false,rollback_available:true,
    legacy_modules:value.legacy_modules,units:Object.fromEntries(unitFields.map(key=>[key,false])),legacy
  };
}
function pixelCompanionDetail(state,detail){
  const fixed={claimed:'companion-task-claimed',running:'companion-task-running',success:'companion-staged-disabled',expired:'companion-task-expired'}[state];
  if(fixed){if(detail!==fixed)throw Error('Pixel伴随组件任务进度详情无效');return fixed;}
  if(['failed','rejected'].includes(state)&&PIXEL_COMPANION_FAILURES.has(detail))return detail;
  throw Error('Pixel伴随组件任务失败类别无效');
}

export function lostMessageParams(type,value={}){
  if(!value||typeof value!=="object"||Array.isArray(value))throw Error("丢失信息任务参数无效");
  const keys=Object.keys(value);
  if(type==="clear_lost_message"){
    if(keys.length)throw Error("清除丢失信息不接受参数");
    return {};
  }
  if(type!=="show_lost_message"||keys.length!==1||keys[0]!=="message"||typeof value.message!=="string")
    throw Error("显示丢失信息参数无效");
  const message=value.message.trim();
  if(!message||message.length>500||message.includes("\0"))throw Error("丢失信息须为1至500个字符");
  return {message};
}

export function proxyTaskParams(type,value={}){
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('代理任务参数无效');
  if(type==='select_proxy_node'){
    // 只认一个节点名。AUTO 这类代理组名字同样从这里过——对服务端来说它们没有区别，
    // 哪些名字有效由设备按自己的配置裁决，服务端不维护一份会和配置脱节的白名单。
    if(Object.keys(value).length!==1||typeof value.name!=='string'
        ||value.name.length<1||value.name.length>64||/[ -]/.test(value.name))throw Error('代理节点名称无效');
    return {name:value.name};
  }
  if(type==='set_proxy_apps'){
    if(Object.keys(value).length!==1||!Array.isArray(value.apps))throw Error('代理应用名单无效');
    if(value.apps.length>MAX_PROXY_APPS)throw Error('代理应用数量超出上限');
    const seen=new Set();
    for(const pkg of value.apps){
      if(typeof pkg!=='string'||pkg.length<1||pkg.length>128||!PROXY_APP_PACKAGE.test(pkg))throw Error('代理应用包名无效');
      if(seen.has(pkg))throw Error('代理应用包名重复');
      seen.add(pkg);
      if(isManagementPackage(pkg))throw Error('管理程序不得走代理');
    }
    return {apps:value.apps.slice()};
  }
  if(type!=='configure_proxy'){
    if(Object.keys(value).length)throw Error('代理控制任务不接受参数');
    return {};
  }
  // 必填四项；core 可选。version 是 2026-09-20 加的：设备看门狗回退时要报「退回了哪一版」，
  // 拿 sha256 前缀自编的版本号和管理员在面板上看到的对不上。
  // core 是按需下载的代理核心清单——服务端只搬「签名清单 + 签名」，设备用内置公钥验签后才落盘。
  // 这里原来是「恰好三个字段」的精确集合，加了 version 与 core 之后整条下发会被它拒掉，
  // 而单测只测了生成参数那个函数、没测这条缝，结果是线上发任务直接 400。
  const fields=['url','size','sha256','version'],optional=['core'];
  if(fields.some(key=>!Object.hasOwn(value,key))
      ||Object.keys(value).some(key=>!fields.includes(key)&&!optional.includes(key)))throw Error('代理配置任务字段无效');
  if(typeof value.version!=='string'||value.version.length<1||value.version.length>64)throw Error('代理配置版本无效');
  if(Object.hasOwn(value,'core')){
    const core=value.core;
    if(!core||typeof core!=='object'||Array.isArray(core)
        ||Object.keys(core).length!==2||!Object.hasOwn(core,'manifest_raw')||!Object.hasOwn(core,'signature')
        ||typeof core.manifest_raw!=='string'||core.manifest_raw.length<2||core.manifest_raw.length>8192
        ||!/^(?:[0-9a-f]{2})+$/i.test(core.signature||'')||core.signature.length>4096)throw Error('代理核心清单无效');
  }
  if(typeof value.url!=='string'||value.url.length>4096
      ||!/^https:\/\/v\.elfradio\.net\/api\/elfremote\/proxy-config\/[A-Za-z0-9-]{1,96}(?:\?[^#]*)?$/.test(value.url))throw Error('代理配置下载地址无效');
  if(!Number.isInteger(value.size)||value.size<2||value.size>2*1024*1024)throw Error('代理配置大小无效');
  if(!/^[a-f0-9]{64}$/.test(value.sha256||''))throw Error('代理配置校验值无效');
  return Object.fromEntries(fields.concat(optional.filter(key=>Object.hasOwn(value,key))).map(key=>[key,value[key]]));
}

const PROXY_STATUS_OPTIONAL=['config_version','config_sha256','error_category',
  'management_https_via_proxy','management_mqtt_via_proxy','adb_wss_via_proxy_ready','file_download_via_proxy_ready'];
const PROXY_STATUS_FIELDS=['schema_version','bundled','version','abi','asset_verified','core_verified','configured','running',
  'http_ready','socks_ready','proxy_reachable','management_via','write_locked','http_port','socks_port','checked_at_ms'];
function proxyTaskStatus(value){
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('代理任务状态无效');
  const keys=Object.keys(value);
  // 必填仍是那 16 个；可选的几项是配置身份、代理路径与错误类别——
  // 核心改为按需下载之后，「装的是哪一版配置」「为什么失败」是最该看的两件事，
  // 原来的精确集合根本不收，设备只能报个空壳。与 proxyRuntimeStatus 的放宽保持一致。
  if(PROXY_STATUS_FIELDS.some(key=>!Object.hasOwn(value,key))
      ||keys.some(key=>!PROXY_STATUS_FIELDS.includes(key)&&!PROXY_STATUS_OPTIONAL.includes(key)))
    throw Error('代理任务状态字段无效');
  // bundled 不再硬判 true：代理核心改为按需下载、不随 APK 打包，D31 会报 false。
  // 这条校验和 gateway-product.js 的 proxyRuntimeStatus 是两套，两边都要放开，漏一处设备就报不上来。
  if(value.schema_version!==2||typeof value.bundled!=='boolean'||value.abi!=='arm64-v8a'||value.write_locked!==true)
    throw Error('代理任务状态版本无效');
  // 核心未安装时没有版本可报，允许 null；但已验证装好了却报不出版本是设备侧的 bug，不放过。
  if(value.version===null||value.version===''){
    if(value.asset_verified===true||value.core_verified===true)throw Error('核心已就绪却未报版本');
  }else if(typeof value.version!=='string'||value.version.length<1||value.version.length>32)throw Error('代理核心版本无效');
  for(const key of ['asset_verified','core_verified','configured','running','http_ready','socks_ready','proxy_reachable'])
    if(typeof value[key]!=='boolean')throw Error('代理任务状态必须为布尔值');
  if(!['direct','proxy'].includes(value.management_via)||value.http_port!==17890||value.socks_port!==17891
      ||!Number.isSafeInteger(value.checked_at_ms)||value.checked_at_ms<=0)throw Error('代理任务状态边界无效');
  if(Object.hasOwn(value,'config_sha256')&&value.config_sha256!==null&&!/^[a-f0-9]{64}$/.test(value.config_sha256))
    throw Error('代理配置校验值无效');
  if(Object.hasOwn(value,'config_version')&&value.config_version!==null
      &&(typeof value.config_version!=='string'||value.config_version.length<1||value.config_version.length>64))
    throw Error('代理配置版本无效');
  for(const key of ['management_https_via_proxy','management_mqtt_via_proxy','adb_wss_via_proxy_ready','file_download_via_proxy_ready'])
    if(Object.hasOwn(value,key)&&typeof value[key]!=='boolean')throw Error('代理路径状态必须为布尔值');
  const picked=PROXY_STATUS_FIELDS.concat(PROXY_STATUS_OPTIONAL.filter(key=>Object.hasOwn(value,key)));
  return Object.fromEntries(picked.map(key=>[key,value[key]]));
}

// 任务回执里的 proxy 是设备在操作结束后、同一把锁内重新采集的完整状态，
// 时钟与采集口径都和周期上报一致（D31-dev 2026-09-20 确认）。不写回的话，点完停止到
// 下一轮上报之间面板一直显示「运行中」——那不是滞后，是在报假状态。
// 只按 checked_at_ms 单调覆盖：设备墙钟对时跳变可能让晚到的回执带上更小的时间戳，
// 那种情况下丢掉回执是安全的一侧，宁可慢一轮也不让面板倒退回旧值。
// 设备执行后回读的实际值，落到设备记录上，面板据此显示「当前选的是哪台、哪些程序在走代理」。
// 存回执而不是存下发的请求值：请求值只说明管理员想要什么，回执才说明设备上实际是什么。
export function applyProxyReceiptEcho(device,normalized){
  if(!device||!normalized)return;
  if(normalized.action==='select_proxy_node'&&typeof normalized.selected==='string')
    device.proxy_selected_node=normalized.selected;
  if(normalized.action==='set_proxy_apps'&&Array.isArray(normalized.apps))
    device.proxy_apps=normalized.apps.slice();
}

export function applyProxyReceiptRuntime(device,proxy){
  if(!device||!proxy)return false;
  const previous=device.proxy_runtime;
  if(previous&&typeof previous==='object'&&Number.isSafeInteger(previous.checked_at_ms)
      &&proxy.checked_at_ms<previous.checked_at_ms)return false;
  device.proxy_runtime=proxy;
  return true;
}

export function proxyTaskResult(type,state,value){
  if(!['success','failed','rejected'].includes(state))throw Error('代理任务终态无效');
  if(value==null){
    if(state==='success')throw Error('代理任务成功回执缺失');
    return {stage:'proxy',action:type,proxy:null};
  }
  // 这两类任务的回执要多带一项：设备**执行后回读**的实际值。
  // 只回 success 不够——「点完看着切了、其实没切」正是 stop_proxy 演过一遍的假状态。
  const echoKey=type==='select_proxy_node'?'selected':type==='set_proxy_apps'?'apps':null;
  const allowed=echoKey?['stage','action','proxy',echoKey]:['stage','action','proxy'];
  if(typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>allowed.length
      ||!Object.hasOwn(value,'stage')||!Object.hasOwn(value,'action')||!Object.hasOwn(value,'proxy')
      ||Object.keys(value).some(key=>!allowed.includes(key))||value.stage!=='proxy'||value.action!==type)
    throw Error('代理任务终态回执无效');
  const proxy=proxyTaskStatus(value.proxy);
  let echo;
  if(echoKey){
    if(state==='success'&&!Object.hasOwn(value,echoKey))throw Error('代理任务成功回执缺少设备确认值');
    if(Object.hasOwn(value,echoKey)){
      if(echoKey==='selected'){
        if(typeof value.selected!=='string'||value.selected.length<1||value.selected.length>64)throw Error('代理节点确认值无效');
        echo=value.selected;
      }else{
        if(!Array.isArray(value.apps)||value.apps.length>MAX_PROXY_APPS
            ||value.apps.some(pkg=>typeof pkg!=='string'||!PROXY_APP_PACKAGE.test(pkg)||pkg.length>128))throw Error('代理应用确认值无效');
        if(value.apps.some(isManagementPackage))throw Error('设备回报的名单含管理程序');
        echo=value.apps.slice();
      }
    }
  }
  if(state==='success'){
    // 移除任务的成功形状和其余四种正好相反：核心已删干净，所以这几项必须全是 false。
    // 不反过来的话，「成功移除了却仍报着已配置」会被当成正常回执收下，面板上就看不出设备到底还有没有核心。
    if(type==='remove_proxy'){
      if(proxy.asset_verified||proxy.core_verified||proxy.configured||proxy.running
          ||proxy.http_ready||proxy.socks_ready||proxy.proxy_reachable)
        throw Error('代理移除回执仍显示核心或配置残留');
      return {stage:'proxy',action:type,proxy};
    }
    // 选节点与设名单在核心没跑时也允许成功：设备记下来、下次启动生效。
    // 因此不能套用「必须已配置且正在运行」那套判据。
    if(echoKey)return {stage:'proxy',action:type,proxy,[echoKey]:echo};
    if(!proxy.asset_verified||!proxy.core_verified||!proxy.configured)throw Error('代理任务成功状态不完整');
    if(type==='stop_proxy'){
      if(proxy.running||proxy.http_ready||proxy.socks_ready||proxy.proxy_reachable)throw Error('代理停止回执仍显示活动进程');
    }else if(type!=='configure_proxy'&&(!proxy.running||!proxy.http_ready||!proxy.socks_ready||!proxy.proxy_reachable))
      throw Error('代理启动或检测回执不完整');
  }
  return echoKey&&echo!==undefined?{stage:'proxy',action:type,proxy,[echoKey]:echo}:{stage:'proxy',action:type,proxy};
}

function proxyTaskDetail(type,state,result){
  if(state==='claimed')return '设备已领取代理任务';
  if(state==='running')return '设备正在执行代理任务';
  if(state==='success')return {configure_proxy:'代理配置已应用',start_proxy:'代理服务已启动',stop_proxy:'代理服务已停止',test_proxy:'代理路径检测通过',remove_proxy:'代理核心已移除',select_proxy_node:'已切换代理服务器',set_proxy_apps:'走代理的程序已更新'}[type];
  if(state==='failed')return '代理任务执行失败';
  if(state==='rejected')return '设备拒绝代理任务';
  return '';
}

export function zelloAccountParams(value={}) {
  const {username,password}=value,type=value.type??'regular';
  if(typeof username!=='string'||!/^[A-Za-z0-9_.@+-]{1,128}$/.test(username)||typeof password!=='string'||!password||password.length>256||/[\x00-\x1f\x7f]/.test(password)||type!=='regular')throw Error('普通Zello账号参数无效');
  return {username,password,type};
}
export async function queueZelloRestore(device,storage,now) {
  return queueAccountRestore(device,storage,now,'zello','configure_zello','managed_zello_account');
}

// 保存的是当前目标，恢复使用新任务编号；失败有界退避，不重放旧命令。
function restoreDue(saved,device,now) {
  if(saved.applied_token_sha===device.token_sha256)return false;
  let r=saved.restore;
  if(!r||r.token!==device.token_sha256)r=saved.restore={token:device.token_sha256,attempts:0,next_at:0};
  const task=device.task;
  if(r.task_id&&task?.id===r.task_id&&!repairInflight(task)) {
    if(!r.settled){
      r.settled=true;
      settleRestore(saved,task.state,task.detail,task.result);
    }
  }
  return !r.blocked&&r.attempts<3&&now>=r.next_at;
}
function settleRestore(saved,state,detail,result) {
  const r=saved.restore;if(!r)return;
  const failure=String(result?.text||detail||'');
  if(/bad credentials|invalid (?:password|credentials)|incorrect password|wrong password|密码错误|凭据错误|认证被拒绝/i.test(failure))r.blocked='账号或密码错误';
  if(state==='rejected')r.blocked='设备拒绝该配置，请检查版本及配置';
  r.settled=true;
}
function attemptedRestore(saved,device,now) {
  const r=saved.restore;r.attempts++;r.task_id=device.task.id;r.settled=false;
  r.next_at=now+[5*60000,30*60000,2*3600000][r.attempts-1];
  device.task.restore_attempt=true;
}
async function queueAccountRestore(device,storage,now,name,type,capability) {
  const saved=device.account_configs?.[name];
  if(!saved||device.enabled===false||!device[capability]||repairInflight(device.task)||!restoreDue(saved,device,now))return false;
  const result=await enqueueRepairTask(device,{type,id:name+'-restore-'+crypto.randomUUID(),params:saved.params},now,storage);
  if(!result.ok)return false;
  device.task.managed_exec_v1=true;attemptedRestore(saved,device,now);return true;
}
export async function queueSystemRestore(device,storage,now) {
  if(device.enabled===false||!device.managed_system_settings||repairInflight(device.task)||!device.token_sha256)return false;
  const targets=Object.values(device.system_targets||{}).sort((a,b)=>{
    const priority=x=>x.params.group==='wifi'||x.params.group==='network'?2:(x.params.key==='enabled'&&x.params.value===false?1:0);
    return priority(a)-priority(b)||a.updated_at-b.updated_at;
  });
  for(const saved of targets) {
    if(!restoreDue(saved,device,now))continue;
    let params;try{params=systemSettingsParams(saved.params);}catch{saved.restore.blocked='设置已不再支持';continue;}
    if(!systemSettingAllowed(device,params.group,params.key,params.package))continue;
    // 没有密码的Wi-Fi目标依赖设备已有保存网络，刷后不能假设仍然存在。
    const result=await enqueueRepairTask(device,{type:'system_config',id:'settings-restore-'+crypto.randomUUID(),params},now,storage);
    if(!result.ok)return false;
    device.task.managed_exec_v1=true;attemptedRestore(saved,device,now);return true;
  }
  return false;
}

export function sipAccountParams(value={}) {
  const destination=sipDestination(value);
  const {server,username}=value,gateway=destination?.target==='gateway',hasPassword=Object.hasOwn(value,'password'),keepPassword=Object.hasOwn(value,'keep_password'),password=value.password,
    auth_username=value.auth_username??username,transport=String(value.transport??'tls').toLowerCase(),port=value.port??(transport==='tls'?5061:5060);
  if(typeof server!=='string'||!/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(server)||typeof username!=='string'||!/^[A-Za-z0-9_.+-]{1,128}$/.test(username)
    ||typeof auth_username!=='string'||!/^[A-Za-z0-9_.+@-]{1,128}$/.test(auth_username)
    ||!['tls','tcp','udp'].includes(transport)||!Number.isInteger(port)||port<1||port>65535)throw Error('SIP账号参数无效');
  const validPassword=typeof password==='string'&&!!password&&password.length<=256&&password===password.trim()&&!/[\x00-\x1f\x7f]/.test(password);
  if(gateway){
    if(destination.account_id!=='primary'||value.auth_username!==undefined||!['tls','udp'].includes(transport)||hasPassword===keepPassword||(hasPassword&&!validPassword)||(keepPassword&&value.keep_password!==true))throw Error('Gateway SIP密码或传输参数无效');
  }else if(keepPassword||!hasPassword||!validPassword)throw Error('SIP账号参数无效');
  if(value.realm!==undefined&&(!destination||typeof value.realm!=='string'||!/^[A-Za-z0-9*_.@:-]{1,253}$/.test(value.realm)))throw Error('SIP realm无效或旧客户端不支持');
  return {server:server.toLowerCase(),username,...(!gateway?{auth_username}:{}),...(hasPassword?{password}:{keep_password:true}),transport,port,...(destination||{}),...(value.realm!==undefined?{realm:value.realm}:{})};
}

export async function queueSipRestore(device,storage,now) {
  if(device.enabled===false||device.managed_sip_account!==true||repairInflight(device.task))return false;
  if(Array.isArray(device.sip_targets)){
    for(const [key,saved] of Object.entries(device.account_configs||{})){
      if(!key.startsWith('sip:')||!sipAllowed(device,saved.params)||!restoreDue(saved,device,now))continue;
      try{checkSipTarget(device,saved.params);}catch{continue;}
      const result=await enqueueRepairTask(device,{type:'configure_sip',id:'sip-restore-'+crypto.randomUUID(),params:saved.params},now,storage);
      if(!result.ok)return false;
      device.task.managed_exec_v1=true;attemptedRestore(saved,device,now);return true;
    }
    return false;
  }
  return queueAccountRestore(device,storage,now,'linphone','configure_sip','managed_sip_account');
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
  if(task.network&&!(task.network.result?.cleanup_complete===true&&['CONFIRMED','UNCHANGED','ROLLED_BACK','ORIGINAL_OBSERVED','ABORTED','NOT_STARTED'].includes(task.network.result.status)))return false;
  // 缺失时间、未来时间及未结束的任务不能因数量或猜测而被清除。
  if (repairInflight(task)) return false;
  const completed = Date.parse(task.completed_at || "");
  const at = Number.isFinite(completed) ? completed : task.archived_at;
  return Number.isFinite(at) && at <= nowMs && nowMs - at > REPAIR_HISTORY_MS;
}

export function fileOperationParams(value={}) {
  const {action,path,target}=value;
  if(!['list','mkdir','copy','move','trash','delete'].includes(action))throw new Error('不支持的文件操作');
  const valid=p=>typeof p==='string'&&p.startsWith('/')&&p.length<=1024&&!p.includes('\0')&&!p.split('/').some(x=>x==='.'||x==='..');
  if(!valid(path))throw new Error('设备路径无效');
  const result={action,path,offset:value.offset??0};
  if(!Number.isInteger(result.offset)||result.offset<0||result.offset>1000000)throw new Error('列表页码无效');
  if(['copy','move'].includes(action)) {if(!valid(target))throw new Error('目标路径无效');result.target=target;if(value.overwrite===true)result.overwrite=true;}
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
  if (device.safety_task?.id === id) return device.safety_task;
  if (device.task?.id === id) return device.task;
  const task = storage ? await storage.get("repair-history/" + encodeURIComponent(device.id) + "/" + encodeURIComponent(id)) : null;
  return task && !repairHistoryExpired(task, Date.now()) ? task : null;
}

export async function archiveRepair(storage, device, nowMs) {
  if(device.task?.sip_destination)sipConfigurationResult(device,device.task,device.task.state,device.task.detail,nowMs);
  if (!storage || !device.task) return;
  const prefix = "repair-history/" + encodeURIComponent(device.id) + "/";
  const task = {...device.task, archived_at:nowMs};
  if(!isNetworkTask(task)&&task.type!=='contacts_page')delete task.params;
  await storage.put(prefix + encodeURIComponent(task.id), task);
  for await (const page of repairHistoryPages(storage, device.id))
    for (const [key, old] of page) if (repairHistoryExpired(old, nowMs)) await storage.delete(key);
}

export function isLostSafety(input){return input?.type==='set_lost_mode'&&input.params?.version===2&&(input.params.enabled===false||input.params.cancel_auto===true);}
async function enqueueSafetyTask(device,input,now,storage){
  const task=makeRepairTask(input,now);task.request_digest=await repairDigest(task);
  const previous=[device.safety_task,device.task,...await repairHistory(storage,device.id,now)].filter(Boolean).find(t=>t.id===task.id||t.idempotency_key===task.idempotency_key);
  if(previous)return previous.request_digest===task.request_digest?{ok:true,duplicate:true,task:previous}:{ok:false,reason:'idempotency-conflict'};
  if(repairExpired(task,now))return {ok:false,reason:'expired'};
  if(device.safety_task){
    const old={...device.safety_task};if(repairInflight(old)){old.state='rejected';old.completed_at=new Date(now).toISOString();old.detail='已被新的安全退出替代';}
    await archiveRepair(storage,{...device,task:old},now);
  }
  task.created_at=task.updated_at=new Date(now).toISOString();task.managed_lost_v1=true;device.safety_task=task;
  return {ok:true,task};
}
export async function enqueueRepairTask(device, input, nowMs, storage, options={}) {
  if (!device) return { ok: false, reason: "missing-device" };
  if(isLostSafety(input)&&device.managed_lost_safety_v1)return enqueueSafetyTask(device,input,nowMs,storage);
  const task = makeRepairTask(input || {}, nowMs);
  if (!task) return { ok: false, reason: "unknown-type" };
  if(task.type==='configure_sip'){
    const destination=sipDestination(task.params);if(destination){checkSipTarget(device,task.params);task.sip_destination=destination;}
  }
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
  // 卡死的任务先让位：标成 expired 之后它就是终态，下面会像其他终态一样被归档、顶掉。
  reclaimStaleRepair(device, nowMs);
  if (repairInflight(device.task)) {
    const t = device.task, deadline = repairStaleAfter(t);
    return { ok: false, reason: "inflight", inflight: { id: t.id, type: t.type, state: t.state,
      releases_at: deadline ?? (Number(t.expires_at) || null) } };
  }
  if(task.type==='contacts_page'){
    if(device.managed_contacts_page_v1!==true)throw Error('客户端尚未支持通讯录分页');
    const p=task.params,s=device.contacts_page_snapshot;
    if(p.action==='open'){
      if(s&&!s.closed&&nowMs<s.expires_at)return {ok:false,reason:'CONTACTS_SNAPSHOT_BUSY'};
    }else if(!s||s.descriptor.snapshot_id!==p.snapshot_id||s.credential_sha!==device.token_sha256||s.closed||(p.action==='page'&&nowMs>=s.expires_at))return {ok:false,reason:'CONTACTS_SNAPSHOT_GONE'};
    task.contacts_page_token_sha=device.token_sha256;
  }
  await prepareNetworkTask(device,task,options.allowNetworkAcceptance===true);
  await archiveRepair(storage, device, nowMs);
  if(task.type==='configure_zello'&&device.account_configs?.zello?.params?.username)
    task.params.previous_username=device.account_configs.zello.params.username;
  task.created_at = new Date(nowMs).toISOString();
  device.task = task;
  if(task.sip_destination)sipConfigurationResult(device,task,task.state,'',nowMs);
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
  if(device?.safety_task?.id===taskId){
    const view={...device,task:device.safety_task,safety_task:null};applyRepairProgress(view,taskId,state,detail,result,nowMs);
    device.safety_task=view.task;if(view.lost_mode){device.lost_mode=view.lost_mode;device.lost_mode_observed_at=view.lost_mode_observed_at;}return device;
  }
  if (!device || !device.task || device.task.id !== taskId) return device;
  if(device.task.type==='contacts_page'){
    const task=device.task;
    if(task.contacts_page_token_sha!==device.token_sha256)throw Error('联系人任务所属安装已改变');
    if(!canAdvanceRepair(task.state,state))throw Error('联系人任务状态不匹配');
    if(['success','failed','rejected'].includes(state)){
      if(result?.truncated===true)throw Error('联系人结果不完整');
      const value=normalizeContactsPageResult(result?.contacts_page,task.params);
      if((state==='success')!==value.ok)throw Error('联系人任务与内容结果不一致');
      if(['success','failed','rejected'].includes(task.state)){
        if(JSON.stringify(canonical(task.result?.contacts_page))!==JSON.stringify(canonical(value)))throw Error('联系人重复回执不一致');
        return device;
      }
      if(value.ok){
        const p=task.params;
        if(p.action==='open')device.contacts_page_snapshot={descriptor:value,expires_at:Date.parse(task.created_at)+120000,credential_sha:device.token_sha256,closed:false};
        else {
          const s=device.contacts_page_snapshot;if(!s||s.descriptor.snapshot_id!==p.snapshot_id||s.credential_sha!==device.token_sha256)throw Error('联系人快照不匹配');
          if(p.action==='page'){
            validateContactsPageSnapshot(s.descriptor,value);
          }else s.closed=true;
        }
      }
      task.result={contacts_page:value,truncated:false};task.completed_at=new Date(nowMs).toISOString();
    }else if(result!=null)throw Error('联系人进度不能携带未完成内容');
    task.state=state;task.updated_at=new Date(nowMs).toISOString();task.detail=state==='success'?'联系人操作已完成':state==='failed'||state==='rejected'?'联系人操作未完成':'';
    return device;
  }
  if(isNetworkTask(device.task)){
    const task=device.task;
    const network=applyNetworkProgress(device,task,state,result,nowMs);
    if(!canAdvanceRepair(task.state,state))throw Error('网络任务状态不可推进');
    if(task.state!==state){task.updated_at=new Date(nowMs).toISOString();if(state==='claimed')task.claimed_at=task.updated_at;if(state==='running'&&!task.started_at)task.started_at=task.updated_at;if(['success','failed','rejected'].includes(state))task.completed_at=task.updated_at;}
    task.state=state;if(network)task.result={network_transaction:network};
    return device;
  }
  if(PROXY_TASK_TYPES.includes(device.task.type)){
    const task=device.task;
    if(!canAdvanceRepair(task.state,state))throw Error('代理任务状态不匹配');
    if(state==='expired'){
      task.updated_at=new Date(nowMs).toISOString();task.completed_at=task.updated_at;task.state='expired';task.detail='代理任务已过期';task.params={};delete task.proxy_download_token_sha256;
      return device;
    }
    const terminal=['success','failed','rejected'].includes(state);
    if(!terminal&&result!=null)throw Error('代理任务进度不能携带终态回执');
    const normalized=terminal?proxyTaskResult(task.type,state,result):null;
    if(['success','failed','rejected','expired'].includes(task.state)){
      if(task.state!==state||JSON.stringify(task.result)!==JSON.stringify(normalized))throw Error('代理任务重复回执不一致');
      return device;
    }
    task.updated_at=new Date(nowMs).toISOString();
    if(state==='claimed')task.claimed_at=task.updated_at;
    if(state==='running'&&!task.started_at)task.started_at=task.updated_at;
    if(terminal){task.completed_at=task.updated_at;task.result=normalized;task.params={};delete task.proxy_download_token_sha256;applyProxyReceiptRuntime(device,normalized.proxy);applyProxyReceiptEcho(device,normalized);}
    task.state=state;task.detail=proxyTaskDetail(task.type,state,normalized);
    return device;
  }
  if(device.task.type===PIXEL_COMPANION_TASK_TYPE){
    const task=device.task;
    if(!canAdvanceRepair(task.state,state))throw Error('Pixel伴随组件任务状态不匹配');
    const terminal=['success','failed','rejected','expired'].includes(state);
    if(!terminal&&result!=null)throw Error('Pixel伴随组件进度不能携带终态回执');
    if(state!=='success'&&result!=null)throw Error('Pixel伴随组件失败回执不接受结果字段');
    const normalized=state==='success'?pixelCompanionResult(result):null;
    const nextDetail=pixelCompanionDetail(state,String(detail||''));
    if(['success','failed','rejected','expired'].includes(task.state)){
      if(task.state!==state||task.detail!==nextDetail||JSON.stringify(task.result||null)!==JSON.stringify(normalized))throw Error('Pixel伴随组件重复回执不一致');
      return device;
    }
    if(task.state===state){
      if(task.detail!==nextDetail)throw Error('Pixel伴随组件重复进度不一致');
      return device;
    }
    task.updated_at=new Date(nowMs).toISOString();
    if(state==='claimed')task.claimed_at=task.updated_at;
    if(state==='running'&&!task.started_at)task.started_at=task.updated_at;
    if(terminal){task.completed_at=task.updated_at;task.params={};task.result=normalized;}
    task.state=state;task.detail=nextDetail;
    return device;
  }
  // 不在 REPAIR_ADVANCE 里的迁移在这里被静默丢弃，这是有意为之：任务状态原地不动，
  // 路由照样回 200 与 ok:true，只是回体里的 task 仍是旧状态。所以设备侧不能拿 ok:true
  // 当作回执被采纳，必须按回读的 task.state 判定，不一致就补发缺的那一步。
  // 既有客户端没被咬到是因为它们本来就读回状态校验，不是因为服务端会拒。
  if (!canAdvanceRepair(device.task.state, state)) return device;
  if(device.task.type==='connect_wifi'&&device.task.managed_wifi_config_v1===true){
    if(state==='success'&&(!result||result.stage!=='wifi'||!['connected','unchanged'].includes(result.action)||result.verified!==true))
      throw Error('缺少 Wi-Fi 连接成功证据');
    if(state==='failed'&&result!=null){
      if(typeof result!=='object'||Array.isArray(result)||result.stage!=='wifi'||!['rolled_back','failed'].includes(result.action))
        throw Error('Wi-Fi 连接失败结果无效');
      if(result.action==='rolled_back'&&result.verified!==true)throw Error('缺少 Wi-Fi 回滚验证证据');
      if(Object.hasOwn(result,'verified')&&typeof result.verified!=='boolean')throw Error('Wi-Fi 验证状态无效');
    }
  }
  if(device.task.type==='system_config' && state==='success')applySystemSettingsResult(device,result,nowMs);
  if(device.task.type==='configure_zello' && state==='success' && (!result||result.logged_in!==true||result.exit_code!==0||result.action!=='completed'))throw Error('缺少Zello登录成功证据');
  const modernSip=device.task.type==='configure_sip'&&validateSipResult(device,state,result);
  if(device.task.type==='configure_sip' && !modernSip && state==='success' && (!result||result.registered!==true||result.exit_code!==0||result.action!=='completed'))throw Error('缺少SIP注册成功证据');
  if(device.task.type==='configure_sip'){
    if(device.task.state===state&&['success','failed','rejected','expired'].includes(state))return device;
    detail=redactSipText(device,detail||result?.reason||result?.text);
    if(result)result={exit_code:result.exit_code,elapsed_ms:result.elapsed_ms,text:redactSipText(device,result.text),reason:redactSipText(device,result.reason),stage:redactSipText(device,result.stage),action:redactSipText(device,result.action)};
  }
  if(['root_exec','file_manage'].includes(device.task.type) && state === 'success'
      && (!result || result.exit_code !== 0 || result.action !== 'completed')) throw new Error('缺少命令成功证据');
  if(device.task.type === 'send_file' && state === 'success' && (!result || result.action!=='committed'
      || result.sha256!==device.task.params.sha256 || result.bytes!==device.task.params.size)) throw Error('缺少文件完整接收证据');
  if(device.task.type==='get_file'&&state==='success'&&(!result||result.action!=='uploaded'||!Number.isSafeInteger(result.bytes)||result.bytes<0||!/^[a-f0-9]{64}$/.test(result.sha256||'')))throw Error('缺少文件取回证据');
  if(device.task.type==='wipe_data'&&state==='success')throw new Error('擦除后离线不能作为成功证明');
  if(LOST_MESSAGE_TASK_TYPES.includes(device.task.type)&&state==='success'){
    const expected=device.task.type==='show_lost_message'?'displayed':'cleared';
    if(!result||typeof result!=='object'||Array.isArray(result)
        ||Object.keys(result).length!==2||result.action!==expected||result.verified!==true)
      throw Error('缺少丢失信息操作完成证明');
    device.lost_message={active:device.task.type==='show_lost_message',
      message:device.task.type==='show_lost_message'?device.task.params.message:'',
      updated_at:new Date(nowMs).toISOString()};
  }
  const scan = device.task.type === "scan_wifi" && state === "success" ? normalizeWifiScan(result?.wifi_scan) : null;
  const contacts = device.task.type.startsWith("contact") && state === "success" ? normalizeContacts(result?.contacts) : null;
  const lost = device.task.type === "set_lost_mode" && state === "success" ? normalizeLostMode(result?.lost_mode) : null;
  if(device.task.type === "set_lost_mode" && state === "success"){
    const wanted=device.task.params||{};
    if(!lost||['pending','unknown'].includes(lost.state))throw Error('缺少丢失模式完成状态');
    if(wanted.version===2){
      const raw=result?.lost_mode;
      if(typeof raw?.enabled!=='boolean'||typeof raw.auto_wipe_enabled!=='boolean'||typeof raw.locked!=='boolean'||!Number.isSafeInteger(raw.deadline_at)||!['idle','armed','started','failed'].includes(raw.wipe_state))throw Error('缺少完整设备状态');
      if(device.managed_lost_safety_v1&&(!Number.isSafeInteger(raw.revision_seq)||raw.revision_seq<0))throw Error('缺少策略顺序');
      if(lost.version!==2||lost.auto_wipe_enabled!==(wanted.cancel_auto?false:wanted.auto_wipe_enabled))throw Error('自毁开关回执不匹配');
      if(!wanted.cancel_auto&&lost.enabled!==wanted.enabled)throw Error('丢失模式回执与请求不匹配');
      if(!wanted.cancel_auto&&wanted.enabled&&(!lost.locked||lost.timeout_hours!==wanted.timeout_hours))throw Error('缺少系统锁屏完成状态');
      if((!wanted.enabled||wanted.cancel_auto)&&(lost.deadline_at!==0||lost.wipe_state!=='idle'))throw Error('清除调度尚未取消');
      if(!wanted.enabled&&!wanted.cancel_auto&&(lost.state!=='disabled'||(lost.restored!==true&&lost.locked)))throw Error('原锁屏设置尚未恢复');
      if(device.managed_lost_safety_v1&&(!lost.revision||(!wanted.enabled&&!wanted.cancel_auto&&lost.restored!==true)))throw Error('缺少安全恢复证明');
    }
  }
  if(device.task.type==='configure_zello' && state==='success' && device.task.params?.password)device.account_configs={...device.account_configs,zello:{params:zelloAccountParams(device.task.params),applied_token_sha:device.token_sha256,updated_at:new Date(nowMs).toISOString()}};
  if(device.task.type==='configure_sip' && state==='success' && (device.task.params?.password||device.task.params?.keep_password===true)){
    const key=modernSip?sipKey(device.task.sip_destination):'linphone';
    const normalized=sipAccountParams(device.task.params),previous=device.account_configs?.[key]?.params;
    if(normalized.keep_password===true&&previous?.password){normalized.password=previous.password;delete normalized.keep_password;}
    device.account_configs={...device.account_configs,[key]:{params:normalized,applied_token_sha:device.token_sha256,updated_at:new Date(nowMs).toISOString(),...(modernSip?{config_task_id:taskId}:{})}};
  }
  if(modernSip)sipConfigurationResult(device,device.task,state,detail,nowMs);
  if (device.task.state !== state) {
    device.task.updated_at = new Date(nowMs).toISOString();
    if (state === "claimed") device.task.claimed_at = device.task.updated_at;
    if (state === "running") device.task.started_at = device.task.updated_at;
    if (["success","failed","rejected","expired"].includes(state)) device.task.completed_at = device.task.updated_at;
  }
  if(["success","failed","rejected","expired"].includes(state)) {
    for(const saved of [...Object.values(device.account_configs||{}),...Object.values(device.system_targets||{})])
      if(saved.restore?.task_id===taskId)settleRestore(saved,state,detail,result);
  }
  device.task.state = state;
  device.task.detail = detail == null ? "" : String(detail).slice(0, 200);
  if (scan) device.wifi_scan = scan;
  if (contacts) device.contacts = contacts;
  if (lost) mergeLostMode(device,lost,nowMs);
  if(["set_lost_mode","wipe_data",...LOST_MESSAGE_TASK_TYPES].includes(device.task.type) && ["success","failed","rejected","expired"].includes(state)) device.task.params={};
  if((device.task.type==="system_config"||CONFIG_TYPES.includes(device.task.type)||device.task.type==="configure_sip"||device.task.type==="configure_zello") && ["success","failed","rejected","expired"].includes(state)) device.task.params={};
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
      text: String(result.text || "").slice(0, ["system_config","root_exec","file_manage","configure_sip","configure_zello"].includes(device.task.type) ? 16000 : 2048),
      ...(["system_config","root_exec","file_manage","configure_sip","configure_zello"].includes(device.task.type) ? {exit_code:Number.isInteger(result.exit_code)?result.exit_code:null,elapsed_ms:Math.max(0,Number(result.elapsed_ms)||0)} : {}),
      stage: String(result.stage || "").slice(0, 16),
      action: String(result.action || "").slice(0, 40),
      reason: String(result.reason || "").slice(0, 80),
      verified: device.task.type==='locate_now' ? false : result.verified === true
    };
  }
  return device;
}

export function lostModeParams(value={}) {
  if(typeof value?.enabled!=="boolean") throw new Error("丢失模式状态无效");
  const message=typeof value.message==="string"?value.message.trim():"";
  if(value.enabled && value.cancel_auto!==true && (!message || message.length>300 || message.includes('\0'))) throw new Error("请填写不超过300字的锁屏文字");
  const out={enabled:value.enabled,message:value.enabled?message:""};
  if(value.version===2){
    const password=value.password??'';
    if(typeof password!=='string'||(password!==''&&!/^[A-Za-z0-9]{4,32}$/.test(password)))throw new Error('密码须为4至32位数字或英文字母');
    if(typeof value.auto_wipe_enabled!=='boolean')throw new Error('自毁开关无效');
    const hours=value.timeout_hours??24;if(!Number.isInteger(hours)||hours<1||hours>168)throw new Error('清除时限须为1至168小时');
    Object.assign(out,{version:2,password,auto_wipe_enabled:value.cancel_auto?false:value.enabled&&value.auto_wipe_enabled,timeout_hours:hours});
    if(value.cancel_auto===true)out.cancel_auto=true;
    if(value.expected_revision!==undefined){if(typeof value.expected_revision!=='string'||!/^(initial|[a-f0-9-]{36})$/.test(value.expected_revision))throw Error('策略版本无效');out.expected_revision=value.expected_revision;}
  }
  return out;
}
export function normalizeLostMode(value) {
  if(!value) return null;
  if(value.version===2&&value.state==='unknown')return {version:2,state:'unknown'};
  const params=lostModeParams({enabled:value.enabled,message:value.message});
  if(!["pending","enabled","disabled"].includes(value.state) || (value.state!=="pending" && (value.state==="enabled")!==params.enabled)) throw new Error("丢失模式回执无效");
  const out={...params,state:value.state};
  if(value.version===2){
    const deadline=Number(value.deadline_at)||0;
    if(!Number.isSafeInteger(deadline)||deadline<0)throw new Error('清除时间无效');
    Object.assign(out,{version:2,auto_wipe_enabled:value.auto_wipe_enabled===true,timeout_hours:Math.max(1,Math.min(168,Number(value.timeout_hours)||24)),deadline_at:deadline,
      trigger:['offline','unpaired','manual'].includes(value.trigger)?value.trigger:'',wipe_state:['armed','started','failed'].includes(value.wipe_state)?value.wipe_state:'idle',locked:value.locked===true,restored:value.restored===true,revision:typeof value.revision==='string'&&/^(initial|[a-f0-9-]{36})$/.test(value.revision)?value.revision:'',clock_rebased:value.clock_rebased===true});
  }
  if(value.version===2&&Number.isSafeInteger(value.revision_seq)&&value.revision_seq>=0)out.revision_seq=value.revision_seq;
  return out;
}
export function mergeLostMode(device,lost,observedAt=Date.now()){
  const previous=device.lost_mode;
  if(lost.state!=='unknown'&&previous&&Number.isSafeInteger(previous.revision_seq)&&(!Number.isSafeInteger(lost.revision_seq)||lost.revision_seq<previous.revision_seq))return;
  if(previous&&lost.revision===previous.revision&&observedAt<(device.lost_mode_observed_at||0))return;
  device.lost_mode=lost.state==='unknown'?{...previous,...lost}:lost;device.lost_mode_observed_at=observedAt;
}
export function wipeParams(value={}) {
  if(value.phrase!=='擦除数据'||typeof value.confirmation_id!=='string'||!/^[a-f0-9-]{36}$/.test(value.confirmation_id))throw new Error('请完成两次擦除确认');
  return {phrase:'擦除数据',confirmation_id:value.confirmation_id,...(typeof value.expected_revision==='string'?{expected_revision:value.expected_revision}:{})};
}
export function prepareWipe(device,phrase,now=Date.now()){
  if(phrase!=='擦除数据')throw new Error('请输入“擦除数据”');
  if(device.managed_lost_v2!==true||device.managed_wipe_v1!==true||device.managed_lost_safety_v1!==true)throw new Error('请先更新客户端的丢失模式安全修复');
  if(!device.lost_mode?.revision||device.lost_mode.state==='unknown')throw Error('请先确认设备当前策略');
  const seen=Date.parse(device.last_seen);if(!Number.isFinite(seen)||now-seen>120000)throw new Error('请先确认设备在线后再清除');
  device.wipe_confirmation={id:crypto.randomUUID(),expires_at:now+120000,revision:device.lost_mode?.revision||null};
  return {...device.wipe_confirmation};
}
export function authorizeWipe(device,params,now=Date.now()){
  const p=wipeParams(params),c=device.wipe_confirmation;
  if(device.managed_wipe_v1!==true||!c||c.id!==p.confirmation_id||c.expires_at<=now)throw new Error('擦除确认已失效，请重新确认');
  if(device.managed_lost_safety_v1&&(!c.revision||c.revision!==device.lost_mode?.revision))throw Error("设备策略已改变，请重新确认");
  return c.expires_at;
}
export function configParams(type,value={}) {
  if(type==='contacts_read') return {};
  if(type==='connect_wifi') {
    if(!value||typeof value!=='object'||Array.isArray(value)
        ||Object.keys(value).length!==2||!Object.hasOwn(value,'ssid')||!Object.hasOwn(value,'password'))
      throw new Error('Wi-Fi 连接参数只能包含名称和密码');
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
    type_label: task.sip_destination?'配置SIP账号':repairTypeLabel(task.type || ""),
    state: task.state || "",
    label: repairStateLabel(task.state || ""),
    detail: task.detail || "",
    ...(task.network?{network:publicNetwork(task)}:{}),
    ...(task.sip_destination?{sip_destination:task.sip_destination}:{}),
    ...(task.type==='root_exec'&&task.params&&typeof task.params.command==='string'?{params:{command:task.params.command.slice(0,2000)}}:{}),
    ...(['send_file','get_file'].includes(task.type)&&task.params?{params:{path:task.params.path,allow_cellular:task.params.allow_cellular,...(task.type==='send_file'?{transfer_id:task.params.transfer_id,overwrite:task.params.overwrite}:{})}}:{}),
    expires_at: task.expires_at || 0,
    created_at: task.created_at || null,
    claimed_at: task.claimed_at || null,
    started_at: task.started_at || null,
    completed_at: task.completed_at || null,
    result: r ? (task.type===PIXEL_COMPANION_TASK_TYPE ? {
      stage:r.stage,action:r.action,state:r.state,units_enabled:r.units_enabled,
      rollback_available:r.rollback_available,legacy_modules:r.legacy_modules,
      ...(r.units&&r.legacy?{units:{charge:r.units.charge,audio:r.units.audio,adb_tcp:r.units.adb_tcp},legacy:{
        charge_bypass:{installed:r.legacy.charge_bypass.installed,disabled:r.legacy.charge_bypass.disabled,recognized:r.legacy.charge_bypass.recognized},
        sip_audio_access:{installed:r.legacy.sip_audio_access.installed,disabled:r.legacy.sip_audio_access.disabled,recognized:r.legacy.sip_audio_access.recognized}
      }}:{})
    } : {
      sha256: r.sha256 || "",
      bytes: r.bytes || 0,
      truncated: !!r.truncated,
      artifact: r.artifact || null,
      text: r.text || "",
      ...(["system_config","root_exec","file_manage","configure_sip","configure_zello"].includes(task.type) ? {exit_code:r.exit_code??null,elapsed_ms:r.elapsed_ms||0}:{}),
      stage: r.stage || "",
      action: r.action || "",
      reason: r.reason || "",
      verified: r.verified === true
      ,...(r.network_transaction?{network_transaction:r.network_transaction}:{})
      ,...(r.contacts_page?{contacts_page:r.contacts_page}:{})
      ,...(Object.hasOwn(r,'proxy')?{proxy:r.proxy}:{})
    }) : null
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
    ...(isNetworkTask(task)?{request_digest:task.request_digest}:{}),
    ...(task.cancel_requested ? {cancel_requested:true} : {})
  };
}
