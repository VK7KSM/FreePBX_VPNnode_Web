function installEvidenceClient(){
  let state=null,serial=0;
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const roles={request:'原始请求',receipt:'诊断回执',report:'系统对照报告',observation:'采集原件',firmware:'固件预期',firmware_generation:'固件生成记录'};
  const statuses={SAME:'原始值相同',DIFFERENT:'原始值不同',UNKNOWN:'证据不足',OBSERVED:'已有证据',NOT_CHECKED:'未检查',READ_FAILED:'读取失败',UNSTABLE:'状态不稳定',REDACTED:'已脱敏',NOT_APPLICABLE:'适用性未核验',success:'命令执行成功',failed:'命令执行失败',rejected:'已拒绝',expired:'任务已过期',pending:'等待执行',claimed:'已领取',running:'正在执行',SUCCEEDED:'事务成功',REJECTED:'事务已拒绝',ROLLED_BACK:'已回滚',NEEDS_ATTENTION:'需要处理'};
  const categories={PRESENCE:'存在状态',CONTENT:'文件内容',METADATA:'文件属性',ACTIVATION:'运行来源',CONFIGURATION_SEMANTICS:'配置语义',PERSONAL_DATA:'脱敏信息',INVENTORY:'目录枚举'};
  const items={'system_support.root':'系统支持 ROOT','system_support.disabled':'系统支持禁用条件','recovery.enabled':'Recovery 启用条件','startup.cellular_enabled':'蜂窝启动配置','rescue.enabled':'救援启用条件','desktop.config_tab':'桌面布局配置','initialization.components':'初始化组件','initialization.permissions':'初始化权限','initialization.completion':'初始化完成条件'};
  const textStatus=v=>statuses[v]||'未知（'+String(v||'未提供')+'）';
  const time=v=>v?sydney(v):'未提供';
  const active=s=>state===s&&currentDev()?.id===s.device;
  async function json(url){const r=await fetch(url,{signal:AbortSignal.timeout(15000)});const data=await r.json();if(!r.ok||data.ok===false)throw Error(data.msg||'证据读取失败');return data;}
  const fileUrl=(f,pointer)=>'/api/elfremote/files/'+f.id+'/content?'+new URLSearchParams({device_id:f.device_id||state.device,task_id:f.evidence?.task_id||state.task.id,sha256:f.sha256,...(pointer===undefined?{}:{pointer})});
  const listUrl=(device,task)=>'/api/elfremote/files?'+new URLSearchParams({purpose:'evidence',device_id:device,task_id:task});
  function close(){state=null;serial++;document.getElementById('taskEvidenceWrap')?.remove();}
  function setup(){
    if(!document.getElementById('taskEvidenceStyle')){const style=document.createElement('style');style.id='taskEvidenceStyle';style.textContent='.evidence-card{width:1120px;max-width:94vw;padding:22px;border-radius:16px;color:#cbd5e1;font-size:14px;line-height:1.65}.evidence-head{display:flex;align-items:center;gap:16px;margin-bottom:18px}.evidence-head h3{font-size:18px;margin:0 auto 0 0}.evidence-head select{width:330px}.evidence-close{position:static!important}.evidence-layout{display:grid;grid-template-columns:145px minmax(0,1fr);gap:22px}.evidence-nav{border-right:1px solid #334155;padding-right:16px;display:flex;flex-direction:column;gap:8px}.evidence-nav button{text-align:left;background:transparent;border:0;color:#94a3b8;padding:9px 10px;border-radius:7px}.evidence-nav button.active{color:#fff;background:#334155}.evidence-body{min-height:340px;max-height:68vh;overflow:auto;overflow-wrap:anywhere}.evidence-body table{width:100%;border-collapse:collapse;font-size:13px}.evidence-body th,.evidence-body td{text-align:left;padding:9px 8px;border-bottom:1px solid #273548;vertical-align:top}.evidence-body th{color:#94a3b8;font-weight:500}.evidence-body pre{white-space:pre-wrap;background:#0b1220;padding:14px;border-radius:8px;max-height:260px;overflow:auto}.evidence-meta{display:flex;gap:18px;flex-wrap:wrap;margin:12px 0}.evidence-muted{color:#94a3b8}.evidence-warning{color:#fbbf24}.evidence-pager{display:flex;justify-content:flex-end;align-items:center;gap:12px;margin-top:14px}.evidence-error{color:#f87171}.evidence-value{border-top:1px solid #334155;margin-top:16px;padding-top:12px}';document.head.appendChild(style);}
    const wrap=document.createElement('div');wrap.id='taskEvidenceWrap';wrap.className='modal-bg';wrap.style.display='flex';wrap.innerHTML='<section class="card evidence-card"></section>';wrap.addEventListener('click',e=>{if(e.target===wrap)close();});document.body.appendChild(wrap);
    wrap.addEventListener('change',e=>{const s=state;if(!s)return;if(e.target.dataset.task!==undefined)selectTask(s,e.target.value);if(e.target.dataset.report!==undefined){s.report=null;s.rows=[];s.page=0;s.file=s.files.find(f=>f.id===e.target.value);loadReport(s);}});
    wrap.addEventListener('click',e=>{const s=state,b=e.target.closest('button');if(!s||!b)return;if(b.dataset.close!==undefined)return close();if(b.dataset.tab){s.tab=b.dataset.tab;render(s);if(s.tab==='report'&&!s.report)loadReport(s);}if(b.dataset.page){s.page+=Number(b.dataset.page);render(s);}if(b.dataset.proof!==undefined)proof(s,Number(b.dataset.proof),b.dataset.side);});
  }
  async function open(){
    const d=currentDev();if(!d)return;close();setup();const s=state={device:d.id,name:d.name,tasks:[],files:[],tab:'summary',page:0,rows:[],busy:true,version:++serial};render(s);
    try{const result=await json('/api/elfremote/tasks?'+new URLSearchParams({device_id:s.device}));if(!active(s))return close();s.tasks=result.tasks||[];s.busy=false;if(s.tasks.length)await selectTask(s,s.tasks[0].id);else render(s);}catch(e){if(active(s)){s.busy=false;s.error=e.message;render(s);}}
  }
  async function selectTask(s,id){
    s.task=s.tasks.find(t=>t.id===id);s.report=null;s.rows=[];s.files=[];s.file=null;s.proof=null;s.page=0;s.error='';s.busy=true;const version=++s.version;render(s);
    try{const data=await json(listUrl(s.device,id));if(!active(s)||s.version!==version)return;s.files=data.files||[];s.file=s.files.find(f=>f.state==='ready'&&f.evidence.role==='report');s.busy=false;render(s);if(s.tab==='report')await loadReport(s);}catch(e){if(active(s)&&s.version===version){s.busy=false;s.error=e.message;render(s);}}
  }
  async function loadReport(s){
    if(!s.file)return;const file=s.file,version=++s.version;s.error='';s.busy=true;render(s);
    try{const r=await fetch(fileUrl(file),{signal:AbortSignal.timeout(15000)});if(!r.ok){const e=await r.json();throw Error(e.msg||'报告读取失败');}const report=ElfEvidenceData.parse(await r.text()),rows=ElfEvidenceData.rows(report);if(!active(s)||s.version!==version)return;s.report=report;s.rows=rows;s.busy=false;render(s);}catch(e){if(active(s)&&s.version===version){s.busy=false;s.error=e.message;render(s);}}
  }
  async function proof(s,index,side){
    const row=s.rows[index],link=side==='report'?{id:s.file.id,sha256:s.file.sha256,pointer:row.reportPointer}:ElfEvidenceData.inputLink(s.report,side,row,s.files,s.file.evidence.diagnostic_id);
    if(!link)return;const version=s.version;
    try{const result=await json(fileUrl(link,link.pointer));if(!active(s)||s.version!==version)return;s.proof=result;render(s);}catch(e){if(active(s)&&s.version===version){s.error=e.message;render(s);}}
  }
  function render(s){
    if(!active(s))return;const card=document.querySelector('#taskEvidenceWrap .evidence-card');if(!card)return;
    let h='<div class="evidence-head"><h3>任务详情 <span class="evidence-muted">· '+esc(s.name)+'</span></h3><select class="inp" data-task aria-label="选择任务">'+s.tasks.map(t=>'<option value="'+esc(t.id)+'"'+(s.task?.id===t.id?' selected':'')+'>'+esc(time(t.created_at)+' · '+(t.type_label||t.type))+'</option>').join('')+'</select><button class="btn-close evidence-close" data-close aria-label="关闭">×</button></div>';
    h+='<div class="evidence-layout"><nav class="evidence-nav">'+[['summary','任务摘要'],['files','证据附件'],['report','系统对照']].map(([key,title])=>'<button data-tab="'+key+'" class="'+(s.tab===key?'active':'')+'">'+title+'</button>').join('')+'</nav><div class="evidence-body">';
    if(s.error)h+='<p class="evidence-error">'+esc(s.error)+'</p>';
    if(s.busy)h+='<p class="evidence-muted">正在读取…</p>';
    else if(!s.task)h+='<p class="evidence-muted">暂无任务记录</p>';
    else if(s.tab==='summary'){
      h+='<strong>'+esc(textStatus(s.task.state))+'</strong><div class="evidence-meta"><span>发起 '+esc(time(s.task.created_at))+'</span><span>完成 '+esc(time(s.task.completed_at))+'</span></div><p>'+esc(s.task.detail||'')+'</p>';
      const raw=s.task.result?.text;if(raw){let inner;try{inner=ElfEvidenceData.parse(raw);}catch{}if(inner?.state?.phase)h+='<p>设备事务：'+esc(textStatus(inner.state.phase))+' · '+esc(inner.state.reason||'')+'</p><p class="evidence-muted">文件内容与属性验证不代表运行生效或整机一致。</p>';h+='<details><summary>查看原始返回</summary><pre>'+esc(raw)+'</pre></details>';}
    }else if(s.tab==='files'){
      h+='<p class="evidence-muted">附件按原字节封存；登记归属不等于采集时身份已经核验。</p><table><thead><tr><th>用途／文件</th><th>大小</th><th>服务器接收时间</th><th>原件</th></tr></thead><tbody>';
      for(const f of s.files)h+='<tr><td>'+esc(roles[f.evidence.role])+(f.evidence.fixture?' <span class="evidence-warning">夹具</span>':'')+'<br>'+esc(f.name)+'</td><td>'+esc((f.size/1000).toFixed(1))+' KB</td><td>'+esc(time(f.received_at))+'</td><td>'+(f.state==='ready'?'<a class="traffic-link" href="'+esc(fileUrl(f))+'">下载原件</a><details><summary>SHA-256</summary>'+esc(f.sha256)+'</details>':'未封存')+'</td></tr>';
      h+='</tbody></table>';if(!s.files.length)h+='<p class="evidence-muted">本任务尚无关联证据</p>';
    }else{
      const reports=s.files.filter(f=>f.evidence.role==='report'&&f.state==='ready');h+='<select class="inp" data-report aria-label="选择系统对照报告">'+reports.map(f=>'<option value="'+esc(f.id)+'"'+(f.id===s.file?.id?' selected':'')+'>'+esc(f.name)+(f.evidence.fixture?' · 夹具':'')+'</option>').join('')+'</select>';
      if(!s.report)h+='<p class="evidence-muted">'+(s.file?'报告尚未读取':'尚无关联的系统对照报告')+'</p>';
      else{
        const r=s.report,c=r.configurationCoverage,known=c?.catalogId==='d31-finite-configuration'&&[1,2,3].includes(c.catalogVersion);
        h+='<p class="'+(s.file.evidence.fixture?'evidence-warning':'evidence-muted')+'">'+(s.file.evidence.fixture?'夹具报告，仅供离线结构验证。':'历史原始证据对照。')+' 未应用允许差异规则；运行效果和整机一致性未评估。</p>';
        h+='<div class="evidence-meta"><span>采集 '+esc(time(r.observation?.capturedAtMs))+'</span><span>有效至 '+esc(time(r.observation?.validUntilMs))+'</span><span>报告生成 '+esc(time(r.derivedAtMs))+'</span></div>';
        if(r.observation?.capturedAtMs>Date.now()||r.derivedAtMs>Date.now())h+='<p class="evidence-warning">存在未来时间，不能作为当前现场证据。</p>';else if(r.observation?.validUntilMs<Date.now())h+='<p class="evidence-warning">采集证据已超出声明有效期。</p>';
        h+='<p>有限配置目录：'+(known?esc(c.bothObservedItems)+' / '+esc(c.requiredItems)+' 项双方有证据，缺口 '+esc(c.gapItems)+' 项':'目录版本不受支持或未提供')+'</p>';
        if(known)h+='<details><summary>查看配置目录</summary><table><tr><th>项目</th><th>采集侧</th><th>固件侧</th><th>原始关系</th></tr>'+c.items.map(item=>'<tr><td>'+esc(items[item.id]||item.id||'未定义项目')+'</td><td>'+esc(textStatus(item.observation?.state))+'</td><td>'+esc(textStatus(item.firmware?.state))+'</td><td>'+esc(textStatus(item.pair))+'</td></tr>').join('')+'</table></details>';
        const pages=Math.max(1,Math.ceil(s.rows.length/40));s.page=Math.max(0,Math.min(s.page,pages-1));
        h+='<table><thead><tr><th>路径／字段</th><th>类别</th><th>原始关系</th><th>原件查证</th></tr></thead><tbody>';
        s.rows.slice(s.page*40,s.page*40+40).forEach((row,i)=>{const index=s.page*40+i;h+='<tr><td>'+esc(row.path)+'<br><span class="evidence-muted">'+esc(row.field)+'</span></td><td>'+esc(categories[row.category]||row.category)+'</td><td>'+esc(textStatus(row.pair))+'<details><summary>证据状态</summary>采集侧：'+esc(textStatus(row.observation?.state))+'<br>固件侧：'+esc(textStatus(row.firmware?.state))+'<br>'+esc((row.reasons||[]).join(' · '))+'</details></td><td><button class="traffic-link" data-proof="'+index+'" data-side="report">报告原行</button>';for(const side of ['observation','firmware']){const link=ElfEvidenceData.inputLink(r,side,row,s.files,s.file.evidence.diagnostic_id);h+=link?'<button class="traffic-link" data-proof="'+index+'" data-side="'+side+'">'+(side==='observation'?'采集原件':'固件原件')+'</button>':'<span class="evidence-muted">'+(side==='observation'?'采集':'固件')+'证据未关联</span> ';}h+='</td></tr>';});
        h+='</tbody></table><div class="evidence-pager">第 '+(s.page+1)+' 页 / 共 '+pages+' 页<button class="traffic-link" data-page="-1"'+(s.page===0?' disabled':'')+'>上一页</button><button class="traffic-link" data-page="1"'+(s.page+1===pages?' disabled':'')+'>下一页</button></div>';
        if(s.proof)h+='<div class="evidence-value"><strong>原JSON指针查证</strong><p>'+esc(s.proof.pointer)+'<br><span class="evidence-muted">SHA-256 '+esc(s.proof.sha256)+'</span></p><pre>'+esc(JSON.stringify(s.proof.value,null,2))+'</pre></div>';
      }
    }
    card.innerHTML=h+'</div></div>';
  }
  window.ElfEvidence={open,close};
}
export const evidenceClientSource='('+installEvidenceClient.toString()+')();';
