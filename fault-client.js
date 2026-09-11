import {faultRequire as need,faultTarget,faultCommand,faultReceipt,faultPending,faultTask,faultArchiveResult,faultArchiveQuery,faultNumber,faultCapacitySummary,FAULT_HEX} from './fault-contract.js';
import {verifyFaultPackage,faultHash,faultJson} from './fault-package.js';
const contexts=new Map();
// 同源所有故障目录共用锁，也覆盖不同设备误选同一目录；不跨浏览器或宿主进程。
const workflowLock='elfremote-fault-workflow';
const labels={EXPORT:'设备生成',GET_FILE:'服务器接收',DOWNLOAD:'电脑下载',VERIFY:'电脑逐项校验',ARCHIVE:'等待确认归档',CONFIRM:'确认归档结果',DONE:'已归档'};
const phaseLabel={INDEX_CORRUPT:'索引损坏',PENDING:'等待采集',RETRY_WAIT:'等待重试',CAPACITY_BLOCKED:'容量限制',AWAITING_POST:'等待后续记录',NOT_ACKNOWLEDGED:'未确认归档',INVALID_RECORD:'归档记录损坏',INCOMPLETE_EXPORT:'导出未完成',EXPORT_CORRUPT:'导出包损坏',FULL_HASH:'全部字节校验',STAT_CACHE:'使用上次校验缓存',ACTIVE_EVENT_LIMIT:'活动名额已满',RETAINED_EVENT_LIMIT:'保留事件已满',ACTIVE_RESERVATION_LIMIT:'活动空间预留不足',ARCHIVE_BYTE_LIMIT:'原件总字节上限',FREE_SPACE_RESERVE:'剩余空闲空间不足',COMPLETE:'采集完成',PARTIAL:'源记录不完整',FAILED:'采集失败',CAPTURE_PENDING:'等待采集',CAPTURING:'采集中',NONE:'无记录',UNKNOWN:'未知',EXPORTED:'已导出',RECEIPT_RECORDED_UNVERIFIED:'已有导出记录，未核验',ACK_RECORDED_UNVERIFIED:'已有归档记录，未核验',NOT_EXPORTED:'未导出',NOT_ARCHIVED:'未归档'};
const e=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=n=>Number(n)>0?new Date(Number(n)).toLocaleString('zh-CN',{timeZone:'Australia/Sydney',hour12:false}):'未知';
function context(){const d=window.currentDev();if(!d)return null;let c=contexts.get(d.id);if(!c){c={id:d.id,busy:false,message:'',directory:null,state:null,selected:''};contexts.set(d.id,c);}return c;}
function render(){if(typeof window.renderOps==='function')window.renderOps();}
function action(name,label,disabled=false){return `<button type="button" class="btn-gray" onclick="ElfFaults.${name}()"${disabled?' disabled':''}>${label}</button>`;}
function page(){
  const c=context();if(!c)return '';const s=c.state,p=s?.page,h=c.busy;
  let html='<div class="ops-actions">'+action('choose','选择本机保全目录',h)+action('scan','读取故障记录',h||!s)+action('next','下一页',h||!p?.hasMore)+`<span role="status">${e(c.message|| (s?'已连接本机目录':'先选择电脑上保存故障原件的目录'))}</span></div>`;
  if(c.budget)html+=`<p class="muted">本轮 ${c.budget.requests}/48 个请求 · ${Math.ceil((performance.now()-c.budget.start)/1000)}/90 秒 · ${faultNumber(c.budget.bytes)}/8388608 字节</p>`;
  if(p?.capacity){const x=p.capacity;html+=`<p class="muted">最近一次扫描 · ${date(x.capturedAtMs)}（不是实时容量）</p>`+faultCapacitySummary(x).map(line=>`<p class="muted">${e(line)}</p>`).join('');}
  if(p)html+='<div class="function-table"><table><thead><tr><th>事件</th><th>采集</th><th>导出</th><th>归档记录</th></tr></thead><tbody>'+p.events.map(r=>`<tr><td><button type="button" class="traffic-link" onclick="ElfFaults.select('${r.eventId}')">${e(r.category||'故障')} · ${e(r.eventId.slice(0,12))}</button></td><td>${e(r.phase==='INDEX_CORRUPT'?'索引损坏':phaseLabel[r.captureState]||r.captureState||r.phase||'未知')}</td><td>${e(phaseLabel[r.exportState]||r.exportState||'未知')}</td><td>${e(phaseLabel[r.archiveState]||r.archiveState||'未知')}</td></tr>`).join('')+'</tbody></table></div>';
  const id=c.selected,ev=s?.events?.[id];if(id){html+=`<div class="system-setting-section"><h4>所选事件 · ${e(id.slice(0,16))}</h4><div class="ops-actions">${action('query','核查详情',h)}${action('transfer','取回并校验原件',h||!ev?.query||ev.phase==='DONE')}${action('archive','确认归档',h||!ev?.proof||!['ARCHIVE','CONFIRM'].includes(ev.phase))}<span>${e(labels[ev?.phase]||'尚未取回')}</span></div>`;
    if(ev?.receipt)html+=`<p>故障包：${faultNumber(ev.receipt.bytes)} 字节 · ${e(ev.receipt.sha256.slice(0,16))}</p>`;
    if(ev?.retainedAttempts?.length)html+='<p class="muted">异常原包已保留，重新下载使用新文件名：</p>'+ev.retainedAttempts.map(a=>`<p class="muted">${e(a.name)} · ${e(a.reason)}</p>`).join('');
    if(ev?.proof)html+=`<p>冻结包：${ev.proof.files} 个文件逐项校验通过</p><p>源日志：${ev.proof.sourceLogComplete?'至少一个非空源文件完整':'未证明源文件完整'} · 不代表完整故障窗口</p><p class="muted">源缺口：${e(JSON.stringify(ev.proof.gaps))}</p>`;
    if(ev?.query){const q=ev.query;html+=`<p class="muted">采集状态：${e(q.state?.capture||q.captureState||'未知')}　核验方式：${e(phaseLabel[q.verification?.mode||q.export?.verification?.mode]||'未知')}　核验时间：${date(q.verification?.verifiedAtMs||q.export?.verification?.verifiedAtMs)}</p>`;if(!ev.proof&&q.gaps)html+=`<p class="muted">源缺口：${e(JSON.stringify(q.gaps))}</p>`;}
    if(ev?.phase==='DONE')html+='<p>归档已独立确认；事件不再计入未归档数量，设备原件及保留空间仍保留。</p>';html+='</div>';
  }
  return html;
}
async function fileRead(c,name,max=1048576){const f=await (await c.directory.getFileHandle(name)).getFile();need(f.size<=max,'本机文件超过允许大小');return new Uint8Array(await f.arrayBuffer());}
async function fileWrite(c,name,bytes){const h=await c.directory.getFileHandle(name,{create:true}),w=await h.createWritable();try{await w.write(bytes);await w.close();}catch(error){await w.abort().catch(()=>{});throw error;}}
async function save(c){await fileWrite(c,'fault-web-state.json',JSON.stringify(c.state));}
async function request(c,route,body,missing=false){
  need(c.budget&&c.budget.requests<48&&performance.now()-c.budget.start<90000,'本轮预算已到，点击原操作可继续');c.budget.requests++;
  const r=await fetch(route,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(20000)});
  if(r.status===429||r.status>=500){const seconds=Number(r.headers.get('Retry-After'));c.retryAt=Date.now()+Math.min(300000,Math.max(15000,Number.isFinite(seconds)?seconds*1000:15000));throw Error('服务暂不可用，请稍后继续原操作');}
  const text=await r.text();need(new TextEncoder().encode(text).length<=262144,'服务返回超限');let value;try{value=JSON.parse(text);}catch{throw Error('服务器响应不完整');}
  if(missing&&r.status===404&&value.ok===false&&value.msg==='未找到该任务')return null;
  need(r.ok&&value.ok!==false,'请求失败：'+(value.msg||r.status));return value;
}
async function task(c,holder,key,type,params,beforeSend){
  holder.target=c.state.target;
  for(;;){const result=await faultTask({state:holder,key,type,params,save:()=>save(c),request:(...args)=>request(c,...args),beforeSend});if(result!==null)return result;
    c.message='等待设备完成，可关闭页面后在原目录继续';render();await new Promise(resolve=>setTimeout(resolve,2000));
  }
}
async function command(c,holder,key,args,beforeSend){return task(c,holder,key,'root_exec',faultCommand(c.state.activeApk,args),beforeSend);}
async function checkTarget(c){const list=await request(c,'/api/devices'),d=list.devices?.find(d=>d.id===c.id);need(d,'设备未在当前列表中');const t=faultTarget(d);need(JSON.stringify(t)===JSON.stringify(c.state.target),'设备或版本已改变，请使用新的保全目录');return d;}
async function run(fn){const c=context();if(!c||c.busy)return;if(c.retryAt&&Date.now()<c.retryAt){c.message='请等待服务退避结束后继续';render();return;}c.busy=true;c.message='正在处理…';c.budget={requests:0,bytes:0,start:performance.now()};render();
  try{need(c.directory&&c.state,'请先选择本机保全目录');need(navigator.locks,'浏览器不支持本机工作流互斥');await navigator.locks.request(workflowLock,{ifAvailable:true},async lock=>{need(lock,'另一个页面正在处理故障保全，请稍后继续');const fresh=faultJson(await fileRead(c,'fault-web-state.json'));need(fresh.schemaVersion===1&&JSON.stringify(fresh.target)===JSON.stringify(c.state.target)&&fresh.tasks&&fresh.events,'本机工作流身份不符');c.state=fresh;await checkTarget(c);await fn(c);});}
  catch(error){c.message=error.message||'操作未完成，请继续原操作';}finally{c.busy=false;render();}
}
async function choose(){const c=context();if(!c||c.busy)return;c.busy=true;try{
  need(window.showDirectoryPicker,'请使用支持本机目录访问的桌面浏览器');need(navigator.locks,'浏览器不支持本机工作流互斥');const target=faultTarget(window.currentDev()),directory=await showDirectoryPicker({mode:'readwrite',id:'elfremote-faults'});
  await navigator.locks.request(workflowLock,{ifAvailable:true},async lock=>{need(lock,'另一个页面正在处理故障保全，请稍后重选原目录');c.directory=directory;
  let state;try{state=faultJson(await fileRead(c,'fault-web-state.json'));}catch(error){if(error.name!=='NotFoundError')throw error;}
  if(state){need(state.schemaVersion===1&&JSON.stringify(state.target)===JSON.stringify(target)&&state.events&&state.tasks,'该目录属于其他目标、版本或状态损坏');if(state.activeApk)faultCommand(state.activeApk,['pending','16']);c.state=state;}
  else {c.state={schemaVersion:1,target,tasks:{},events:{},cursor:'',activeApk:null};await save(c);}
  c.message='已恢复本机工作流';});
  }catch(error){c.directory=null;c.state=null;c.message=error.name==='AbortError'?'已取消选择':error.message;}finally{c.busy=false;render();}
}
async function ensureApk(c){if(c.state.activeApk)return;const active=await task(c,c.state,'active','root_exec',{cwd:'/',timeout:15,command:'cat /data/local/d31-remote/runtime/active.json'});need(active.versionName===c.state.target.expectedVersion,'活动客户端版本与设备报告不符');faultCommand(active.path,['pending','16']);c.state.activeApk=active.path;await save(c);}
async function scanPage(c,next){await ensureApk(c);if(!c.state.scan||c.state.scan.done){const cursor=next?c.state.page?.nextAfter||'':'';c.state.scan={cursor,tasks:{}};await save(c);}const scan=c.state.scan;
  const value=await command(c,scan,'pending',['pending','16',...(scan.cursor?[scan.cursor]:[])]);need(new TextEncoder().encode(scan.tasks.pending.task.result.text).length<=8000,'紧凑故障索引超过8000字节');c.state.page=faultPending(value);scan.done=true;await save(c);c.message=value.hasMore?'还有下一页；此处仅显示元数据':'本轮列表已读完；不代表所有故障已保全';}
