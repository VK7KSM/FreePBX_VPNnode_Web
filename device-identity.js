import {archiveRepair} from './elfRemote/control-plane.js';

export function normalizeDeviceIdentity(value) {
  if (value == null) return null;
  const d22 = value.variant === 'd22' && value.kind === 'wifi_factory_mac' && value.source === 'nvdata_wifi';
  const d31 = value.variant === 'd31' && value.kind === 'ethernet_factory_mac' && value.source === 'sysfs_eth0_permanent';
  if (!d22 && !d31) throw new Error('设备身份来源无效');
  const mac=String(value.value || '').replace(/[:-]/g,'').toLowerCase();
  if (!/^[0-9a-f]{12}$/.test(mac) || (parseInt(mac.slice(0,2),16)&3)!==0 || /^0+$/.test(mac)) throw new Error('设备地址无效');
  return {variant:value.variant,kind:value.kind,source:value.source,value:mac.match(/../g).join(':')};
}

export async function restoreDeviceIdentity(storage,devices,identity,tokenSha,now) {
  if (await storage.get('retired-device-token/'+tokenSha)) throw new Error('旧安装凭证已失效');
  if (!identity) return null;
  const matches=devices.filter(d=>d.hardware_identity?.variant===identity.variant
    && d.hardware_identity?.kind===identity.kind && d.hardware_identity?.source===identity.source
    && d.hardware_identity?.value===identity.value);
  if (matches.length!==1) return null;
  const device=matches[0];
  await storage.put('retired-device-token/'+device.token_sha256,{retired_at:new Date(now).toISOString()});
  if (device.task) {
    if (['pending','claimed','running'].includes(device.task.state)) {
      device.task.state='expired';device.task.detail='设备已重新安装，旧任务不再执行';device.task.completed_at=new Date(now).toISOString();
    }
    await archiveRepair(storage,device,now);
  }
  if (device.update?.job_id) await storage.put('installation-update/'+device.id+'/'+device.update.job_id,device.update);
  const runtime=['task','update','last_seen','last_reported_at','last_report_clock_invalid','online','battery','charging','network','ip','loc','traffic','ready','maintenance','report_probe','app_version','os_version','wifi_scan','contacts','alarm','lost_mode'];
  for (const k of Object.keys(device)) if (runtime.includes(k) || k.startsWith('managed_')) delete device[k];
  Object.assign(device,{token_sha256:tokenSha,installation_id:crypto.randomUUID(),status_only:true});
  await storage.delete('push/request/'+encodeURIComponent(device.id));
  return device;
}
