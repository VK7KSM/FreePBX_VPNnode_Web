export const FAULT_HEX = /^[a-f0-9]{64}$/;
export function faultRequire(ok, reason) { if (!ok) throw Error(reason); }
export function faultTarget(device) {
  faultRequire(device && device.model_id === 'mdl_d31' && device.enabled !== false && device.managed_exec_tasks === true && device.managed_file_return === true, '该设备尚未提供故障取回能力');
  faultRequire(/^[A-Za-z0-9_-]{1,96}$/.test(device.id) && /^[0-9A-Za-z._-]{1,64}$/.test(String(device.app_version)), '设备身份或版本无效');
  return {deviceId:device.id, expectedVersion:String(device.app_version)};
}
export function faultCommand(apk,args) {
  faultRequire(/^\/data\/local\/d31-remote\/releases\/[a-f0-9]{64}\/remote\.apk$/.test(apk), '活动客户端路径无效');
  faultRequire(args.every(a=>/^[a-z0-9-]+$/.test(String(a))), '故障命令参数无效');
  return {cwd:'/',timeout:60,command:`CLASSPATH='${apk}' /system/bin/app_process /system/bin net.elfradio.d31bootstrap.faults.FaultCommand ${args.join(' ')}`};
}
export function faultReceipt(r,eventId) {
  faultRequire(r?.schemaVersion===1 && r.kind==='FAULT_EVENT_EXPORT' && r.state==='EXPORTED' && r.eventId===eventId && FAULT_HEX.test(eventId), '故障包回执身份不符');
  faultRequire(Number.isSafeInteger(r.bytes)&&r.bytes>0&&r.bytes<=8388608&&FAULT_HEX.test(r.sha256)&&FAULT_HEX.test(r.manifestSha256)&&[1,2].includes(r.exportNumber), '故障包回执摘要或长度无效');
  faultRequire(r.path===`/data/local/d31-remote/faults/${eventId}/exports/export-${r.exportNumber}/bundle.zip`, '故障包路径不符');
  return r;
}
export function faultPending(value) {
  faultRequire(value?.kind==='FAULT_PENDING_INDEX'&&Array.isArray(value.events)&&value.events.length<=16&&typeof value.hasMore==='boolean', '故障分页响应无效');
  const ids=new Set();
  for(const row of value.events){faultRequire(FAULT_HEX.test(row.eventId)&&!ids.has(row.eventId),'故障事件编号无效');ids.add(row.eventId);}
  faultRequire(!value.hasMore || (FAULT_HEX.test(value.nextAfter)&&value.events.length>0&&value.nextAfter===value.events.at(-1).eventId),'故障分页游标无效');
  return value;
}
// 与宿主队列一致：先持久化请求，恢复只查原号；权威不存在时才同号补交。
export async function faultTask({state,key,type,params,save,request,now=Date.now,uuid=()=>crypto.randomUUID(),beforeSend=async()=>{}}) {
  state.tasks ||= {};
  let op=state.tasks[key];
  if(!op){op=state.tasks[key]={request:{device_id:state.target.deviceId,id:'d31-fault-'+uuid(),type,params,expires_at:now()+600000}};await save();}
  faultRequire(op.request.device_id===state.target.deviceId&&op.request.type===type&&JSON.stringify(op.request.params)===JSON.stringify(params)&&/^d31-fault-[a-f0-9-]{36}$/.test(op.request.id)&&Number.isSafeInteger(op.request.expires_at), '持久任务与当前目标不符');
  if(op.task)return faultTaskResult(op.task,type);
  const q=new URLSearchParams({device_id:state.target.deviceId,task_id:op.request.id});
  const response=await request('/api/elfremote/tasks?'+q,null,true);
  let task=response?.task;
  if(response===null){
    faultRequire(now()<op.request.expires_at,'原任务已过期，停止自动补交');
    await beforeSend();const result=await request('/api/elfremote/task',op.request);task=result.task;
  }
  faultRequire(task&&task.id===op.request.id&&task.type===type,'返回任务身份不符');
  if(['pending','claimed','running'].includes(task.state)){faultRequire(now()<=op.request.expires_at+60000,'原任务过期但结果未确认');return null;}
  op.task=task;await save();return faultTaskResult(task,type);
}
export function faultTaskResult(task,type) {
  faultRequire(task.state==='success'&&task.result&&task.result.truncated!==true,'设备任务失败或结果被截断');
  if(type!=='root_exec')return task.result;
  faultRequire(task.result.exit_code===0&&typeof task.result.text==='string'&&task.result.text.length<=16000,'设备命令失败或输出超限');
  let value;try{value=JSON.parse(task.result.text);}catch{throw Error('设备结果不是完整JSON');}
  return value;
}
export function faultArchiveResult(ack,r) {
  faultRequire(ack?.state==='ARCHIVED'&&ack.eventId===r.eventId&&ack.sha256===r.sha256&&ack.bytes===r.bytes&&ack.manifestSha256===r.manifestSha256&&ack.originalsDeleted===false&&ack.releasedBytes===0&&ack.activeSlotReleased===true,'归档回执不完整，仍待核验');
}
export function faultArchiveQuery(q,r) {
  faultRequire(q?.eventId===r.eventId&&q.export?.archived===true&&q.export.state==='EXPORTED'&&q.export.receipt?.sha256===r.sha256&&q.export.receipt.bytes===r.bytes&&q.export.receipt.manifestSha256===r.manifestSha256,'独立查询尚未确认同一故障包归档');
}
export function faultNumber(n){return Number.isSafeInteger(n)&&n>=0?String(n):'未知';}
export function faultCapacitySummary(x) {
  const n=faultNumber, continuous=x.admissionPolicy==='IN_FLIGHT_AND_RETAINED_BUDGETS';
  const limits={ACTIVE_EVENT_LIMIT:'未归档事件名额已满',COLLECTING_EVENT_LIMIT:'在途采集名额已满',RETAINED_EVENT_LIMIT:'保留事件已满',ACTIVE_RESERVATION_LIMIT:'采集空间预留不足',ARCHIVE_BYTE_LIMIT:'原件总字节上限',EXPORT_HEADROOM_LIMIT:'导出预留空间不足',FREE_SPACE_RESERVE:'剩余空闲空间不足'};
  return [
    continuous?`采集中 ${n(x.collectingEvents)} / ${n(x.maxCollectingEvents)}　采完待归档 ${n(x.awaitingArchiveEvents)}　未归档合计 ${n(x.activeEvents)}`:`未归档 ${n(x.activeEvents)} / ${n(x.maxActiveEvents)}　采集中 ${n(x.collectingEvents)}　采完待归档 ${n(x.awaitingArchiveEvents)}`,
    `已归档 ${n(x.archivedEvents)}　保留 ${n(x.retainedEvents)} / ${n(x.maxRetainedEvents)}　原件 ${n(x.retainedBytes)} / ${n(x.maxArchiveBytes)} 字节`,
    `采集策略：${continuous?'在途采集与保留容量分别限制':x.admissionPolicy==='UNARCHIVED_EVENT_LIMIT'?'按未归档事件数限制':'未知'}　索引错误 ${n(x.eventIndexErrors)}`,
    `限制：${Array.isArray(x.admissionBlockedBy)?x.admissionBlockedBy.map(k=>limits[k]||k).join(' / ')||'未报告':'未知'}`,
    `后续处理：${x.continuationAction==='NONE'?'未要求额外处理':x.continuationAction==='HOST_VERIFY_EXPORT_AND_ACK_OR_RETAINED_CAPACITY_REVIEW'?'先取回验包并确认归档；若仍受保留数量或原件字节限制，需检查保留容量':'未知'}　未采集源可能过期：${x.uncollectedSourcesMayExpire===true?'是':x.uncollectedSourcesMayExpire===false?'否':'未知'}`,
    '归档不删除设备原件，不释放保留数量或原件字节。'
  ];
}
