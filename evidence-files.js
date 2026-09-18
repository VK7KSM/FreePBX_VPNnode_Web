import {findRepairTask} from './elfRemote/control-plane.js';
export const EVIDENCE_MAX=8*1024*1024;
const indexKey=(device,task)=>'task-evidence/'+encodeURIComponent(device)+'/'+encodeURIComponent(task);
const roles=['request','receipt','report','observation','firmware','firmware_generation'];
export async function initEvidence(storage,device,data,now){
  const e=data.evidence;
  if(data.size<1||data.size>EVIDENCE_MAX)throw Error('证据文件须为1字节至8 MB');
  if(!e||typeof e.task_id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(e.task_id)||!/^[a-f0-9]{64}$/.test(e.diagnostic_id||'')||!roles.includes(e.role)||typeof e.fixture!=='boolean')throw Error('证据关联字段无效');
  const task=await findRepairTask(storage,device,e.task_id);
  if(!task||task.type!=='root_exec')throw Error('须关联此设备已有的诊断命令任务');
  const evidence={task_id:e.task_id,diagnostic_id:e.diagnostic_id,role:e.role,fixture:e.fixture};
  if(e.source_return_task_id!==undefined){
    const source=await findRepairTask(storage,device,e.source_return_task_id),m=await storage.get('file-return/'+device.id+'/'+e.source_return_task_id);
    if(!source||source.type!=='get_file'||source.state!=='success'||!m||m.size!==data.size||!m.sha256)throw Error('取回任务与证据原件不匹配');
    evidence.source_return_task_id=e.source_return_task_id;evidence.source_sha256=m.sha256;
  }
  const old=await storage.get(indexKey(device.id,e.task_id))||[],files=[];
  for(const id of old){const m=await storage.get('file-transfer/'+id);if(m){files.push(id);if(m.evidence?.diagnostic_id===e.diagnostic_id&&m.evidence.fixture!==e.fixture)throw Error('同一诊断组不能混用夹具与现场用途');}}
  if(files.length!==old.length)await storage.put(indexKey(device.id,e.task_id),files);
  if(files.length>=64)throw Error('本任务证据附件已达64份上限');
  return {evidence,server_task_created_at:task.created_at||null,server_task_completed_at:task.completed_at||null,received_at:now,registration_created_at:device.created_at||null,collection_identity_verified:false};
}
export async function indexEvidence(storage,m){
  const key=indexKey(m.device_id,m.evidence.task_id),ids=await storage.get(key)||[];
  if(!ids.includes(m.id)){ids.push(m.id);await storage.put(key,ids);}
}
export async function listEvidence(storage,loadDevices,p){
  const device=(await loadDevices()).find(d=>d.id===p.device_id);if(!device)throw Error('未找到设备');
  if(typeof p.task_id!=='string'||p.task_id.length>128)throw Error('任务编号无效');
  const ids=await storage.get(indexKey(device.id,p.task_id))||[];
  const files=await Promise.all(ids.map(id=>storage.get('file-transfer/'+id)));
  return files.filter(m=>m&&m.purpose==='evidence'&&m.device_id===device.id&&m.evidence.task_id===p.task_id);
}
export function retainedEvidence(m){return m?.purpose==='evidence'&&m.state==='ready';}
