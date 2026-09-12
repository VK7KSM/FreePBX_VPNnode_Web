import {archiveRepair} from './elfRemote/control-plane.js';

export function deviceModelKey(name) {
  return String(name || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
}

export function registrationModel(models,data,identity) {
  const explicit=String(data.model_id || '').trim();
  const key=deviceModelKey(identity?.variant || data.model_hint || 'D22');
  const matches=models.filter(model=>explicit ? model.id===explicit
    : model.registration_key===key || deviceModelKey(model.name)===key);
  if(matches.length!==1)throw new Error('请先在“添加型号”中添加对应型号，或传入准确的model_id');
  const model=matches[0];
  if(identity && model.registration_key!==deviceModelKey(identity.variant) && deviceModelKey(model.name)!==deviceModelKey(identity.variant))
    throw new Error('设备身份与注册型号不一致');
  return model;
}

export function normalizeDeviceIdentity(value, models = []) {
  if (value == null) return null;
  const variant=deviceModelKey(value.variant),kind=value.kind,source=value.source;
  const knownSources={nvdata_wifi:'wifi_factory_mac',sysfs_eth0_permanent:'ethernet_factory_mac'};
  if(!variant || variant.length>64 || !['wifi_factory_mac','ethernet_factory_mac'].includes(kind)
    || typeof source!=='string' || !/^[a-z][a-z0-9_]{0,63}$/.test(source)
    || (knownSources[source] ? knownSources[source]!==kind : !/(^|_)(factory|permanent)(_|$)/.test(source)))
    throw new Error('设备身份来源无效');
  const mac=String(value.value || '').replace(/[:-]/g,'').toLowerCase();
  if (!/^[0-9a-f]{12}$/.test(mac) || (parseInt(mac.slice(0,2),16)&3)!==0 || /^0+$/.test(mac)) throw new Error('设备地址无效');
  const matches=models.filter(model=>model.registration_key===variant || deviceModelKey(model.name)===variant);
  if(matches.length>1)throw new Error('型号名称存在歧义，请先修改重复的型号名称');
  return {variant:matches[0]?.registration_key || variant,kind,source,value:mac.match(/../g).join(':')};
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
  const runtime=['task','update','last_seen','last_reported_at','last_report_clock_invalid','online','battery','battery_present','charging','network','ip','loc','traffic','ready','maintenance','report_probe','app_version','os_version','wifi_scan','contacts','alarm','lost_mode'];
  for (const k of Object.keys(device)) if (runtime.includes(k) || k.startsWith('managed_')) delete device[k];
  delete device.network_write;
  delete device.contacts_page_snapshot;
  Object.assign(device,{token_sha256:tokenSha,installation_id:crypto.randomUUID(),status_only:true});
  await storage.delete('push/request/'+encodeURIComponent(device.id));
  return device;
}
