import { contactState } from './elfRemote/control-plane.js';
import { pushState, pendingStatus, statusNotification, brokerCall } from './push-control.js';

export const PROBE_WAIT_MS = 90000;
// 一分钟调度可能跨过等待边界，给两次尝试及调度抖动留出有限窗口。
const CHECK_WINDOW_MS = 360000;
export function recoveryContact(device, now = Date.now()) {
  const contact = contactState(device.last_seen, now, device.status_only === true, device.network);
  if (device.enabled === false || device.status_only !== true || contact.state !== 'report_overdue') return contact;
  const probe = device.report_probe;
  const deadline = Date.parse(contact.report_due_at) + 90000;
  if (probe?.baseline === device.last_seen && probe.state === 'failed') return contact;
  if (probe?.baseline === device.last_seen && probe.attempts > 0 && now < deadline + CHECK_WINDOW_MS) return { ...contact,
    state: probe?.baseline === device.last_seen && probe.received ? 'awaiting_full_report' : 'checking_connection' };
  return contact;
}

// 在既有存储事务中准备；外部MQTT发布只能在事务提交后执行。
export async function prepareRecovery(storage, devices, now = Date.now()) {
  const outgoing = [];
  for (const device of devices) {
    if (device.enabled === false || device.status_only !== true) continue;
    const contact = contactState(device.last_seen, now, true, device.network);
    if (contact.state !== 'report_overdue') { delete device.report_probe; continue; }
    let probe = device.report_probe;
    if (!probe || probe.baseline !== device.last_seen) {
      probe = device.report_probe = { baseline: device.last_seen, attempts: 0, state: 'checking', next_at: now };
    }
    if (probe.state === 'failed') continue;
    const pending = await pendingStatus(storage, device.id, now);
    probe.received = pending?.request_id === probe.request_id && !!pending?.received_at;
    if (now < probe.next_at) continue;
    if (probe.attempts >= 2) { probe.state = 'failed'; continue; }
    const response = await pushState(storage, new Request('https://elf-store/__push/prepare', {
      method: 'POST', body: JSON.stringify({device_id: device.id})
    }), async () => devices, now);
    if (!response.ok) { probe.state = 'failed'; continue; }
    const prepared = await response.json();
    probe.request_id = prepared.request.request_id;
    // 计数在联网前落盘，定时任务重入或发布故障也不能无限重试。
    probe.attempts++;
    probe.next_at = now + PROBE_WAIT_MS;
    if (prepared.should_publish) outgoing.push({ device_id: device.id, ...prepared });
  }
  return outgoing;
}

export async function runRecovery(env, stub) {
  if (!stub) throw new Error('缺少设备存储');
  const response = await stub.fetch('https://elf-store/__recovery', {method:'POST'});
  if (!response.ok) throw new Error('超时检查准备失败');
  const {outgoing} = await response.json();
  const run = {started_at:new Date().toISOString(), prepared:outgoing.length, accepted:0, failed:0};
  await Promise.all(outgoing.map(async item => {
    let accepted = false;
    try {
      const result = await brokerCall(env, '/v1/publish', {username:item.username, notification:statusNotification(item.request)});
      accepted = result.accepted === true && result.request_id === item.request.request_id;
    } catch { /* 已记录本次尝试，下一轮有界重试。 */ }
    const recorded = await stub.fetch('https://elf-store/__push/delivery', {method:'POST', body:JSON.stringify({
      device_id:item.device_id, request_id:item.request.request_id,
      attempt_at_ms:item.request.last_publish_at_ms, accepted
    })});
    if (!recorded.ok) throw new Error('补拉发送结果保存失败');
    if (accepted) run.accepted++; else run.failed++;
  }));
  run.completed_at = new Date().toISOString();
  const saved = await stub.fetch('https://elf-store/report_recovery_run', {method:'PUT',body:JSON.stringify(run)});
  if (!saved.ok) throw new Error('定时检查结果保存失败');
}
