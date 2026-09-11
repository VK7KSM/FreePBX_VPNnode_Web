// 应用目标和稳定账号标识组成键；密码只存在私有配置中。
const targets=new Set(['linphone','nexui','quik']);
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(value);
export function sipDestination(p={}) {
  if(p.target===undefined&&p.account_id===undefined)return null;
  if(!targets.has(p.target)||!id(p.account_id))throw Error('SIP配置目标或账号标识无效');
  return {target:p.target,account_id:p.account_id};
}
export const sipKey=p=>'sip:'+p.target+':'+p.account_id;
export function normalizeSipTargets(rows){
  if(!Array.isArray(rows)||rows.length>3)throw Error('SIP目标列表无效');
  const seen=new Set();
  return rows.map(row=>{
    if(!row||!targets.has(row.target)||seen.has(row.target)||!Array.isArray(row.accounts)||row.accounts.length>32)throw Error('SIP目标声明无效');
    seen.add(row.target);const accounts=new Set();
    return {target:row.target,label:String(row.label||row.target).slice(0,80),auth_username_supported:row.auth_username_supported===true,accounts:row.accounts.map(a=>{
      if(!a||!id(a.account_id)||accounts.has(a.account_id))throw Error('SIP账号声明无效');
      accounts.add(a.account_id);return {account_id:a.account_id,label:String(a.label||a.account_id).slice(0,80)};
    })};
  });
}
export function sipAllowed(d,p){
  if(d.managed_sip_account!==true)return false;
  const dest=sipDestination(p);
  if(!dest)return !Array.isArray(d.sip_targets);
  return !!d.sip_targets?.find(t=>t.target===dest.target)?.accounts.some(a=>a.account_id===dest.account_id);
}
export function checkSipTarget(d,p){
  if(!sipAllowed(d,p))throw Error('设备尚未声明此SIP配置目标或账号');
  if(p.target&&d.sip_targets.find(t=>t.target===p.target).auth_username_supported!==true&&p.auth_username!==undefined&&p.auth_username!==p.username)throw Error('此配置目标不支持独立认证账号');
}
export function redactSipText(d,text){
  let value=String(text||'');
  const passwords=[d.task?.params?.password,...Object.values(d.account_configs||{}).map(a=>a.params?.password)].filter(p=>typeof p==='string'&&p);
  for(const p of passwords)value=value.split(p).join('[已隐藏]').split(encodeURIComponent(p)).join('[已隐藏]');
  return value.slice(0,200);
}
function registration(d,row,now){
  const dest=sipDestination(row);if(!dest||!sipAllowed(d,dest))throw Error('SIP注册状态目标无效');
  if(!['registered','registering','unregistered','failed','unknown'].includes(row.state)||!Number.isSafeInteger(row.sampled_at)||row.sampled_at<0||row.sampled_at>now+60000)throw Error('SIP注册状态无效');
  if(row.config_task_id!==undefined&&!/^[a-zA-Z0-9-]{1,64}$/.test(row.config_task_id))throw Error('SIP配置关联无效');
  return {...dest,state:row.state,reason:redactSipText(d,row.reason),sampled_at:row.sampled_at,config_task_id:row.config_task_id||null};
}
export function applySipRegistrations(d,rows,now){
  if(!Array.isArray(rows)||rows.length>96)throw Error('SIP注册状态列表无效');
  const seen=new Set(),normalized=rows.map(row=>{
    const r=registration(d,row,now),key=sipKey(r);if(seen.has(key))throw Error('SIP注册状态重复');seen.add(key);return r;
  });
  d.sip_registrations={...d.sip_registrations};
  for(const r of normalized){
    const key=sipKey(r),saved=d.account_configs?.[key],old=d.sip_registrations[key];
    // 旧配置、旧采样的晚到回执不能覆盖新配置的状态。
    if(saved&&r.config_task_id!==saved.config_task_id)continue;
    if(old&&old.installation_sha===d.token_sha256&&old.config_task_id===r.config_task_id&&old.sampled_at>=r.sampled_at)continue;
    d.sip_registrations[key]={...r,installation_sha:d.token_sha256};
  }
}
export function validateSipResult(d,state,result){
  const dest=d.task.sip_destination;if(!dest)return false;
  if(['success','failed','rejected'].includes(state)){
    if(!result||result.target!==dest.target||result.account_id!==dest.account_id)throw Error('SIP结果与目标账号不匹配');
    if(state==='success'&&(result.applied!==true||result.action!=='completed'||result.exit_code!==0))throw Error('缺少SIP配置写入证据');
  }
  return true;
}
export function sipConfigurationResult(d,task,state,detail,now){
  const key=sipKey(task.sip_destination);
  d.sip_account_results={...d.sip_account_results,[key]:{task_id:task.id,state,detail:redactSipText(d,detail),at:new Date(now).toISOString()}};
}
export function publicSipAccounts(d,online,now=Date.now()){
  if(!Array.isArray(d.sip_targets))return [];
  const windowMs=(d.network==='wifi'||d.network==='ethernet'?15:60)*60000+90000;
  return d.sip_targets.flatMap(t=>t.accounts.map(a=>{
    const dest={target:t.target,account_id:a.account_id},key=sipKey(dest),saved=d.account_configs?.[key],p=saved?.params;
    const current=d.task?.sip_destination;
    const active=current&&sipKey(current)===key?{task_id:d.task.id,state:d.task.state,detail:redactSipText(d,d.task.detail),at:d.task.completed_at||d.task.updated_at||d.task.created_at}:null;
    const r=d.sip_registrations?.[key],matches=(!saved||r?.config_task_id===saved.config_task_id)&&!(active&&['pending','claimed','running'].includes(active.state));
    return {...dest,label:a.label,target_label:t.label,configuration:p?{server:p.server,username:p.username,auth_username:p.auth_username,transport:p.transport,port:p.port,...(p.realm!==undefined?{realm:p.realm}:{}),updated_at:saved.updated_at}:null,
      configuration_result:active||d.sip_account_results?.[key]||null,
      registration:r?{target:r.target,account_id:r.account_id,state:r.state,reason:r.reason,sampled_at:r.sampled_at,config_task_id:r.config_task_id,fresh:!!online&&matches&&r.installation_sha===d.token_sha256&&r.sampled_at+windowMs>now}:null};
  }));
}