function selected(c){need(FAULT_HEX.test(c.selected),'请先选择事件');return c.state.events[c.selected]||=( {eventId:c.selected,phase:'EXPORT',tasks:{}} );}
async function queryEvent(c){const ev=selected(c);if(!ev.detail||ev.detail.done){ev.detail={tasks:{}};await save(c);}const q=await command(c,ev.detail,'query',['query',ev.eventId]);need(q.eventId===ev.eventId,'故障详情身份不符');ev.query=q;ev.detail.done=true;await save(c);c.message='详情已读取；归档记录不能代替本机验包';}
async function localProof(c,ev){const bytes=await fileRead(c,ev.bundle,8388608);return verifyFaultPackage(bytes,ev.receipt,ev.eventId);}
async function transfer(c){const ev=selected(c);if(ev.receipt)faultReceipt(ev.receipt,ev.eventId);need(ev.query&&['COMPLETE','PARTIAL'].includes(ev.query.state?.phase||ev.query.phase),'事件尚未进入可导出终态，请先核查详情');
  if(ev.phase==='EXPORT'){ev.receipt=faultReceipt(await command(c,ev,'export',['export',ev.eventId]),ev.eventId);ev.phase='GET_FILE';await fileWrite(c,'receipt-'+ev.eventId+'.json',JSON.stringify(ev.receipt));await save(c);}
  if(ev.phase==='GET_FILE'){const result=await task(c,ev,'getFile','get_file',{path:ev.receipt.path,allow_cellular:false});need(result.action==='uploaded'&&result.sha256===ev.receipt.sha256&&result.bytes===ev.receipt.bytes,'服务器接收回执不符');ev.phase='DOWNLOAD';await save(c);}
  if(ev.phase==='DOWNLOAD'){
    const r=ev.receipt;let existing=false;
    if(ev.bundle)try{const b=await fileRead(c,ev.bundle,8388608);existing=b.length===r.bytes&&await faultHash(b)===r.sha256;
      if(!existing){ev.retainedAttempts||=[];if(!ev.retainedAttempts.some(a=>a.name===ev.bundle)){need(ev.retainedAttempts.length<64,'异常包记录已达上限，请保留目录并人工核查');ev.retainedAttempts.push({name:ev.bundle,reason:'长度或摘要与设备回执不符',at:Date.now()});}await save(c);}
    }catch(error){if(error.name!=='NotFoundError')throw error;}
    if(!existing){
      // 每次网络尝试先持久化新名称；旧文件即使异常也不覆盖。
      let name;for(let i=0;i<8;i++){const candidate='bundle-'+ev.eventId+'-'+crypto.randomUUID()+'.zip';try{await c.directory.getFileHandle(candidate);}catch(error){if(error.name!=='NotFoundError')throw error;name=candidate;break;}}need(name,'无法分配新的本机文件名');ev.bundle=name;await save(c);
      const taskId=ev.tasks.getFile.request.id,q=new URLSearchParams({device_id:c.id,task_id:taskId}),m=await request(c,'/api/elfremote/file-return?'+q),f=m.file;
      need(f?.state==='ready'&&f.device_id===c.id&&f.task_id===taskId&&f.sha256===r.sha256&&(f.size??f.bytes)===r.bytes&&(f.size===undefined||f.bytes===undefined||f.size===f.bytes),'暂存文件目标、大小或摘要不符');
      need(c.budget.requests<48&&performance.now()-c.budget.start<90000,'本轮请求预算已到');c.budget.requests++;const res=await fetch('/api/elfremote/file-return?'+q+'&download=1',{credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(30000)});need(res.status===200,'故障包下载失败');const reader=res.body.getReader(),chunks=[];let length=0;
      try{for(;;){const {value,done}=await reader.read();if(done)break;length+=value.length;c.budget.bytes+=value.length;need(length<=r.bytes&&c.budget.bytes<=8388608,'下载大小超过回执');chunks.push(value);}}finally{await reader.cancel();}
      need(length===r.bytes,'故障包下载中断');const bytes=new Uint8Array(length);let at=0;for(const b of chunks){bytes.set(b,at);at+=b.length;}need(await faultHash(bytes)===r.sha256,'下载故障包摘要不符');await fileWrite(c,ev.bundle,bytes);
    }ev.phase='VERIFY';await save(c);
  }
  if(['VERIFY','ARCHIVE'].includes(ev.phase)){ev.proof=await localProof(c,ev);await fileWrite(c,'verified-'+ev.eventId+'.json',JSON.stringify(ev.proof));ev.phase='ARCHIVE';await save(c);}
  c.message='本机原件逐项校验完成，可以确认归档';
}
async function archive(c){const ev=selected(c);need(['ARCHIVE','CONFIRM'].includes(ev.phase),'请先取回并校验原件');const proof=await localProof(c,ev);
  if(ev.phase==='ARCHIVE'){const ack=await command(c,ev,'archive',proof.archiveArgs,()=>localProof(c,ev));faultArchiveResult(ack,ev.receipt);ev.ack=ack;ev.phase='CONFIRM';await save(c);}
  const q=await command(c,ev,'confirm',['query',ev.eventId]);faultArchiveQuery(q,ev.receipt);ev.query=q;ev.phase='DONE';await save(c);c.message='归档已确认，设备原件未删除';
}
window.ElfFaults={page,choose,available:d=>d?.model_id==='mdl_d31'&&d.managed_exec_tasks===true&&d.managed_file_return===true,scan:()=>run(c=>scanPage(c,false)),next:()=>run(c=>scanPage(c,true)),select:id=>{if(FAULT_HEX.test(id)){context().selected=id;render();}},query:()=>run(queryEvent),transfer:()=>run(transfer),archive:()=>run(archive)};
