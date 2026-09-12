// 同一纯模块供 Worker 和浏览器使用；原厂分页不经过旧 Android 联系人规范化。
export function createContactsPagesApi() {
  const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
  const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
  const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
  const need=(ok,code)=>{if(!ok)throw Object.assign(Error(code),{code});};
  const clone=v=>JSON.parse(JSON.stringify(v));
  const descriptorKeys=('owner_package snapshot_id status sampled_at_ms elapsed_ms record_count frames_received received_chars start_observed end_observed list_complete contact_values_emitted completion_scope all_sources_complete snapshot_consistency android_equivalence service_implementation max_records max_frames max_received_chars wait_budget_ms retention_ms max_page_records page_consistency storage cross_process_restart cross_boot').split(' ');
  const commonKeys=['schema_version','action','ok','read_only','source','contact_type'];
  const pageKeys=['items','offset','next_offset','has_more','page_complete','cursor_scope'];
  function normalizeParams(params){
    need(record(params),'CONTACTS_PAGE_ARGUMENTS_INVALID');let keys;
    if(params.action==='open'){keys=['action','source'];need(params.source==='LOCAL','CONTACTS_PAGE_SOURCE_UNSUPPORTED');}
    else if(params.action==='page'){keys=['action','snapshot_id','offset','limit'];need(uuid(params.snapshot_id)&&integer(params.offset,0,4096)&&integer(params.limit,1,32),'CONTACTS_PAGE_ARGUMENTS_INVALID');}
    else if(params.action==='close'){keys=['action','snapshot_id'];need(uuid(params.snapshot_id),'CONTACTS_PAGE_ARGUMENTS_INVALID');}
    else need(false,'CONTACTS_PAGE_ARGUMENTS_INVALID');
    need(Object.keys(params).length===keys.length&&Object.keys(params).every(k=>keys.includes(k)),'CONTACTS_PAGE_ARGUMENTS_INVALID');return clone(params);
  }
  function normalizeResult(value,params){
    const p=normalizeParams(params);need(record(value)&&value.schema_version===1&&value.action===p.action&&typeof value.ok==='boolean'&&value.read_only===true&&value.source==='nexui_messenger'&&value.contact_type==='LOCAL','CONTACTS_PAGE_RESULT_SCOPE');
    need(new TextEncoder().encode(JSON.stringify(value)).length<=65536,'CONTACTS_PAGE_RESULT_SIZE');
    if(p.action!=='open')need(value.snapshot_id===p.snapshot_id,'CONTACTS_SNAPSHOT_MISMATCH');
    if(!value.ok){need(typeof value.code==='string'&&/^CONTACTS_[A-Z0-9_]{1,96}$/.test(value.code),'CONTACTS_PAGE_ERROR_INVALID');need(Object.keys(value).every(k=>[...commonKeys,'code','snapshot_id'].includes(k)),'CONTACTS_PAGE_ERROR_INVALID');if(p.action==='open')need(value.snapshot_id===undefined,'CONTACTS_PAGE_ERROR_INVALID');return clone(value);}
    if(p.action==='close'){need(value.snapshot_closed===true&&Object.keys(value).every(k=>[...commonKeys,'snapshot_id','snapshot_closed'].includes(k)),'CONTACTS_PAGE_CLOSE_UNCONFIRMED');return clone(value);}
    need(uuid(value.snapshot_id)&&value.owner_package==='com.starnet.dial'&&value.status==='COMPLETED'&&integer(value.sampled_at_ms,1,8640000000000000)&&integer(value.record_count,0,4096)&&value.end_observed===true&&value.list_complete===true&&value.all_sources_complete===false&&value.snapshot_consistency==='NOT_PROVIDED_BY_VENDOR'&&value.completion_scope==='SELECTED_SOURCE_ALL_CONTACTS_REPLY'&&value.retention_ms===120000&&value.max_page_records===32&&value.page_consistency==='IMMUTABLE_RECEIVED_REPLY'&&value.storage==='APP_PROCESS_MEMORY'&&value.cross_process_restart===false&&value.cross_boot===false,'CONTACTS_PAGE_SNAPSHOT_SCOPE');
    for(const [key,max] of Object.entries({elapsed_ms:120000,frames_received:128,received_chars:1048576,max_records:4096,max_frames:128,max_received_chars:1048576,wait_budget_ms:120000}))if(value[key]!==undefined)need(integer(value[key],0,max),'CONTACTS_PAGE_SNAPSHOT_SCOPE');
    if(value.start_observed!==undefined)need(typeof value.start_observed==='boolean','CONTACTS_PAGE_SNAPSHOT_SCOPE');
    if(value.android_equivalence!==undefined)need(value.android_equivalence==='NOT_VERIFIED','CONTACTS_PAGE_SNAPSHOT_SCOPE');
    if(value.service_implementation!==undefined)need(value.service_implementation==='NOT_DECRYPTED','CONTACTS_PAGE_SNAPSHOT_SCOPE');
    const allowed=[...commonKeys,...descriptorKeys,...(p.action==='page'?pageKeys:[])];need(Object.keys(value).every(k=>allowed.includes(k)),'CONTACTS_PAGE_RESULT_FIELDS');
    if(p.action==='open'){need(value.contact_values_emitted===false,'CONTACTS_PAGE_OPEN_PERSONAL_FIELDS');return clone(value);}
    need(Array.isArray(value.items)&&value.items.every(record)&&value.items.length<=p.limit&&value.offset===p.offset&&value.next_offset===p.offset+value.items.length&&integer(value.next_offset,p.offset,value.record_count)&&value.has_more===(value.next_offset<value.record_count)&&value.page_complete===!value.has_more&&value.cursor_scope==='SAME_SNAPSHOT_ONLY'&&value.contact_values_emitted===(value.items.length>0)&&(!value.has_more||value.items.length>0),'CONTACTS_PAGE_CURSOR_INVALID');
    function depth(v,n=0){need(n<=16,'CONTACTS_PAGE_ITEM_INVALID');if(v&&typeof v==='object')for(const child of Object.values(v))depth(child,n+1);}
    for(const item of value.items){need(JSON.stringify(item).length<=8192,'CONTACTS_PAGE_ITEM_INVALID');depth(item);}
    return clone(value);
  }
  function sameSnapshot(open,page){need(record(open)&&record(page),'CONTACTS_SNAPSHOT_MISMATCH');for(const k of descriptorKeys)if(k!=='contact_values_emitted')need(JSON.stringify(open[k])===JSON.stringify(page[k]),'CONTACTS_SNAPSHOT_MISMATCH');return true;}
  function submissionRejected(status,value){
    if(!record(value)||value.ok!==false||value.task)return false;
    if([400,404,409].includes(status)&&value.not_enqueued===true)return true;
    if(status===400&&['unknown-type','inflight','expired','idempotency-conflict'].includes(value.reason))return true;
    if(status===404&&['未找到该设备','未找到设备'].includes(value.msg))return true;
    return status===409&&(value.msg==='当前客户端尚未接通该任务'||['CONTACTS_SNAPSHOT_GONE','CONTACTS_SNAPSHOT_BUSY','CONTACTS_SNAPSHOT_MISMATCH'].includes(value.code));
  }
  const messages={CONTACTS_SNAPSHOT_GONE:'联系人快照已失效，请重新读取',CONTACTS_SNAPSHOT_BUSY:'设备已有联系人快照，请先关闭或等待到期',CONTACTS_SNAPSHOT_MISMATCH:'联系人快照不匹配，已停止读取',CONTACTS_PAGE_EXPIRED:'联系人快照已过期，请重新读取',CONTACTS_PAGE_PENDING:'上一项操作尚未确认，请先查询任务',CONTACTS_PAGE_SUBMISSION_UNKNOWN:'提交结果未知，请查询原任务',CONTACTS_PAGE_TASK_UNKNOWN:'原任务结果尚未确认，未重新提交',CONTACTS_PAGE_UNAVAILABLE:'该设备尚未支持 LOCAL 通讯录分页',CONTACTS_PAGE_RETRY_WAIT:'服务正在退避，请稍后查询原任务',CONTACTS_PAGE_CLOSE_FIRST:'请先关闭当前快照',CONTACTS_PAGE_RESULT_SCOPE:'设备返回的联系人结果无效',CONTACTS_PAGE_SNAPSHOT_SCOPE:'设备返回的快照范围无效',CONTACTS_PAGE_RESULT_FIELDS:'设备返回了未约定的联系人字段',CONTACTS_PAGE_CURSOR_INVALID:'联系人页游标异常，已停止读取'};
  const errorText=e=>e?.submissionRejected?'服务器未接受本次操作，请稍后重新尝试':messages[e?.code||e?.message]||'联系人操作未完成，请查询原任务或重新读取';
  function createController({request,now=()=>Date.now(),monotonic=()=>performance.now(),uuid:makeId=()=>crypto.randomUUID(),changed=()=>{}}){
    const states=new Map();
    function state(device){const id=typeof device==='string'?device:device?.id;need(typeof id==='string'&&/^[A-Za-z0-9_-]{1,96}$/.test(id),'CONTACTS_PAGE_DEVICE_INVALID');if(!states.has(id))states.set(id,{deviceId:id,busy:false,pending:null,snapshot:null,page:null,offsets:[],pageIndex:-1,error:'',message:'尚未读取 LOCAL 通讯录',invalid:false,retryAt:0});return states.get(id);}
    function available(d){return d?.enabled!==false&&d?.managed_contacts_page_v1===true;}
    function expired(s){return !!s.snapshot&&(s.invalid||now()<s.startedAt||monotonic()<s.startedMono||now()>=s.startedAt+120000||monotonic()>=s.startedMono+120000);}
    function view(d){const s=state(d);if(s.snapshot&&!s.invalid&&expired(s)){s.invalid=true;s.error=messages.CONTACTS_PAGE_EXPIRED;}return s;}
    function report(s,error){if(error?.retryAfter)s.retryAt=Math.max(s.retryAt,now()+error.retryAfter);if(error?.retryAt)s.retryAt=Math.max(s.retryAt,error.retryAt);s.error=errorText(error);changed(s.deviceId);}
    async function accept(d,t){const s=state(d),op=s.pending;if(!op)return false;need(t&&t.id===op.request.id&&t.type==='contacts_page'&&t.expires_at===op.request.expires_at,'CONTACTS_PAGE_TASK_MISMATCH');
      if(['pending','claimed','running'].includes(t.state)){s.message='等待设备完成';return false;}
      need(['success','failed','rejected','expired','cancelled'].includes(t.state),'CONTACTS_PAGE_TASK_UNKNOWN');
      const params=op.request.params;
      const value=t.result?.contacts_page;
      if(t.result?.truncated===true)throw Object.assign(Error('CONTACTS_PAGE_RESULT_SIZE'),{code:'CONTACTS_PAGE_RESULT_SIZE'});
      const result=normalizeResult(value,params);s.pending=null;
      if(t.state!=='success'||!result.ok){need(result.ok===false,'CONTACTS_PAGE_TASK_FAILED');if(result.code==='CONTACTS_SNAPSHOT_GONE')s.invalid=true;throw Object.assign(Error(result.code),{code:result.code});}
      if(params.action==='open'){s.snapshot=result;s.page=null;s.offsets=[];s.pageIndex=-1;s.invalid=false;s.startedAt=op.startedAt;s.startedMono=op.startedMono;need(!expired(s),'CONTACTS_PAGE_EXPIRED');s.message='快照已建立';s.autoFirst=true;}
      else if(params.action==='page'){need(s.snapshot&&!expired(s),'CONTACTS_PAGE_EXPIRED');sameSnapshot(s.snapshot,result);s.page=result;let i=s.offsets.indexOf(result.offset);if(i<0){s.offsets.push(result.offset);i=s.offsets.length-1;}s.pageIndex=i;s.message=result.record_count===0?'LOCAL 暂无联系人':'已读取当前页';}
      else{s.snapshot=null;s.page=null;s.offsets=[];s.pageIndex=-1;s.invalid=false;s.message='联系人快照已关闭';}
      s.error='';return true;
    }
    async function first(d){const s=state(d);if(s.autoFirst&&!s.busy&&!s.pending){s.autoFirst=false;await run(d,{action:'page',snapshot_id:s.snapshot.snapshot_id,offset:0,limit:32});}}
    async function run(d,params){const s=view(d);if(s.busy)return;try{need(available(d),'CONTACTS_PAGE_UNAVAILABLE');need(!s.pending,'CONTACTS_PAGE_PENDING');need(now()>=s.retryAt,'CONTACTS_PAGE_RETRY_WAIT');params=normalizeParams(params);
      if(params.action==='open')need(!s.snapshot||expired(s),'CONTACTS_PAGE_CLOSE_FIRST');
      else {need(s.snapshot&&s.snapshot.snapshot_id===params.snapshot_id,'CONTACTS_SNAPSHOT_MISMATCH');if(params.action==='page')need(!expired(s),'CONTACTS_PAGE_EXPIRED');}
      s.busy=true;s.error='';s.message='正在提交';const startedAt=now(),startedMono=monotonic();
      const expires=params.action==='page'?Math.min(startedAt+120000,s.startedAt+120000):startedAt+120000;
      s.pending={startedAt,startedMono,request:{device_id:s.deviceId,id:'contacts-page-'+makeId(),type:'contacts_page',params,expires_at:expires}};changed(s.deviceId);
      let response;try{response=await request('/api/elfremote/task',s.pending.request);}catch(error){if(error?.submissionRejected===true)s.pending=null;report(s,error);s.error=error?.submissionRejected||error?.retryAfter||error?.retryAt?s.error:messages.CONTACTS_PAGE_SUBMISSION_UNKNOWN;return;}
      await accept(d,response?.task);
    }catch(error){report(s,error);}finally{s.busy=false;changed(s.deviceId);}await first(d);}
    async function resume(d){const s=state(d);if(s.busy||!s.pending)return;try{need(now()>=s.retryAt,'CONTACTS_PAGE_RETRY_WAIT');s.busy=true;changed(s.deviceId);const q=new URLSearchParams({device_id:s.deviceId,task_id:s.pending.request.id}),response=await request('/api/elfremote/tasks?'+q);need(response?.task,'CONTACTS_PAGE_TASK_UNKNOWN');await accept(d,response.task);}catch(error){report(s,error);}finally{s.busy=false;changed(s.deviceId);}await first(d);}
    async function observe(d){const s=states.get(d?.id);if(!s||s.busy||!s.pending||d.task?.id!==s.pending.request.id)return;try{await accept(d,d.task);}catch(error){report(s,error);}finally{changed(s.deviceId);}await first(d);}
    return {state:view,available,observe,resume,open:d=>run(d,{action:'open',source:'LOCAL'}),page:(d,offset,limit=32)=>{const s=view(d);return run(d,{action:'page',snapshot_id:s.snapshot?.snapshot_id,offset,limit});},next:d=>{const s=view(d);return run(d,{action:'page',snapshot_id:s.snapshot?.snapshot_id,offset:s.page?s.page.next_offset:0,limit:32});},previous:d=>{const s=view(d);return run(d,{action:'page',snapshot_id:s.snapshot?.snapshot_id,offset:s.offsets[Math.max(0,s.pageIndex-1)],limit:32});},close:d=>{const s=view(d);return run(d,{action:'close',snapshot_id:s.snapshot?.snapshot_id});}};
  }
  return {normalizeParams,normalizeResult,validateSnapshot:sameSnapshot,submissionRejected,createController,errorText};
}
const api=createContactsPagesApi();
export const normalizeContactsPageParams=api.normalizeParams;
export const normalizeContactsPageResult=api.normalizeResult;
export const validateContactsPageSnapshot=api.validateSnapshot;
export const contactsPageSubmissionRejected=api.submissionRejected;
export const createContactsPageController=api.createController;
export const contactsPagesClientSource='var ContactsPages=('+createContactsPagesApi.toString()+')();\n';
