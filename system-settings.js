// 系统配置复用既有设备任务与回执；不提供第二套管理入口。
const keys={sound:['media','ring','alarm','call','brightness','brightness_auto','font_scale'],time:['locale','timezone','auto_time','auto_time_zone'],network:['mobile_data','bluetooth','hotspot'],wifi:['connect'],apps:['enabled','permission','notifications','background']};
// 仅依赖已保存的读取回执；不把尚未透传的客户端 write_keys 当成协议。
export function systemSettingAllowed(device,group,key,pkg){
  if(!device)return false;
  const d31=device.model_id==='mdl_d31'||device.update_channel==='d31'||device.hardware_identity?.variant==='d31'||String(device.model_name||'').toLowerCase()==='d31'||device.client_package==='net.elfradio.d31bootstrap';
  // 当前D31已冻结的写入范围；后续网络事务必须另行冻结恢复与确认合同。
  if(d31&&!({sound:['media','ring','alarm','call','brightness','brightness_auto'],time:['auto_time','auto_time_zone','timezone'],apps:['enabled']}[group]||[]).includes(key))return false;
  const snapshot=device.system_settings&&device.system_settings[group];
  const unavailable=snapshot&&(group!=='apps'||!pkg||snapshot.package===pkg)&&snapshot.unavailable;
  const denied=name=>Array.isArray(unavailable)?unavailable.includes(name):!!unavailable&&Object.prototype.hasOwnProperty.call(unavailable,name);
  if(denied(key)||denied(key+'_write')||((group==='network'||group==='wifi')&&denied('network_write')))return false;
  if(key==='hotspot'&&snapshot&&(!snapshot.hotspot||typeof snapshot.hotspot.enabled!=='boolean'))return false;
  return true;
}
export function systemSettingsParams(p={}){
  const group=p.group,action=p.action??'read',pkg=p.package??'',offset=p.offset??0;
  if(!Object.hasOwn(keys,group)||!['read','set'].includes(action)||typeof pkg!=='string'||(pkg&&!/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/.test(pkg))||!Number.isInteger(offset)||offset<0||offset>10000)throw Error('系统配置参数无效');
  const out={group,action,package:pkg,offset};if(action==='read')return out;
  const key=p.key,v=p.value;if(!keys[group].includes(key))throw Error('该分类没有此设置');
  if(['brightness_auto','auto_time','auto_time_zone','mobile_data','bluetooth','enabled','notifications','background'].includes(key)&&typeof v!=='boolean')throw Error('开关值无效');
  if(['media','ring','alarm','call','brightness','font_scale'].includes(key)&&(!Number.isFinite(v)||(key==='font_scale'?(v<.85||v>1.5):(!Number.isInteger(v)||v<0||v>255))))throw Error('数值超出范围');
  if(key==='locale'&&(typeof v!=='string'||!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(v)))throw Error('语言无效');
  if(key==='timezone'){try{if(typeof v!=='string')throw Error();new Intl.DateTimeFormat('en',{timeZone:v});}catch{throw Error('时区无效');}}
  if(group==='apps'&&!pkg)throw Error('请先选择应用');
  if(key==='permission'&&(!v||typeof v.granted!=='boolean'||typeof v.name!=='string'||!/^[A-Za-z0-9_.]+$/.test(v.name)))throw Error('权限参数无效');
  if(key==='connect'||key==='hotspot'){
    if(!v||typeof v!=='object')throw Error('网络参数无效');
    if(key==='hotspot'&&typeof v.enabled!=='boolean')throw Error('热点开关无效');
    if(key==='connect'||v.enabled){if(typeof v.ssid!=='string'||!v.ssid||new TextEncoder().encode(v.ssid).length>32||v.ssid.includes('\0'))throw Error('网络名称无效');const password=v.password??'';
      if(typeof password!=='string'||(password!==''&&!/^[0-9a-fA-F]{64}$/.test(password)&&!/^[\x20-\x7e]{8,63}$/.test(password))||(key==='hotspot'&&!password))throw Error('网络密码格式无效');}
  }
  out.key=key;out.value=v;if(JSON.stringify(out).length>6000)throw Error('设置参数过大');return out;
}

export function applySystemSettingsResult(device,result,now){
  if(result?.exit_code!==0||result.action!=='completed'||result.truncated)throw Error('缺少系统配置完成证据');
  let snapshot;try{
    // 兼容134至136版：D22系统HTTP库会在标准输出加入这三类固定调试行。
    const text=String(result.text||'').split(/\r?\n/).filter(line=>!/^port:[0-9]+$/.test(line)&&!/^\[OkHttp\] sendRequest(?:>>|<<)$/.test(line)).join('\n');
    snapshot=JSON.parse(text);result.text=JSON.stringify(snapshot);
  }catch{throw Error('系统配置结果无法读取');}
  if(device.task.state==='success')return;
  const p=device.task.params;if(snapshot.group!==p.group||!Number.isFinite(snapshot.sampled_at)||(p.action==='set'&&snapshot.applied!==true))throw Error('系统配置结果与任务不匹配');
  device.system_settings={...device.system_settings,[p.group]:{...snapshot,received_at:now}};
  if(p.action==='set') {
    const params=systemSettingsParams(p),id=systemSettingId(params);
    const all=device.system_targets??={},previous=all[id];
    // 空密码表示使用设备已有网络，不覆盖服务器保存的同名有效密码。
    if(params.key==='connect'&&!params.value.password&&previous?.params.value.ssid===params.value.ssid)
      params.value={...params.value,password:previous.params.value.password??''};
    const same=previous&&JSON.stringify(previous.params)===JSON.stringify(params);
    all[id]={params,revision:same?previous.revision:(previous?.revision??0)+1,applied_token_sha:device.token_sha256,updated_at:now};
    device.system_targets=all;
  }
}

export function systemSettingId(p){return [p.group,p.package||'',p.key,p.key==='permission'?p.value.name:''].join('|');}
