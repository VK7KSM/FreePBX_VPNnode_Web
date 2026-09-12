// 原任务内网络确认；服务端允许与设备持久终态分开保存。
const hash=/^[a-f0-9]{64}$/;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const plain=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const terminal=new Set(['CONFIRMED','UNCHANGED','ROLLED_BACK','ORIGINAL_OBSERVED','ABORTED']);
const statuses=new Set([...terminal,'AWAITING_CONFIRM','NEEDS_ATTENTION','UNKNOWN']);
const fail=message=>{throw Error(message);};
export function d31Device(d){return d?.model_id==='mdl_d31'||d?.update_channel==='d31'||d?.hardware_identity?.variant==='d31'||String(d?.model_name||'').toLowerCase()==='d31'||d?.client_package==='net.elfradio.d31bootstrap';}
export function networkParams(p){
 if(!plain(p)||p.version!==1||!hash.test(p.apk_sha256||'')||!Number.isInteger(p.confirm_within_ms)||p.confirm_within_ms<10000||p.confirm_within_ms>120000)fail('网络事务参数无效');
 return {version:1,apk_sha256:p.apk_sha256,confirm_within_ms:p.confirm_within_ms};
}
export function isNetworkTask(task){return task?.type==='system_config'&&task.params?.group==='wifi'&&task.params?.action==='set'&&task.params?.key==='enabled'&&!!task.params.network_transaction;}
export function networkAllowed(d){return d31Device(d)&&d.managed_system_settings===true&&d.managed_network_confirmation_v1===true&&d.network_write===true;}
export function networkAcceptanceAllowed(d,p,raw,now=Date.now()){
 if(!d31Device(d)||d?.managed_system_settings!==true||d?.managed_network_confirmation_v1!==true)return false;
 try{const v=JSON.parse(raw||'null');return plain(v)&&v.device_id===d.id&&hash.test(v.apk_sha256||'')&&v.apk_sha256===p?.network_transaction?.apk_sha256&&integer(v.expires_at)&&now<v.expires_at&&v.expires_at-now<=86400000;}catch{return false;}
}
export function holdNetworkTask(t){return isNetworkTask(t)&&['claimed','running'].includes(t.state);}
export async function localNetworkId(deviceId,taskId){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(deviceId+':'+taskId));return [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');}
function binding(task,v){
 if(!plain(v)||!hash.test(v.task_id||'')||v.task_id!==task.network?.local_task_id||v.apk_sha256!==task.params.network_transaction.apk_sha256||v.key!=='wifi_enabled'||typeof v.before!=='boolean'||v.target!==task.params.value||!uuid.test(v.boot_id||'')||!integer(v.started_elapsed)||!integer(v.deadline_elapsed)||v.window_ms!==task.params.network_transaction.confirm_within_ms||v.deadline_elapsed-v.started_elapsed!==v.window_ms)fail('网络事务绑定不匹配');
 const b={task_id:v.task_id,apk_sha256:v.apk_sha256,key:v.key,before:v.before,target:v.target,boot_id:v.boot_id,started_elapsed:v.started_elapsed,deadline_elapsed:v.deadline_elapsed,window_ms:v.window_ms};
 if(task.network.binding&&JSON.stringify(task.network.binding)!==JSON.stringify(b))fail('原网络事务不可改绑');
 return b;
}
export async function prepareNetworkTask(d,t,acceptance=false){
 if(!isNetworkTask(t))return;
 if(!networkAllowed(d)&&!(acceptance&&d31Device(d)&&d.managed_system_settings===true&&d.managed_network_confirmation_v1===true))fail('设备网络事务尚未接通');
 t.network={version:1,local_task_id:await localNetworkId(d.id,t.id),credential_sha:d.token_sha256};
}
export function checkNetworkCredential(d,t){if(!t.network?.credential_sha||t.network.credential_sha!==d.token_sha256)fail('原网络任务凭据已失效');}
export function grantNetworkConfirmation(d,t,data,now=Date.now()){
 if(!isNetworkTask(t)||t.id!==data.task_id||data.state!=='running'||t.state!=='running'||d.enabled===false||t.cancel_requested||!Number.isFinite(t.expires_at)||now>=t.expires_at)fail('网络确认原任务状态或期限无效');
 checkNetworkCredential(d,t);
 const v=data.network_confirmation;
 if(!plain(v)||v.version!==1||v.request_digest!==t.request_digest||!uuid.test(v.nonce||''))fail('网络确认摘要或随机号无效');
 const b=binding(t,v);
 if(!integer(v.last_elapsed)||!integer(v.issued_elapsed)||v.last_elapsed<b.started_elapsed||v.issued_elapsed<v.last_elapsed||v.issued_elapsed>=b.deadline_elapsed)fail('网络确认本地期限无效');
 const n=t.network,prior=n.request;
 if(n.result&&terminal.has(n.result.status))fail('设备已有网络终态');
 if(n.confirm_deadline_at!=null&&now>=n.confirm_deadline_at)fail('网络确认允许窗口已结束');
 const request={...b,issued_elapsed:v.issued_elapsed,last_elapsed:v.last_elapsed,nonce:v.nonce};
 const known=n.grants?.[v.nonce];
 if(known&&JSON.stringify(known.request)!==JSON.stringify(request))fail('同一网络随机号不可改写');
 if(!known&&Object.keys(n.grants||{}).length>=64)fail('网络确认尝试已达到上限');
 if(prior&&(v.issued_elapsed<prior.issued_elapsed||(v.nonce===prior.nonce&&JSON.stringify(prior)!==JSON.stringify(request))))fail('网络确认请求重放或改写');
 const receipt={version:1,decision:'allow',...b,issued_elapsed:v.issued_elapsed,nonce:v.nonce};
 n.binding=b;n.confirm_deadline_at??=Math.min(t.expires_at,now+b.deadline_elapsed-v.issued_elapsed);
 n.request=request;n.receipt=receipt;n.allowed_at??=now;
 n.grants={...n.grants,[v.nonce]:{request,receipt}};
 t.detail='等待设备确认网络设置';t.updated_at=new Date(now).toISOString();
 return {ok:true,device_id:d.id,task_id:t.id,request_digest:t.request_digest,network_confirmation:receipt};
}
export function cancelNetworkTask(t){
 if(t.network?.allowed_at!=null)return 'confirmation_already_issued';
 if(['pending','claimed','running'].includes(t.state))t.cancel_requested=true;
 return 'cancel_requested';
}
export function applyNetworkProgress(d,t,state,result,now){
 checkNetworkCredential(d,t);
 const v=result?.network_transaction;
 if(!v){if(['claimed','running'].includes(state)&&result==null)return null;fail('缺少设备网络事务结果');}
 if(plain(v)&&v.status==='NOT_STARTED'){
  if(v.version!==1||state!=='rejected'||v.binding!==null||v.mutation_started!==false||v.cleanup_complete!==true||v.restored!==false||v.current_enabled!==null||!integer(v.observed_elapsed)||t.network.binding||t.network.allowed_at!=null)fail('缺少网络任务未开始的证据');
  const n={version:1,status:'NOT_STARTED',binding:null,mutation_started:false,cleanup_complete:true,restored:false,current_enabled:null,observed_elapsed:v.observed_elapsed};
  if(t.network.result&&JSON.stringify(t.network.result)!==JSON.stringify(n))fail('网络终态不可改写');
  if(['success','failed','expired'].includes(t.state))fail('网络任务终态已固定');
  t.network.result=n;t.network.observed_at??=now;t.detail='网络任务未开始，未修改配置';return n;
 }
 if(!plain(v)||v.version!==1||!statuses.has(v.status)||!integer(v.observed_elapsed)||(v.current_enabled!==null&&typeof v.current_enabled!=='boolean')||typeof v.cleanup_complete!=='boolean'||typeof v.restored!=='boolean')fail('设备网络事务结果无效');
 const b=binding(t,v.binding);
 const normalized={version:1,status:v.status,binding:b,observed_elapsed:v.observed_elapsed,current_enabled:v.current_enabled,cleanup_complete:v.cleanup_complete,restored:v.restored};
 if(v.status==='CONFIRMED'){
  const r=t.network.grants?.[v.confirmation_nonce]?.receipt;
  if(!r||v.confirmation_nonce!==r.nonce||v.observed_elapsed<r.issued_elapsed||v.observed_elapsed>=b.deadline_elapsed||v.current_enabled!==b.target||v.restored)fail('缺少有效的设备网络提交证据');
  normalized.confirmation_nonce=v.confirmation_nonce;
 }
 if(v.status==='UNCHANGED'&&(b.before!==b.target||v.current_enabled!==b.before||v.restored))fail('原网络配置不匹配');
 if(v.status==='ROLLED_BACK'&&(v.current_enabled!==b.before||!v.restored))fail('缺少原网络恢复读回');
 if(v.status==='ORIGINAL_OBSERVED'&&(v.current_enabled!==b.before||v.restored))fail('原网络观察结果无效');
 const expected=v.cleanup_complete&&terminal.has(v.status)?(['CONFIRMED','UNCHANGED'].includes(v.status)?'success':'failed'):'running';
 if(state!==expected)fail('网络阶段与任务终态不匹配');
 const old=t.network.result;
 if(old&&terminal.has(old.status)&&old.status!==v.status)fail('网络终态不可改写');
 if(['success','failed','rejected','expired'].includes(t.state)){
  if(t.state!==state||JSON.stringify(old)!==JSON.stringify(normalized))fail('网络终态重复回执不一致');
  return old;
 }
 t.network.binding=b;t.network.result=normalized;
 t.network.observed_at=now;
 t.detail={CONFIRMED:v.cleanup_complete?'网络设置已确认':'网络已确认，等待清理完成',UNCHANGED:'原配置已符合，未修改',ROLLED_BACK:'已恢复原配置',ORIGINAL_OBSERVED:'原配置未改变',ABORTED:'网络设置已终止',AWAITING_CONFIRM:'等待设备确认网络设置',NEEDS_ATTENTION:'网络状态需要核查',UNKNOWN:'网络状态尚未确认'}[v.status];
 return normalized;
}
export function publicNetwork(t){
 const n=t.network;if(!n)return undefined;
 return {version:1,request_digest:t.request_digest,confirmation_issued:n.allowed_at!=null,allowed_at:n.allowed_at??null,confirm_deadline_at:n.confirm_deadline_at??null,binding:n.binding??null,result:n.result??null};
}
