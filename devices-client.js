// 轨迹纯规则开始：界面与测试共用，保留原始记录，不改坐标。
var Trajectory=(function(){
  function time(value){var n=typeof value==='number'?value:Date.parse(value);return Number.isFinite(n)?n:NaN;}
  function cadence(r){var n=Number(r.report_interval_ms);return n>=60000&&n<=86400000?n:(r.network==='wifi'||r.network==='ethernet'?900000:3600000);}
  function location(r){var p=r&&r.location;return p&&p.lat!=null&&p.lng!=null&&Number.isFinite(Number(p.lat))&&Number.isFinite(Number(p.lng))&&Math.abs(Number(p.lat))<=90&&Math.abs(Number(p.lng))<=180?p:null;}
  function quality(r){var p=location(r);if(!p)return 'gap';var at=time(r.sample_at||p.at),event=time(r.timeline_at);if(Number.isFinite(at)&&Number.isFinite(event)&&(at>event+60000||event-at>cadence(r)*2))return 'gap';
    if(p.source==='ip')return 'area';var a=Number(p.acc_m);
    if(p.source==='gps'&&(p.acc_m==null||a>0&&a<=100))return 'good';
    if(['wifi','cell','network','gps'].includes(p.source)&&a>0)return a<=100?'good':'coarse';return 'gap';}
  function distance(a,b){var rad=Math.PI/180,dy=(b.lat-a.lat)*rad,dx=(b.lng-a.lng)*rad;var q=Math.sin(dy/2)**2+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin(dx/2)**2;return 12742000*Math.asin(Math.sqrt(Math.min(1,q)));}
  function build(input){var rows=input.filter(function(r){return Number.isFinite(time(r.timeline_at));}).slice().sort(function(a,b){return time(a.timeline_at)-time(b.timeline_at)||String(a.report_id).localeCompare(String(b.report_id));});
    var segments=[],areas=[],ignored=[],part=[],pending=[],last=-1;
    function flush(){if(part.length)segments.push(part);part=[];}
    rows.forEach(function(r,i){var kind=quality(r);if(kind==='good'){
      var gap=last>=0&&time(r.timeline_at)-time(rows[last].timeline_at)>2.5*Math.max(cadence(r),cadence(rows[last]));
      if(pending.length>=2||gap){flush();areas=areas.concat(pending);}else if(pending.length===1)ignored.push(pending[0]);
      pending=[];part.push(i);last=i;
    }else if(kind==='coarse'){pending.push(i);}else{flush();areas=areas.concat(pending);pending=[];last=-1;if(location(r))areas.push(i);}});
    // 尾部只有一个粗点时暂不跨接；后续完整查询再判断，不由游标改变规则。
    areas=areas.concat(pending.length>=2?pending:[]);ignored=ignored.concat(pending.length===1?pending:[]);flush();
    var groups=[];segments.forEach(function(segment){var group=[];function finish(){if(group.length)groups.push(group);group=[];}
      segment.forEach(function(i){if(group.length&&distance(location(rows[group[0]]),location(rows[i]))>Math.max(25,Math.min(100,Number(location(rows[i]).acc_m)||25)))finish();group.push(i);});finish();});
    return {rows:rows,segments:segments,areas:areas,ignored:ignored,groups:groups};
  }
  function events(rows,media,range){var known=new Map(rows.map(function(r){return [r.report_id,r];}));var out=rows.map(function(r,i){return {key:'report:'+r.report_id,at:time(r.timeline_at),record:r,index:i};});
    media.forEach(function(m){if(m.type==='photo'&&known.has(m.report_id))return;var at=time(m.captured_at);if(!Number.isFinite(at))return;if(range){if(at>range.to||time(m.ended_at||m.captured_at)<range.from)return;at=Math.max(at,range.from);}out.push({key:m.type+':'+m.id,at:at,media:m,index:-1});});
    return out.sort(function(a,b){return a.at-b.at||a.key.localeCompare(b.key);});
  }
  function related(event,media){if(!event)return [];return media.filter(function(m){if(event.media&&event.media.id===m.id&&event.media.type===m.type)return true;
    if(m.type==='photo')return event.record&&m.report_id===event.record.report_id;
    return event.at>=time(m.captured_at)&&event.at<=time(m.ended_at||m.captured_at);});}
  function dayRange(from,to){function midnight(day){var utc=Date.parse(day+'T00:00:00Z');if(!Number.isFinite(utc))throw Error('日期无效');var n=utc;
    for(var i=0;i<3;i++){var p={};new Intl.DateTimeFormat('en-GB',{timeZone:'Australia/Sydney',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(n)).forEach(function(x){p[x.type]=x.value;});n+=utc-Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second);}return n;}
    var next=new Date(Date.parse(to+'T00:00:00Z')+86400000).toISOString().slice(0,10);return {from:midnight(from),to:midnight(next)-1};}
  function playbackIndex(events,item,at){var selected=events.findIndex(function(e){return e.media&&e.media.type===item.type&&e.media.id===item.id;});events.forEach(function(e,i){if(e.record&&e.at>=time(item.captured_at)&&e.at<=at)selected=i;});return selected;}
  function preceding(events,at){var low=0,high=events.length;while(low<high){var mid=(low+high)>>1;if(events[mid].at<=at)low=mid+1;else high=mid;}return low-1;}
  function nearest(events,at){var low=0,high=events.length;while(low<high){var mid=(low+high)>>1;if(events[mid].at<at)low=mid+1;else high=mid;}if(!low)return 0;if(low===events.length)return low-1;return at-events[low-1].at<=events[low].at-at?low-1:low;}
  return {time:time,cadence:cadence,location:location,quality:quality,distance:distance,build:build,events:events,related:related,dayRange:dayRange,nearest:nearest,preceding:preceding,playbackIndex:playbackIndex};
})();
// 轨迹纯规则结束。

var DEV = [];
var UNPAIRED = [];
var MODELS = [];
var selDev = "";
var selFn = "adb";
var map = null;
var markers = {};
var circles = {};
var UI = {};
var STATUS = {};
var REQUEST_TIMING = {};
var mapFitted = false;
var markerGroups = [];
var historyMarker = null;
var deviceLoad = null;

var FN_ITEMS = [
  ["adb", "远程终端", '<rect x="3" y="4" width="18" height="14" rx="2"></rect><path d="M8 20h8M12 18v2"></path><path d="M7 10h.01M10 10h6"></path>'],
  ["update", "更新客户端", '<path d="M21 12a9 9 0 1 1-3-6.7"></path><polyline points="21 3 21 9 15 9"></polyline>'],
  ["wifi", "系统配置", '<path d="M9.5 3h5l.6 2.4 2.1 1.2 2.4-.7 2.5 4.2-1.8 1.7v2.4l1.8 1.7-2.5 4.2-2.4-.7-2.1 1.2-.6 2.4h-5l-.6-2.4-2.1-1.2-2.4.7-2.5-4.2 1.8-1.7v-2.4L1.9 10l2.5-4.2 2.4.7 2.1-1.2z" transform="translate(1 0) scale(.92)"/><circle cx="12" cy="12" r="3"/>'],
  ["contacts", "通信录", '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle>'],
  ["locate", "设备轨迹", '<path d="M12 21s7-6 7-11a7 7 0 1 0-14 0c0 5 7 11 7 11z"></path><circle cx="12" cy="10" r="2.5"></circle>'],
  ["files", "文件管理", '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"></path>'],
  ["lost", "丢失模式", '<path d="M12 3l8 4v5c0 5-3.5 8.5-8 9.5C7.5 20.5 4 17 4 12V7l8-4z"></path>'],
  ["model", "添加型号", '<rect x="3" y="3" width="7" height="7" rx="1"></rect><rect x="14" y="3" width="7" height="7" rx="1"></rect><rect x="3" y="14" width="7" height="7" rx="1"></rect><path d="M17 14v8M14 18h8"></path>']
];

function $(id){ return document.getElementById(id); }
function show(id){ $(id).style.display = "flex"; }
function hide(id){ $(id).style.display = "none"; }
function sydney(iso){
  if(!iso) return "—";
  try {
    return new Date(iso).toLocaleString("zh-CN", { timeZone: "Australia/Sydney", hour12: false });
  } catch(e){ return String(iso); }
}
function locLabel(src){
  if(src==="gps") return "GPS";
  if(src==="wifi") return "Wi-Fi";
  if(src==="cell") return "基站";
  if(src==="network") return "Wi-Fi / 基站";
  if(src==="ip") return "IP 大致区域";
  return "未知";
}
function managerLabel(d){
  if(!d) return "—";
  var raw = String(d.app_version||"").trim();
  if(!raw) return "elfRemote";
  var v = raw.split("-")[0].trim();
  if(!v || /^elfremote$/i.test(v)) return "elfRemote";
  return "elfRemote "+v;
}
function modelName(id){
  for(var i=0;i<MODELS.length;i++) if(MODELS[i].id===id) return MODELS[i].name;
  return id || "—";
}
function currentDev(){
  for(var i=0;i<DEV.length;i++) if(DEV[i].id===selDev) return DEV[i];
  return null;
}
function deviceReady(){
  var d = currentDev();
  return !!(d && d.enabled !== false);
}
function disAttr(){ return deviceReady() ? "" : " disabled"; }
function nowIso(){ return new Date().toISOString(); }
function uiOf(device){
  var d = device || currentDev();
  if(!d) return null;
  if(!UI[d.id]){
    UI[d.id] = {
      loc: [],
      alarm: [],
      wifi: [],
      wifiSel: "",
      wifiLastOk: "",
      contacts: [],
      updates: [],
      photos: [],
      recs: [],
      shell: { connected: false, lines: [], hist: [], histI: 0 },
      talk: false,
      live: ""
    };
  }
  var adb = UI[d.id].shell;
  if(!adb || !Array.isArray(adb.lines)){
    UI[d.id].shell = { connected: false, lines: [], hist: [], histI: 0 };
  } else {
    if(!Array.isArray(adb.hist)) adb.hist = [];
    if(adb.histI == null) adb.histI = adb.hist.length;
  }
  if(!UI[d.id].adb) UI[d.id].adb={connected:false,lines:[]};
  return UI[d.id];
}

function checkAuth(){
  adminSession.check(loadDevices);
}
function doLogin(){
  fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:$("lu").value,password:$("lp").value})})
  .then(function(r){return r.json();}).then(function(d){
    if(d.ok){ adminSession.accept(); hide("loginWrap"); loadDevices(); }
    else { $("lerr").style.display="block"; $("lerr").innerText=d.msg||"登录失败"; }
  }).catch(function(){ $("lerr").style.display="block"; $("lerr").innerText="登录失败"; });
}
function logout(){ if(panelEvents)panelEvents.stop();return adminSession.logout(); }

var SERVICE_ERRORS={};
function serviceErrorText(){
  var d=currentDev(),errors=[SERVICE_ERRORS.devices,d&&SERVICE_ERRORS['traffic:'+d.id]].filter(Boolean);
  var quota=errors.find(function(e){return e.code==='storage_quota_exceeded';});
  return quota?quota.message:Array.from(new Set(errors.map(function(e){return e.message;}))).join(' · ');
}
function setServiceError(source,error){
  if(error)SERVICE_ERRORS[source]=error;else delete SERVICE_ERRORS[source];
  var el=$('serviceError');if(!el){renderRemoteConsole();el=$('serviceError');}
  if(el){el.textContent=serviceErrorText();el.hidden=!el.textContent;}
}
async function readServiceJson(r){
  var data;try{data=await r.json();}catch(e){if(r.ok)throw Error('服务器返回的数据无效');data={};}
  if(!r.ok||data.ok===false){
    var e=Error(data.code==='storage_quota_exceeded'?'CF 额度已用尽，等待恢复':r.status>=500?'服务器暂不可用':data.msg||'请求失败（'+r.status+'）');
    e.code=data.code;e.retryAfter=Math.min(900,Math.max(0,Number(r.headers&&r.headers.get('Retry-After'))||0))*1000;throw e;
  }return data;
}
function loadDevices(){
  if(deviceLoad) return deviceLoad;
  function read(url){return fetch(url).then(readServiceJson).catch(function(e){if(e.retryAfter)devicePollRetryAt=Date.now()+e.retryAfter;throw e;});}
  deviceLoad = read("/api/devices").then(function(snapshot){
    var arr=[snapshot,snapshot];
    if(!Array.isArray(arr[0].devices) || !Array.isArray(arr[1].models)) throw new Error('刷新返回无效');
    var previousId=selDev;
    var previousSip=uiOf()&&uiOf().sipSelection;
    var savedInputs=Array.from($("devOps").querySelectorAll('input[id],textarea[id],select[id]')).filter(function(el){return el.type!=='file';}).map(function(el){return {id:el.id,value:el.value,checked:el.checked};});
    if(arr[0].devices) DEV = arr[0].devices;
    UNPAIRED = arr[0].unpaired || [];
    DEV.forEach(function(d){var t=d.task;if(t&&t.type==='root_exec'&&['pending','claimed','running'].includes(t.state)){
      var u=uiOf(d);if(!u.shell.pending){u.shell.pending=t.id;watchCommand(d.id,t.id,u);}
    } else if(t && t.type==='root_exec') {commandResult(uiOf(d),t);}});
    if(arr[1].models) MODELS = arr[1].models;
    if(!currentDev() && DEV.length) selDev = DEV[0].id;
    renderList(); updateReportFeedback();
    renderMap();
    var editing = $("devOps").contains(document.activeElement) && document.activeElement.matches("input,textarea,select,[contenteditable=true]");
    if(!editing){
      renderOps();
      if(previousId===selDev){
        savedInputs.forEach(function(saved){if(saved.id==='sipAccountSlot'||((saved.id.indexOf('sipAccount')===0||saved.id.indexOf('managedSip')===0)&&previousSip!==(uiOf()&&uiOf().sipSelection)))return;var el=$(saved.id);if(el){el.value=saved.value;if(typeof saved.checked==='boolean') el.checked=saved.checked;}});
      }
    }
    if(editing) renderRemoteConsole();

    setServiceError('devices',null);
    devicePollFailures=0;devicePollRetryAt=0;lastPollAt=Date.now();
    deviceRefreshAt=lastPollAt+Math.min(300000,Math.max(1000,Number(snapshot.refresh_after_ms)||300000));
    if(panelEvents)panelEvents.tick();return true;
  }).catch(function(error){
    devicePollFailures++;lastPollAt=Date.now();
    setServiceError('devices',error);
    return false;
  }).finally(function(){deviceLoad=null;});
  return deviceLoad;
}

function deviceListStatus(d){
  if(d.enabled===false) return "已停用";
  var update=d.update;
  if(update && update.state && !["success","recovered","rejected"].includes(update.state)) return update.label || "升级中";
  var task=d.task;
  if(task && ["pending","claimed","running"].includes(task.state)) return (task.type_label || "任务")+" · "+(task.label || "执行中");
  return STATUS[d.id] || (d.contact_state==="awaiting_full_report" ? "设备已响应，等待报告" : d.contact_state==="checking_connection" ? "正在检查连接" : d.contact_state==="report_overdue" ? "报告超时" : "等待上报信息");
}
function requestListedDeviceStatus(id){
  var d=DEV.find(function(device){return device.id===id;});
  if(!d || deviceListStatus(d)!=="等待上报信息") return false;
  return requestDeviceStatus(id);
}
var STATUS_SEEN={};
function reconcileReportStatus(d){
  if(["拉取失败","拉取超时"].includes(STATUS[d.id]) && d.last_seen && d.last_seen!==STATUS_SEEN[d.id]) STATUS[d.id]="";
}

function renderList(){
  var box = $("devList");
  if(!DEV.length && !UNPAIRED.length){
    box.innerHTML = '<p class="muted">还没有设备</p>';
    return;
  }
  var h = "";
  for(var i=0;i<DEV.length;i++){
    var d = DEV[i];

    var on = d.online && d.enabled!==false;
    var cls = "dev-row" + (d.id===selDev ? " sel" : "");
    reconcileReportStatus(d);
    h += '<div class="'+cls+'" onclick="selectDev(\''+d.id+'\')">';
    h += '<span class="dot '+(on?"dot-on":"dot-off")+'"></span>';
    h += '<span class="dev-identity"><span class="dev-name'+(d.paired===false?' unpaired-name':'')+'"'+(d.paired===false?' title="未配对"':'')+'>'+esc(d.name)+'</span>';
    h += '</span>';
    var status = deviceListStatus(d), clickable=status==="等待上报信息";
    h += '<span class="report-status" role="'+(clickable?'button':'status')+'" tabindex="'+(clickable?'0':'-1')+'" title="'+esc(clickable?'拉取设备信息':status)+'" aria-disabled="'+(!clickable)+'" onclick="event.stopPropagation();requestListedDeviceStatus(\''+d.id+'\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();event.stopPropagation();requestListedDeviceStatus(\''+d.id+'\')}">'+esc(status)+'</span>';
    h += '</div>';
  }
  for(var j=0;j<UNPAIRED.length;j++){
    var pending = UNPAIRED[j];
    h += '<div class="dev-row" onclick="selectUnpaired('+j+')"><span class="dot dot-off"></span><span class="dev-name">'+esc(pending.name)+'</span><span class="tag">未配对</span></div>';
  }
  box.innerHTML = h || '<p class="muted">没有符合条件的设备</p>';
}

function selectUnpaired(index){
  var pending = UNPAIRED[index];
  if(!pending) return;
  if(pending.id) selectDev(pending.id);
}

function reportFeedback(d){
  if(!d || !REQUEST_TIMING[d.id])return '';
  var t=REQUEST_TIMING[d.id];
  if(t.completedMs!=null)return '信息已更新 · 用时 '+(t.completedMs/1000).toFixed(1)+' 秒';
  if(STATUS[d.id]==='拉取超时')return '暂未收到设备信息，请稍后重试';
  if(STATUS[d.id]==='拉取失败')return '更新失败，请重试';
  return t.receivedMs!=null?'设备正在上报信息…':'正在获取设备信息…';
}
function updateReportFeedback(){var el=$('reportFeedback');if(el)el.textContent=reportFeedback(currentDev());}
async function requestDeviceStatus(id){
  if(["拉取中","等待设备领取","等待完整上报"].includes(STATUS[id])) return false;
  var device=DEV.find(function(d){return d.id===id;});
  STATUS_SEEN[id]=device && device.last_seen;
  STATUS[id]="拉取中"; renderList(); updateReportFeedback();
  var started=performance.now();
  REQUEST_TIMING[id]={};
  try {
    var result = await (await fetch("/api/devices/request-status", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({device_id:id})})).json();
    if(!result.ok) throw new Error(result.msg || "请求失败");
    var requestId = result.request && result.request.request_id;
    STATUS[id]="等待设备领取"; renderList(); updateReportFeedback();
    for(var attempt=0;attempt<150;attempt++){
      await new Promise(function(resolve){setTimeout(resolve,2000);});
      var state = await (await fetch("/api/devices/status-request?device_id="+encodeURIComponent(id))).json();
      if(!state.ok) throw new Error(state.msg || "查询失败");
      if(state.request && state.request.request_id===requestId && state.request.received_at && REQUEST_TIMING[id].receivedMs==null){
        REQUEST_TIMING[id].receivedMs=Math.round(performance.now()-started);
        STATUS[id]="等待完整上报"; renderList(); updateReportFeedback();
      }
      if(state.request && state.request.request_id===requestId && state.request.state==="completed") {
        REQUEST_TIMING[id].completedMs=Math.round(performance.now()-started);
        STATUS[id]=""; await loadDevices(); return true;
      }
      if(state.request && state.request.state==="expired") break;
    }
    STATUS[id]="拉取超时";
  } catch(error) { STATUS[id]="拉取失败"; }
  renderList(); updateReportFeedback();
  return false;
}

async function refreshAllDevices(){
  var button=$("refreshDevices");
  button.disabled=true;
  try {
    if(!await loadDevices()) return;
    await Promise.allSettled(DEV.map(function(d){return requestDeviceStatus(d.id);}));
    await loadDevices();
  } finally {button.disabled=false;}
}

function esc(s){
  return String(s||"").replace(/[&<>"']/g, function(c){
    return ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" })[c];
  });
}

function selectDev(id){
  trajectoryLeave();
  selDev = id;
  renderList(); updateReportFeedback();
  renderOps();
  flyTo(id);
  if(selFn==='files')loadFileManagerOnEntry();
  if(selFn==='update')loadReleases();
  if(selFn==='locate'){var history=historyState();if(!history.loaded)queryHistory();else{history.historical=history.events.length>0;renderOps();trajectoryDrawMap(true);}}
}

function initMap(){
  if(map || typeof L === "undefined") return;
  map = L.map("devMap", { zoomControl: true, attributionControl: true }).setView([-33.87, 151.21], 4);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap"
  }).addTo(map);
  map.on("zoom move", layoutMapMarkers);
}

function deviceColor(id, online){
  var pal = ["#38bdf8","#a78bfa","#f472b6","#34d399","#fbbf24","#fb7185","#22d3ee","#818cf8"];
  var index = DEV.map(function(d){return d.id;}).sort().indexOf(id);
  var c = pal[Math.max(0,index)%pal.length];
  return online ? c : "#64748b";
}
function batteryText(d){
  if(d && d.battery_present===false)return "外接电源";
  return (!d || d.battery==null ? "—" : d.battery+"%") + (d && d.charging===true ? " · 充电中" : "");
}
function battHtml(pct, charging, present){
  if(present===false)return '<span class="mbatt mplug" title="外接电源" role="img" aria-label="外接电源"><svg width="18" height="11" viewBox="0 0 18 11" fill="none" stroke="#cbd5e1" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path fill="#0f172a" d="M12.5 1.5v8H8a4 4 0 0 1 0-8h4.5Z"/><path d="M12.5 3.5h4m-4 4h4M4 5.5H.5"/></svg></span>';
  var p = pct==null || !isFinite(Number(pct)) ? -1 : Math.max(0, Math.min(100, Math.round(Number(pct))));
  var fill = p<0 ? 0 : p;
  var col = p<0 ? "#64748b" : (p<=20 ? "#f87171" : (p<=50 ? "#fbbf24" : "#4ade80"));
  var title = p<0 ? "电量未知" : ("电量 "+p+"%");
  if(charging===true) title += " · 充电中";
  var bolt = charging===true ? '<svg class="mbatt-bolt" viewBox="0 0 10 14" aria-hidden="true"><path d="M6 1 1 8h4l-1 5 5-7H5z"/></svg>' : '';
  return '<span class="mbatt" title="'+title+'"><span class="mbatt-b"><span class="mbatt-l" style="width:'+fill+'%;background:'+col+'"></span>'+bolt+'</span><span class="mbatt-n"></span></span>';
}
function reportTime(d){ return d && (d.last_reported_at || d.last_seen); }
function pinHtml(d, selected){
  var on = d.online && d.enabled!==false;
  var col = deviceColor(d.id, on);
  var seen = sydney(reportTime(d));
  return '<div class="dpin'+(selected?" pin-on":"")+'">'+
    '<div class="dpin-dot" style="background:'+col+';box-shadow:0 0 0 1px #0f172a,0 0 0 2px '+col+'"></div>'+
    '<div class="dpin-card">'+
      '<div class="dpin-name"><span>'+esc(d.name||"")+'</span> '+battHtml(d.battery,d.charging,d.battery_present)+'</div>'+
      '<div class="dpin-time" title="'+esc('数据时间：'+seen+'；服务器接收：'+sydney(d.last_seen))+'">'+esc(seen)+'</div>'+
    '</div></div>';
}

function renderMap(){
  initMap();
  if(!map) return;
  setTimeout(function(){ map.invalidateSize(); }, 50);
  Object.keys(markers).forEach(function(k){ map.removeLayer(markers[k]); });
  Object.keys(circles).forEach(function(k){ map.removeLayer(circles[k]); });
  markers = {}; circles = {};
  var bounds = [];
  var hasIpArea = false;
  markerGroups = markerLocationGroups(DEV.filter(function(d){return d.online && d.loc;}), function(a,b){return map.distance(a,b);});
  for(var i=0;i<DEV.length;i++){
    var d = DEV[i];
    if(!d.online || !d.loc || !isFinite(d.loc.lat) || !isFinite(d.loc.lng)) continue;
    var ll = [d.loc.lat, d.loc.lng];
    var gps = d.loc.source==="gps";
    var acc = Number(d.loc.acc_m);
    if(gps){
      if(!(acc>0) || acc>300) acc = 50;
    } else {
      if(!(acc>0)) acc = 2000;
    }
    var col = deviceColor(d.id, d.online && d.enabled!==false);
    var circ = L.circle(ll, {
      radius: acc,
      color: col,
      weight: gps ? 1 : 2,
      fillColor: col,
      fillOpacity: gps ? 0.16 : 0.2
    }).addTo(map);
    circles[d.id] = circ;
    var tb = circ.getBounds();
    bounds.push(tb.getSouthWest());
    bounds.push(tb.getNorthEast());
    if(!gps) hasIpArea = true;
    (function(id, dev){
      circ.on("click", function(){ selectDev(id); });
      var ic = L.divIcon({
        className: "dpin-wrap",
        html: pinHtml(dev, id===selDev),
        iconSize: [170, 32],
        iconAnchor: [4, 14]
      });
      markers[id] = L.marker(ll, { icon: ic, zIndexOffset: id===selDev ? 600 : 200 })
        .addTo(map).on("click", function(){ selectDev(id); });
    })(d.id, d);
  }
  if(bounds.length && !mapFitted) { map.fitBounds(bounds, { padding: [100,100], maxZoom: hasIpArea ? 14 : 16 }); mapFitted=true; }
  layoutMapMarkers();
  if(trajectoryEvent())trajectoryDrawMap(false);
}

function layoutMapMarkers(){
  if(!map) return;
  markerGroups.forEach(function(group){
    var origin=map.latLngToContainerPoint(group.anchor);
    group.devices.forEach(function(d,index){
      if(!markers[d.id]) return;
      var point=L.point(origin.x,origin.y+(index-(group.devices.length-1)/2)*12);
      markers[d.id].setLatLng(map.containerPointToLatLng(point));
    });
  });
}

function markerLocationGroups(devices, distance){
  var groups = [];
  devices.slice().sort(function(a,b){return a.id.localeCompare(b.id);}).forEach(function(device){
    var loc=device.loc;
    if(loc.lat==null || loc.lng==null || !isFinite(loc.lat) || !isFinite(loc.lng)) return;
    var point=[Number(loc.lat),Number(loc.lng)];
    var group=groups.find(function(candidate){return candidate.devices.every(function(other){
      if(other.loc.source!==loc.source) return false;
      return distance(point,[Number(other.loc.lat),Number(other.loc.lng)]) <= (loc.source==="gps" ? 25 : 1);
    });});
    if(!group){group={anchor:point,devices:[]};groups.push(group);}
    group.devices.push(device);
  });
  return groups;
}

function flyTo(id){
  var d = null;
  for(var i=0;i<DEV.length;i++) if(DEV[i].id===id) d = DEV[i];
  if(!d || !d.loc || !map) { renderMap(); return; }
  renderMap();
  if(d.loc.source==="gps"){
    map.flyTo([d.loc.lat, d.loc.lng], 16, { duration: 0.5 });
  } else if(circles[id]){
    map.fitBounds(circles[id].getBounds(), { padding: [36,36], maxZoom: 14 });
  }
}

function kv(k,v,title){ return '<div class="kv"><div class="k">'+k+'</div><div class="v"'+(title?' title="'+esc(title)+'"':'')+'>'+esc(v)+'</div></div>'; }

function pickFn(id){
  if(selFn!==id)trajectoryLeave();
  selFn = id;
  renderOps();
  if(id==='locate'){var history=historyState();if(history&&!history.loaded)queryHistory();else if(history){history.historical=history.events.length>0;renderOps();trajectoryDrawMap(true);}}
  if(id==='update')loadReleases();
  if(id==='files')loadFileManagerOnEntry();
  if(id==='wifi'&&SYSTEM_TAB!=='账号配置')readSystemSettings();
}

function onFnClick(ev){
  var t = ev.target;
  while(t && t !== ev.currentTarget && !t.getAttribute("data-fn")) t = t.parentNode;
  if(!t || !t.getAttribute("data-fn")) return;
  pickFn(t.getAttribute("data-fn"));
}

function renderOps(){
  renderRemoteConsole();
  var box = $("devOps");
  var d = currentDev();
  var dis = d ? "" : " disabled";
  var bat = batteryText(d);
  var net = !d ? "—" : (d.network==="wifi" ? "Wi-Fi" : (d.network==="cellular" ? "移动数据" : (d.network==="ethernet" ? "有线网络" : "未知")));
  var src = d && d.loc ? locLabel(d.loc.source) : "—";
  if(d && d.loc && d.loc.source==="gps" && d.loc.lat!=null && d.loc.lng!=null && isFinite(Number(d.loc.lat)) && isFinite(Number(d.loc.lng))) {
    src = "GPS · " + Number(d.loc.lat).toFixed(6) + " · " + Number(d.loc.lng).toFixed(6);
  } else if(d && d.loc) {
    src = ({ip:"IP",wifi:"Wi-Fi",cell:"Cell",network:"Wi-Fi / Cell"})[d.loc.source] || locLabel(d.loc.source);
    if(Number(d.loc.acc_m)>0) src += " · " + Math.round(Number(d.loc.acc_m)) + "m";
  }
  var shell = !d ? "—" : ((uiOf() && uiOf().adb && uiOf().adb.connected) ? "已连接" : "未连接");
  var h = "";
  h += '<div class="ops-head"><div class="ops-head-left"><h3>功能设置</h3>';
  if(d) h += '<span class="muted">'+esc(d.name)+" · "+esc(d.model_name||modelName(d.model_id))+"</span>";
  else h += '<span class="muted">请先从左侧选择设备，或点「添加设备」</span>';
  h += '<span id="reportFeedback" class="report-feedback" role="status">'+esc(reportFeedback(d))+'</span>';
  h += '</div><div class="ops-head-actions">';
  h += '<button class="device-action action-edit" onclick="openEdit()"'+dis+'>编辑</button>';
  if(d && d.enabled===false) h += '<button class="device-action action-enable" onclick="setEnabled(true)">启用</button>';
  else h += '<button class="device-action action-disable" onclick="setEnabled(false)"'+dis+'>停用</button>';
  if(d && d.paired===false) h += '<button class="device-action action-pair" onclick="openPairSelected()">立即配对</button>';
  else h += '<button class="device-action action-unpair" onclick="delDev()"'+dis+'>解除配对</button>';
  h += "</div></div>";
  h += '<div class="ops-grid">';
  h += kv(d && d.battery_present===false ? "供电" : "电量", bat);
  h += kv("网络", net);
  h += kv("IP & MAC", (d && d.ip ? d.ip : "—") + " / " + (d && d.mac ? d.mac : "未获取"));
  h += kv("定位", src);
  h += kv("系统", d && d.os_version ? d.os_version : "—");
  h += kv("客户端版本", d ? managerLabel(d) : "—");
  h += kv("最后上报", d ? sydney(reportTime(d)) : "—", d ? '数据时间；服务器接收：'+sydney(d.last_seen) : '');
  h += kv("远程ADB", shell);
  h += "</div>";
  h += '<div class="fn-menu" onclick="onFnClick(event)">';
  for(var i=0;i<FN_ITEMS.length;i++){
    var it = FN_ITEMS[i];
    h += '<button type="button" class="fn-btn'+(selFn===it[0]?" on":"")+'" data-fn="'+it[0]+'">';
    h += '<svg class="fn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'+it[2]+"</svg>";
    h += "<span>"+it[1]+"</span></button>";
  }
  h += "</div>";
  h += '<div class="fn-page">'+fnPageHtml()+"</div>";
  disposeAdbView();box.innerHTML = h;
  terminalBind();bindAdbView();
}

function fnPageHtml(){
  var dis = disAttr();
  if(selFn==="update") return pageUpdate(dis);
  if(selFn==="wifi") return pageSystem(dis);
  if(selFn==="contacts") return functionSection('联系人管理',pageContacts(dis));
  if(selFn==="locate") return pageLocate(dis);
  if(selFn==="files") return pageFiles();
  if(selFn==="lost") return pageLost(dis);
  if(selFn==="model") return functionSection('型号管理',pageModel());
  return pageAdb(dis);
}

function functionSection(title,content){
  return '<section class="function-section"><h4>'+esc(title)+'</h4><div class="function-content">'+content+'</div></section>';
}
function powerOptions(value){
  return [['auto','自动识别'],['battery','电池设备'],['external','外接电源']].map(function(p){return '<option value="'+p[0]+'"'+(value===p[0]?' selected':'')+'>'+p[1]+'</option>';}).join('');
}
function pageModel(){
  var h='<div class="ops-actions"><input id="mName" class="inp" placeholder="型号名称"><input id="mNote" class="inp" placeholder="备注"><select id="mPower" class="inp" style="width:auto;min-width:112px;min-height:32px;padding:5px 9px" aria-label="供电方式">'+powerOptions('auto')+'</select><button class="btn-green" onclick="addModel()">添加型号</button></div><div class="function-table"><table><thead><tr><th>型号</th><th>备注</th><th>供电方式</th><th>操作</th></tr></thead><tbody>';
  MODELS.forEach(function(m,i){h+='<tr><td>'+esc(m.name)+'</td><td>'+esc(m.note||'—')+'</td><td><select class="inp" style="width:auto;min-width:112px;min-height:32px;padding:5px 9px" aria-label="'+esc(m.name)+'供电方式" onchange="setModelPower(MODELS['+i+'].id,this.value)">'+powerOptions(m.power_type||'auto')+'</select></td><td><button class="btn-gray" onclick="editModel(MODELS['+i+'].id)">编辑</button> <button class="btn-gray" onclick="delModel(MODELS['+i+'].id)">删除</button></td></tr>';});
  return h+(MODELS.length?'':'<tr><td colspan="4" class="muted">暂无型号</td></tr>')+'</tbody></table></div>';
}
function setModelPower(id,value){
  var m=MODELS.find(function(row){return row.id===id;});if(!m)return;
  fetch('/api/device-models',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:m.id,name:m.name,note:m.note||'',icon:m.icon||'',power_type:value})})
  .then(function(r){return r.json();}).then(function(d){if(!d.ok)throw Error(d.msg||'保存失败');MODELS=d.models;loadDevices();})
  .catch(function(e){alert(e.message);renderOps();});
}
var MAINTENANCE_RUN={};
var MAINTENANCE_CAPS={configure_zello:'managed_zello_account',configure_sip:'managed_sip_account',get_file:'managed_file_return',send_file:'managed_file_tasks',pull_logs:'managed_log_tasks',heal_network:'managed_heal_tasks',reboot:'managed_reboot_tasks',restart_adbd:'managed_adbd_tasks'};
function maintenanceAvailable(d,type){
  if(!d || d.enabled===false || (MAINTENANCE_RUN[d.id] && MAINTENANCE_RUN[d.id].pending))return false;
  if(d.status_only && d[MAINTENANCE_CAPS[type]]!==true)return false;
  var t=d.task,expires=t && (Number(t.expires_at)||Date.parse(t.expires_at));
  return !(t && ['pending','claimed','running'].includes(t.state) && !(Number.isFinite(expires)&&Date.now()>=expires));
}
function pageAdb(dis){
  var d=currentDev(),u=uiOf(),t=d&&d.task?d.task:{},r=['root_exec','file_manage','send_file','get_file','configure_sip','configure_zello'].includes(t.type)?{}:t.result||{};
  var ready=!!(d&&d.managed_exec_tasks),blocked=!!(dis||!ready||(u&&u.shell.pending));
  var run= d && MAINTENANCE_RUN[d.id];
  var st=run?(run.pending?'下发中':run.error?'下发失败':run.id===t.id?(t.label||t.state||''):''):'';
  var h = '<span class="terminal-actions">';
  h += '<button class="'+(maintenanceAvailable(d,'pull_logs')?'btn-green':'btn-gray')+'" onclick="enqueueRepair(\'pull_logs\')"'+(maintenanceAvailable(d,'pull_logs')?'':' disabled')+'>拉取日志</button>';
  h += '<button class="'+(maintenanceAvailable(d,'heal_network')?'btn-green':'btn-gray')+'" onclick="enqueueRepair(\'heal_network\')"'+(maintenanceAvailable(d,'heal_network')?'':' disabled')+'>强制自愈</button>';
  h += '<button class="'+(maintenanceAvailable(d,'reboot')?'btn-green':'btn-gray')+'" onclick="enqueueRepair(\'reboot\')"'+(maintenanceAvailable(d,'reboot')?'':' disabled')+'>受控重启</button>';
  h += '<button class="'+(maintenanceAvailable(d,'restart_adbd')?'btn-green':'btn-gray')+'" onclick="enqueueRepair(\'restart_adbd\')"'+(maintenanceAvailable(d,'restart_adbd')?'':' disabled')+'>重启adbd</button>';
  h += '</span>';

  var lines=u?u.shell.lines:[], output=esc(r.text||'');
  for(var i=0;i<lines.length;i++) output+='<span class="adb-'+esc(lines[i].k)+'">'+esc(lines[i].t)+'\n</span>';
  if(!output)output='<span class="adb-sys">'+(ready?'等待输入命令':'客户端维护核心未就绪')+'</span>';
  var left='<section class="monitor"><h4 class="monitor-heading"><span class="terminal-title">通用终端</span>'+h+'</h4><pre class="adb-term task-result" id="taskOut">'+output+'</pre>';
  left+='<div class="adb-row"><span class="adb-prompt">shell&gt;</span><input id="shellCmd" class="inp adb-cmd" autocomplete="off" spellcheck="false" placeholder="pm list packages"'+(blocked?' disabled':'')+'>';
  left+='<button class="btn-green" onclick="shellSend()"'+(blocked?' disabled':'')+'>发送</button>';
  if(u&&u.shell.pending)left+='<button class="btn-gray" onclick="cancelCommand()"'+(u.shell.cancelRequested?' disabled':'')+'>'+(u.shell.cancelRequested?'停止中':'停止')+'</button>';
  left+='</div></section>';
  var foot='';
  if(st)foot+='<span class="maintenance-status'+(run.id===t.id && t.state==='success'?' maintenance-success':'')+'" role="status">'+esc(st)+'</span>';
  if(t.type==='send_file')foot+='<a class="log-download" href="#" onclick="openSendFile();return false">'+esc(t.detail||'等待设备接收文件')+'</a>';
  if(t.type==='get_file')foot+='<a class="log-download" href="#" onclick="openReturnFile();return false">'+esc(t.state==='success'?'下载文件':t.detail||'等待设备取回文件')+'</a>';
  if(d&&r.artifact)foot+='<a class="log-download" href="/api/elfremote/task-log?device_id='+encodeURIComponent(d.id)+'&amp;task_id='+encodeURIComponent(t.id)+'">下载日志 · '+(r.artifact.bytes/1000).toFixed(1)+' KB</a>';
  var adb=u?u.adb:{connected:false,lines:[]},on=adb.connected;
  var right='<section class="monitor"><h4 class="monitor-heading"><span>ADB终端</span><button class="'+(on?'btn-gray':'btn-green')+'" onclick="'+(on?'adbDisconnect()':'adbConnect()')+'"'+(!d||adb.connecting||(!on&&(d.enabled===false||!d.managed_adb_session))?' disabled':'')+'>'+(on?'断开ADB':adb.connecting?'连接中':'连接ADB')+'</button></h4>';
  right+='<div class="adb-box"><div class="adb-term" id="adbTerm" style="padding:8px;overflow:hidden">'+(on?'ADB 已连接':'ADB 未连接')+'</div>';
  right+='<div class="adb-row"><span class="adb-prompt">adb&gt;</span><input id="adbCmd" class="inp adb-cmd" placeholder="输入命令，例如 pwd"'+(!on?' disabled':'')+'><button class="'+(on?'btn-green':'btn-gray')+'" onclick="adbSendCommand()"'+(!on?' disabled':'')+'>发送</button><button class="btn-gray" onclick="adbInterrupt()"'+(!on?' disabled':'')+'>中断</button></div></div></section>';
  return '<div class="monitor-grid">'+left+right+'</div>'+(foot?'<div class="terminal-status">'+foot+'</div>':'');
}

var FILE_SEND={},FILE_VIEW='',FILE_POLL=null;
function fileSendMessage(state,text){state.message=text;if(FILE_VIEW===state.device_id&&$('fileStatus'))$('fileStatus').textContent=text;}
function closeSendFile(){hide('fileSendWrap');clearTimeout(FILE_POLL);FILE_VIEW='';}
function openSendFile(){
  var d=currentDev();if(!d)return;
  if(!$('fileSendWrap')){var wrap=document.createElement('div');wrap.id='fileSendWrap';wrap.className='file-send-wrap';wrap.onclick=function(e){if(e.target===wrap)closeSendFile();};document.body.appendChild(wrap);}
  FILE_VIEW=d.id;
  var state=FILE_SEND[d.id]||(FILE_SEND[d.id]={device_id:d.id,message:''});
  if(d.task&&d.task.type==='send_file'&&!state.task_id)state.task_id=d.task.id;
  $('fileSendWrap').innerHTML='<div class="file-send-dialog"><div class="traffic-header"><h3>发送文件</h3><button class="btn-close" onclick="closeSendFile()" aria-label="关闭发送文件">&times;</button></div><div class="file-send-fields"><label>选择文件<input id="sendFilePick" type="file" onchange="pickSendFile()"'+(state.busy?' disabled':'')+'></label><label>设备保存路径<input id="sendFilePath" class="inp" placeholder="/sdcard/Download/文件名" value="'+esc(state.path||'')+'"'+(state.busy?' disabled':'')+'></label><div class="file-options"><label><input id="sendFileCell" type="checkbox"'+(state.cellular?' checked':'')+(state.busy?' disabled':'')+'>允许本次使用移动数据</label><label><input id="sendFileOverwrite" type="checkbox"'+(state.overwrite?' checked':'')+(state.busy?' disabled':'')+'>替换同名文件（保留原件）</label></div><div class="ops-actions"><button id="sendFileStart" class="btn-green" onclick="startSendFile()"'+(state.busy?' disabled':'')+'>发送</button><button class="btn-gray" onclick="stopSendFile()">停止</button></div><p id="fileStatus" role="status">'+esc(state.message||'默认通过 Wi-Fi 接收文件')+'</p></div></div>';
  if($('sendFileCell'))$('sendFileCell').closest('label').remove();
  if(!state.message)$('fileStatus').textContent='等待发送文件';
  show('fileSendWrap');if(state.task_id)pollSendFile(state);
}
var FILE_RETURN={};
function returnUrl(s){return '/api/elfremote/file-return?'+new URLSearchParams({device_id:s.device_id,task_id:s.task_id,download:'1'});}
function openReturnFile(){
  var d=currentDev();if(!d||!d.managed_file_return)return;
  if(!$('fileSendWrap'))openSendFile();clearTimeout(FILE_POLL);FILE_VIEW=d.id;
  var s=FILE_RETURN[d.id]||(FILE_RETURN[d.id]={device_id:d.id,path:'',message:''});
  if(d.task&&d.task.type==='get_file'&&!s.task_id){s.task_id=d.task.id;s.path=d.task.params.path;s.cellular=d.task.params.allow_cellular;s.busy=['pending','claimed','running'].includes(d.task.state);}
  $('fileSendWrap').innerHTML='<div class="file-send-dialog"><div class="traffic-header"><h3>取回文件</h3><button class="btn-close" onclick="closeSendFile()" aria-label="关闭取回文件">&times;</button></div><div class="file-send-fields"><label>设备文件路径<input class="inp" id="returnFilePath" value="'+esc(s.path)+'" placeholder="/sdcard/Download/文件名"'+(s.busy?' disabled':'')+'></label><div class="file-options"><label><input type="checkbox" id="returnFileCell"'+(s.cellular?' checked':'')+(s.busy?' disabled':'')+'>允许本次使用移动数据</label></div><div class="ops-actions"><button class="btn-green" id="returnFileStart" onclick="startReturnFile()"'+(s.busy?' disabled':'')+'>取回</button><button class="btn-gray" onclick="cancelReturnFile()">停止</button></div><p id="returnFileStatus" role="status">'+esc(s.message||'默认通过 Wi-Fi 取回文件')+'</p><a id="returnFileDownload" class="log-download" style="display:none">下载文件</a></div></div>';
  show('fileSendWrap');if(s.task_id)pollReturnFile(s);
}

var FILE_MANAGER={};
function fileManagerState(){
  var d=currentDev();if(!d)return null;
  return FILE_MANAGER[d.id]||(FILE_MANAGER[d.id]={device_id:d.id,path:'/sdcard/Download',entries:[],offset:0,total:0,next:-1,selected:[],message:'',busy:false,loaded:false});
}
function fileManagerVisible(s){return selFn==='files'&&selDev===s.device_id&&$('fileManagerPanel');}
function fileManagerChild(s,name){return s.path.replace(/\/$/,'')+'/'+name;}
function fileManagerDevice(s){return DEV.find(function(d){return d.id===s.device_id;});}
function fileManagerSelected(s){return s.entries.filter(function(e){return Array.isArray(s.selected)&&s.selected.includes(e.name);});}
function fileManagerSize(n){n=Number(n)||0;var u=['B','KB','MB','GB'],i=0;while(n>=1000&&i<3){n/=1000;i++;}return (i?n.toFixed(1):n)+' '+u[i];}
function fileManagerType(e){
  if(e.link)return '符号链接';if(e.directory)return '文件夹';
  var ext=e.name.split('.').pop().toLowerCase(),type={apk:'安卓应用',zip:'压缩文件',gz:'压缩文件',rar:'压缩文件','7z':'压缩文件',jpg:'图片',jpeg:'图片',png:'图片',webp:'图片',mp4:'视频',mkv:'视频',mp3:'音频',wav:'音频',ogg:'音频',txt:'文本文件',log:'日志文件',json:'JSON 文件',xml:'XML 文件',pdf:'PDF 文档'}[ext];
  return type||(e.name.includes('.')?ext.toUpperCase()+' 文件':'文件');
}
function fileManagerPermissions(e){
  if(!Number.isInteger(e.mode))return '—';
  var text='',chars='rwx';for(var i=8;i>=0;i--)text+=(e.mode&(1<<i))?chars[(8-i)%3]:'-';
  if(e.mode&2048)text=text.slice(0,2)+((e.mode&64)?'s':'S')+text.slice(3);
  if(e.mode&1024)text=text.slice(0,5)+((e.mode&8)?'s':'S')+text.slice(6);
  if(e.mode&512)text=text.slice(0,8)+((e.mode&1)?'t':'T');
  return text+' ('+e.mode.toString(8)+')';
}
function fileManagerTime(ms){return ms>0?new Intl.DateTimeFormat('sv-SE',{timeZone:'Australia/Sydney',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(ms)):'—';}
function loadFileManagerOnEntry(){var s=fileManagerState(),d=currentDev();if(s&&d.managed_file_operations&&!s.busy&&!s.loaded)fileManagerLoad(s.path,0);}
function pageFiles(){var s=fileManagerState();return s?'<div id="fileManagerPanel" class="file-manager-page">'+fileManagerHtml(s)+'</div>':'<p class="muted">请先选择设备</p>';}
function fileManagerRows(s){
  return s.entries.map(function(e,i){var selected=Array.isArray(s.selected)&&s.selected.includes(e.name);
    return '<tr'+(selected?' class="selected"':'')+'><td class="file-select"><input type="checkbox" aria-label="选择 '+esc(e.name)+'" onchange="fileManagerSelect('+i+',this.checked)"'+(selected?' checked':'')+(s.busy?' disabled':'')+'></td><td class="file-name"><a href="#" onclick="fileManagerPick('+i+');return false" title="'+esc(e.name)+'"><span class="file-entry-icon '+(e.directory?'folder':'document')+'" aria-hidden="true"></span><span>'+esc(e.name)+'</span></a></td><td class="file-size">'+(e.directory?'—':fileManagerSize(e.bytes))+'</td><td class="file-type">'+esc(fileManagerType(e))+'</td><td class="file-modified">'+fileManagerTime(e.modified_ms)+'</td><td class="file-permissions" title="'+(Number.isInteger(e.uid)?'UID '+e.uid+' / GID '+e.gid:'')+'">'+fileManagerPermissions(e)+'</td></tr>';
  }).join('');
}
function fileManagerHtml(s){
  var d=fileManagerDevice(s),disabled=s.busy||!d||!d.managed_file_operations||d.enabled===false?' disabled':'',picked=fileManagerSelected(s),selection=disabled||(!picked.length?' disabled':'');
  var h='<div class="file-manager-toolbar"><button class="btn-green" onclick="fileManagerSend()"'+(s.busy||!maintenanceAvailable(d,'send_file')?' disabled':'')+'>发送文件</button><button class="btn-green" onclick="fileManagerTake()"'+(selection||!d.managed_file_return?' disabled':'')+'>取回文件</button><span class="file-toolbar-divider"></span>';
  [['mkdir','新建文件夹'],['copy','复制'],['move','移动'],['rename','改名'],['delete','删除']].forEach(function(a){var off=a[0]==='mkdir'?disabled:selection;if(a[0]==='rename'&&picked.length!==1)off=' disabled';if(a[0]==='delete'&&!d.managed_file_delete)off=' disabled';h+='<button class="'+(a[0]==='delete'?'file-delete':'file-tool')+'" onclick="fileManagerAction(\''+a[0]+'\')"'+off+'>'+a[1]+'</button>';});
  h+='<span class="file-manager-count">共 '+s.total+' 项'+(picked.length?' · 已选 '+picked.length+' 项':'')+'</span></div>';
  h+='<div class="file-manager-path"><button class="file-tool" onclick="fileManagerUp()"'+disabled+'>上一级</button><input id="fileManagerPath" class="inp" aria-label="设备目录" value="'+esc(s.pathDraft||s.path)+'" oninput="fileManagerState().pathDraft=this.value" onkeydown="if(event.key===\'Enter\')fileManagerLoad()"'+disabled+'><button class="file-tool" onclick="fileManagerLoad()"'+disabled+'>刷新</button></div>';
  h+='<table class="file-manager-table"><thead><tr><th class="file-select"><input type="checkbox" aria-label="选择本页全部文件" onchange="fileManagerSelectAll(this.checked)"'+(s.entries.length&&picked.length===s.entries.length?' checked':'')+disabled+'></th><th>名称</th><th class="file-size">大小</th><th class="file-type">类型</th><th class="file-modified">修改时间</th><th class="file-permissions">权限</th></tr></thead><tbody>'+fileManagerRows(s)+(s.entries.length?'':'<tr><td colspan="6" class="file-empty">'+(s.busy?'正在读取目录':s.loaded?'此目录为空':'尚未读取目录')+'</td></tr>')+'</tbody></table>';
  h+='<div class="file-manager-footer"><div class="file-operation-status'+(s.error?' error':s.done?' success':'')+'" role="status"><span id="fileManagerStatus">'+esc(s.message||'')+'</span>'+(s.progress!=null?'<progress max="100" value="'+s.progress+'" aria-label="文件传输进度"></progress>':'')+(s.busy&&s.cancellable?'<button class="file-tool" onclick="fileManagerCancel()">取消</button>':'')+'</div><div class="file-manager-pagination"><span>第 '+(Math.floor(s.offset/12)+1)+' 页 / 共 '+Math.max(1,Math.ceil(s.total/12))+' 页</span><button class="file-tool" onclick="fileManagerPage(-1)"'+(disabled||s.offset===0?' disabled':'')+'>上一页</button><button class="file-tool" onclick="fileManagerPage(1)"'+(disabled||s.next<0?' disabled':'')+'>下一页</button></div></div>';
  return h;
}
function renderFileManager(s){if(fileManagerVisible(s))$('fileManagerPanel').innerHTML=fileManagerHtml(s);}
function fileManagerStatus(s,message,progress){var next=progress==null?null:Math.min(99,Math.max(0,Math.floor(progress)));if(s.message===message&&s.progress===next)return;s.message=message;s.progress=next;renderFileManager(s);}
function fileManagerSelect(i,on){var s=fileManagerState(),e=s&&s.entries[i];if(!e||s.busy)return;if(on&&!s.selected.includes(e.name))s.selected.push(e.name);if(!on)s.selected=s.selected.filter(function(n){return n!==e.name;});renderFileManager(s);}
function fileManagerSelectAll(on){var s=fileManagerState();if(s&&!s.busy){s.selected=on?s.entries.map(function(e){return e.name;}):[];renderFileManager(s);}}
function fileManagerPick(i){var s=fileManagerState(),e=s&&s.entries[i];if(!e||s.busy)return;if(e.directory&&!e.link)fileManagerLoad(fileManagerChild(s,e.name),0);else fileManagerSelect(i,!s.selected.includes(e.name));}
function fileManagerUp(){var s=fileManagerState();if(s&&!s.busy)fileManagerLoad(s.path.replace(/\/$/,'').replace(/\/[^/]*$/,'')||'/',0);}
function fileManagerPage(direction){var s=fileManagerState();if(s&&!s.busy)fileManagerLoad(s.path,direction>0?s.next:Math.max(0,s.offset-12));}
function fileManagerCheck(s){if(s.cancelled)throw Error('已取消');}
async function fileManagerWait(s,id,progress,timeout){
  s.task_id=id;
  if(s.cancelled)await fileApi('/api/elfremote/task',{device_id:s.device_id,action:'cancel',task_id:id});
  for(var started=Date.now();Date.now()-started<(timeout||86400000);){
    fileManagerCheck(s);
    try{
      var reply=await readWatchedTask(s,s.device_id,id),t=reply&&reply.task;
      if(t){
        if(t.state==='success'){s.task_id='';return t;}
        if(['failed','expired','rejected','cancelled'].includes(t.state)){s.task_id='';throw Object.assign(Error(t.detail||'文件操作未完成'),{stopPolling:true});}
        if(progress)progress(t);
      }
    }catch(e){if(e.stopPolling)throw e;fileManagerStatus(s,'连接中断，正在重试');}
    await new Promise(function(resolve){setTimeout(resolve,2500);});
  }
  throw Error('等待设备完成超时');
}
async function fileManagerTask(s,params){
  fileManagerCheck(s);
  var x=await fileApi('/api/elfremote/task',{device_id:s.device_id,type:'file_manage',id:'files-'+crypto.randomUUID(),params:params});
  var t=await fileManagerWait(s,x.task.id,null,180000);
  if(!t.result||t.result.truncated)throw Error('文件结果不完整');
  return JSON.parse(t.result.text);
}
async function fileManagerRead(s,path,offset){
  var r=await fileManagerTask(s,{action:'list',path:path,offset:offset||0});
  return r;
}
async function fileManagerRefresh(s,path,offset){
  var r=await fileManagerRead(s,path,offset);
  if(offset>=r.total&&offset>0)return fileManagerRefresh(s,path,Math.max(0,Math.ceil(r.total/12)-1)*12);
  s.path=r.path;s.pathDraft='';s.loaded=true;s.entries=r.entries;s.total=r.total;s.next=r.next;s.offset=offset;s.selected=[];
}
async function fileManagerLoad(path,offset){
  var s=fileManagerState();if(!s||s.busy)return;
  path=typeof path==='string'?path:$('fileManagerPath').value.trim();offset=Number.isInteger(offset)&&offset>=0?offset:0;
  s.busy=true;s.cancelled=false;s.error=false;s.done=false;fileManagerStatus(s,'正在读取目录');
  try{await fileManagerRefresh(s,path,offset);s.message='';}catch(e){s.message=e.message;s.error=true;}finally{s.busy=false;renderFileManager(s);}
}
function fileManagerBegin(s){s.busy=true;s.cancelled=false;s.error=false;s.done=false;s.cancellable=true;s.conflict=null;s.task_id='';}
async function fileManagerEnd(s,message,error){
  s.progress=null;s.cancellable=false;
  if(!error){try{await fileManagerRefresh(s,s.path,s.offset);}catch(e){message+=' · 目录刷新失败';}}
  s.busy=false;s.done=!error;s.error=!!error;s.message=error?error.message:message;renderFileManager(s);
}
async function fileManagerCancel(){var s=fileManagerState();if(!s||!s.busy)return;s.cancelled=true;if(s.abort)s.abort.abort();if(s.task_id)try{await fileApi('/api/elfremote/task',{device_id:s.device_id,action:'cancel',task_id:s.task_id});}catch(e){s.message='取消请求未送达：'+e.message;renderFileManager(s);}}
function fileManagerDialog(title,body){
  var wrap=document.createElement('div');wrap.className='file-send-wrap file-operation-dialog';wrap.style.display='flex';
  wrap.innerHTML='<div class="file-send-dialog"><div class="traffic-header"><h3>'+esc(title)+'</h3><button class="btn-close" aria-label="关闭">&times;</button></div><div class="file-send-fields">'+body+'</div></div>';
  document.body.appendChild(wrap);return wrap;
}
function fileManagerName(title,initial){return new Promise(function(resolve){
  var w=fileManagerDialog(title,'<input class="inp" aria-label="名称" value="'+esc(initial||'')+'"><div class="ops-actions"><button class="btn-green">确定</button><button class="file-tool">取消</button></div>'),input=w.querySelector('input');
  function finish(value){w.remove();resolve(value);}
  w.querySelector('.btn-close').onclick=function(){finish(null);};w.querySelector('.file-tool').onclick=function(){finish(null);};w.onclick=function(e){if(e.target===w)finish(null);};
  w.querySelector('.btn-green').onclick=function(){var name=input.value.trim();if(!name||name==='.'||name==='..'||/[\/\\\x00-\x1f]/.test(name)){input.setCustomValidity('请输入不含路径分隔符的名称');input.reportValidity();return;}finish(name);};
  input.oninput=function(){input.setCustomValidity('');};input.onkeydown=function(e){if(e.key==='Enter')w.querySelector('.btn-green').click();};input.focus();input.select();
});}
function fileManagerConflict(s,name){if(s.conflict)return Promise.resolve(s.conflict);return new Promise(function(resolve){
  var w=fileManagerDialog('同名文件','<div>'+esc(name)+' 已存在</div><label><input type="checkbox"> 对本批次应用</label><div class="file-conflict-actions"><button class="file-tool" data-choice="replace">覆盖</button><button class="file-tool" data-choice="skip">跳过</button><button class="btn-green" data-choice="rename">保留两份</button></div>');
  function finish(choice){if(w.querySelector('input').checked)s.conflict=choice;w.remove();resolve(choice);}
  w.querySelectorAll('[data-choice]').forEach(function(b){b.onclick=function(){finish(b.dataset.choice);};});w.querySelector('.btn-close').onclick=function(){finish('cancel');};w.onclick=function(e){if(e.target===w)finish('cancel');};
});}
function fileManagerAlternative(name,number){var at=name.lastIndexOf('.');return at>0?name.slice(0,at)+' ('+number+')'+name.slice(at):name+' ('+number+')';}
async function fileManagerAll(s,path){var out=[],offset=0;for(;;){var r=await fileManagerRead(s,path,offset);out=out.concat(r.entries);if(r.next<0)return out;if(r.next<=offset)throw Error('目录分页未推进');offset=r.next;}}
function fileManagerChooseRemote(s,title){return new Promise(function(resolve,reject){
  var w=fileManagerDialog(title,'<div class="file-directory-path"><button class="file-tool">上一级</button><span></span></div><div class="file-directory-list"></div><div class="ops-actions"><button class="btn-green">选择此文件夹</button><button class="file-tool file-picker-cancel">取消</button></div>'),path=s.path,closed=false;
  function finish(value){closed=true;w.remove();resolve(value);}
  async function load(next){
    w.querySelector('.btn-green').disabled=true;w.querySelector('.file-directory-path button').disabled=true;w.querySelector('.file-directory-list').textContent='正在读取目录';
    try{var rows=await fileManagerAll(s,next);if(closed)return;path=next;w.querySelector('.file-directory-path span').textContent=path;var list=w.querySelector('.file-directory-list');list.innerHTML='';rows.filter(function(e){return e.directory&&!e.link;}).forEach(function(e){var b=document.createElement('button');b.className='file-directory-item';b.textContent=e.name;b.onclick=function(){load(fileManagerChild({path:path},e.name));};list.appendChild(b);});if(!list.children.length)list.textContent='没有子文件夹';w.querySelector('.btn-green').disabled=false;w.querySelector('.file-directory-path button').disabled=false;}catch(e){if(!closed){closed=true;w.remove();reject(e);}}
  }
  w.querySelector('.btn-green').onclick=function(){finish(path);};w.querySelector('.file-directory-path button').onclick=function(){load(path.replace(/\/$/,'').replace(/\/[^/]*$/,'')||'/');};w.querySelector('.file-picker-cancel').onclick=function(){finish(null);};w.querySelector('.btn-close').onclick=function(){finish(null);};w.onclick=function(e){if(e.target===w)finish(null);};load(path);
});}
async function fileManagerAction(action){
  var s=fileManagerState();if(!s||s.busy)return;var picked=fileManagerSelected(s);if(action!=='mkdir'&&!picked.length)return;
  if(action==='delete'&&!confirm('删除选中的 '+picked.length+' 项？文件夹及其中内容也会删除，无法恢复。'))return;
  fileManagerBegin(s);
  try{
    var name,target,skipped=0;
    if(action==='mkdir'||action==='rename'){name=await fileManagerName(action==='mkdir'?'新建文件夹':'改名',action==='rename'?picked[0].name:'');if(name===null){s.busy=false;s.cancellable=false;renderFileManager(s);return;}}
    if(action==='copy'||action==='move'){target=await fileManagerChooseRemote(s,action==='copy'?'复制到':'移动到');if(target===null){s.busy=false;s.cancellable=false;renderFileManager(s);return;}}
    if(action==='mkdir'){fileManagerStatus(s,'正在新建文件夹');await fileManagerTask(s,{action:'mkdir',path:fileManagerChild(s,name)});}
    else if(action==='rename'){fileManagerStatus(s,'正在改名');await fileManagerTask(s,{action:'move',path:fileManagerChild(s,picked[0].name),target:fileManagerChild(s,name)});}
    else{
      var existing=target?await fileManagerAll(s,target):[];
      for(var i=0;i<picked.length;i++){
        fileManagerCheck(s);var e=picked[i],dst=target&&fileManagerChild({path:target},e.name),src=fileManagerChild(s,e.name),overwrite=false;
        if(dst===src)throw Error('目标与源位置相同');
        if(dst&&existing.some(function(v){return v.name===e.name;})){
          var choice=await fileManagerConflict(s,e.name);if(choice==='cancel')throw Error('已取消');if(choice==='skip'){skipped++;continue;}
          if(choice==='replace')overwrite=true;
          else{var n=1;do{name=fileManagerAlternative(e.name,n++);}while(existing.some(function(v){return v.name===name;}));dst=fileManagerChild({path:target},name);}
        }
        fileManagerStatus(s,({copy:'正在复制',move:'正在移动',delete:'正在删除'})[action]+' · '+(i+1)+'/'+picked.length);
        await fileManagerTask(s,Object.assign({action:action,path:src},dst?{target:dst,overwrite:overwrite}:{}));if(dst)existing.push({name:dst.split('/').pop()});
      }
    }
    await fileManagerEnd(s,({mkdir:'文件夹已新建',rename:'已改名',copy:'复制完成',move:'移动完成',delete:'已删除'})[action]+(skipped?' · 已跳过 '+skipped+' 项':''));
  }catch(e){await fileManagerEnd(s,'',e);}
}
function fileManagerSend(){
  var s=fileManagerState();if(!s||s.busy)return;
  var directory=s.path,input=document.createElement('input');input.type='file';input.multiple=true;
  input.onchange=function(){if(input.files.length)fileManagerSendBatch(s,Array.from(input.files),directory);};input.click();
}
async function fileManagerHash(){return (await import('/file-hash.js')).sha256.create();}
async function fileManagerUpload(s,file,path,overwrite,onProgress){
  var resumeKey='elf-file-upload:'+s.device_id+':'+file.name+':'+file.size+':'+file.lastModified,m,id=localStorage.getItem(resumeKey);
  if(file.size>4*1024*1024*1024)throw Error('单个文件最大支持 4 GB');
  if(id){try{m=(await fileApi('/api/elfremote/files/'+id)).file;}catch(e){if(/过期/.test(e.message))localStorage.removeItem(resumeKey);else throw e;}}
  if(m&&m.state==='delivered')m=null;
  if(!m){m=(await fileApi('/api/elfremote/files',{device_id:s.device_id,name:file.name,size:file.size})).file;localStorage.setItem(resumeKey,m.id);}
  var hash=await fileManagerHash();
  for(var i=0,offset=0;offset<file.size;i++,offset+=m.chunk_size){
    fileManagerCheck(s);var bytes=new Uint8Array(await file.slice(offset,offset+m.chunk_size).arrayBuffer());hash.update(bytes);
    var sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),function(b){return b.toString(16).padStart(2,'0');}).join('');
    if(m.parts[i]&&m.parts[i].sha256!==sha)throw Error('续传文件与原文件内容不同');
    if(!m.parts[i]){
      for(var attempt=0;;attempt++){
        fileManagerCheck(s);s.abort=new AbortController();
        try{var r=await fetch('/api/elfremote/files/'+m.id+'/parts/'+i+'?sha256='+sha,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:bytes,signal:s.abort.signal}),x=await r.json();if(!r.ok||!x.ok)throw Error(x.msg||'文件上传失败');break;}
        catch(e){if(attempt>=2||s.cancelled)throw e;await new Promise(function(resolve){setTimeout(resolve,1000*(attempt+1));});}finally{s.abort=null;}
      }
    }
    onProgress(Math.min(file.size,offset+bytes.length));
  }
  fileManagerCheck(s);var completeHash=Array.from(hash.digest(),function(b){return b.toString(16).padStart(2,'0');}).join('');
  await fileApi('/api/elfremote/files/'+m.id+'/complete',{sha256:completeHash});
  var task=await fileApi('/api/elfremote/task',{device_id:s.device_id,type:'send_file',id:'file-'+crypto.randomUUID(),params:{transfer_id:m.id,path:path,allow_cellular:true,overwrite:overwrite}});
  await fileManagerWait(s,task.task.id,function(t){var p=String(t.detail||'').match(/(\d+)%/);if(p)onProgress(file.size+file.size*Math.min(100,Number(p[1]))/100);});
  localStorage.removeItem(resumeKey);
}
async function fileManagerSendBatch(s,files,directory){
  if(s.busy)return;fileManagerBegin(s);fileManagerStatus(s,'正在准备发送');
  try{
    var existing=await fileManagerAll(s,directory),total=files.reduce(function(n,f){return n+f.size*2;},0),done=0,skipped=0;
    for(var i=0;i<files.length;i++){
      fileManagerCheck(s);var file=files[i],name=file.name,overwrite=false;
      if(existing.some(function(e){return e.name===name;})){
        var choice=await fileManagerConflict(s,name);if(choice==='cancel')throw Error('已取消');if(choice==='skip'){skipped++;done+=file.size*2;continue;}
        if(choice==='replace')overwrite=true;
        else{var n=1;do{name=fileManagerAlternative(file.name,n++);}while(existing.some(function(e){return e.name===name;}));}
      }
      await fileManagerUpload(s,file,fileManagerChild({path:directory},name),overwrite,function(bytes){var p=Math.min(99,Math.floor((done+bytes)*100/Math.max(1,total)));fileManagerStatus(s,'正在发送 '+p+'% · '+(i+1)+'/'+files.length,p);});
      done+=file.size*2;existing.push({name:name});
    }
    await fileManagerEnd(s,'发送完成'+(skipped?' · 已跳过 '+skipped+' 项':''));
  }catch(e){await fileManagerEnd(s,'',s.cancelled?Error('已取消'):e);}
}
function fileManagerLocalName(name){if(!name||name==='.'||name==='..'||/[\\/\x00-\x1f]/.test(name))throw Error('文件名无法保存到本机：'+name);return name;}
async function fileManagerCollect(s,path,entries,prefix,items,dirs,seen){
  for(var e of entries){fileManagerCheck(s);var name=fileManagerLocalName(e.name),remote=fileManagerChild({path:path},name),parts=prefix.concat(name);
    if(e.link)throw Error('取回暂不跟随符号链接：'+e.name);
    if(e.directory){if(prefix.length>=64||seen.has(remote))throw Error('目录层级过深或存在循环');seen.add(remote);dirs.push(parts);await fileManagerCollect(s,remote,await fileManagerAll(s,remote),parts,items,dirs,seen);}
    else{items.push({path:remote,parts:parts,bytes:e.bytes});}
  }
}
async function fileManagerLocalDirectory(root,parts){var dir=root;for(var part of parts)dir=await dir.getDirectoryHandle(fileManagerLocalName(part),{create:true});return dir;}
async function fileManagerDownload(s,item,root,progress){
  var dir=await fileManagerLocalDirectory(root,item.parts.slice(0,-1)),name=item.parts.at(-1),handle,exists=false;
  try{handle=await dir.getFileHandle(name);exists=true;}catch(e){if(e.name!=='NotFoundError')throw e;}
  if(exists){var choice=await fileManagerConflict(s,name);if(choice==='cancel')throw Error('已取消');if(choice==='skip')return false;if(choice==='rename'){
    for(var n=1;;n++){name=fileManagerAlternative(item.parts.at(-1),n);try{await dir.getFileHandle(name);}catch(e){if(e.name!=='NotFoundError')throw e;break;}}
  }}
  fileManagerCheck(s);
    var task=await fileApi('/api/elfremote/task',{device_id:s.device_id,type:'get_file',id:'return-'+crypto.randomUUID(),params:{path:item.path,allow_cellular:true}});
  await fileManagerWait(s,task.task.id,function(t){var p=String(t.detail||'').match(/(\d+)%/);if(p)progress(item.bytes*Math.min(100,Number(p[1]))/100);});
  var query=new URLSearchParams({device_id:s.device_id,task_id:task.task.id}),meta=(await fileApi('/api/elfremote/file-return?'+query)).file;
  var hash=await fileManagerHash();
  handle=await dir.getFileHandle(name,{create:true});var writer=await handle.createWritable(),written=0,reader;
  try{
    s.abort=new AbortController();var response=await fetch('/api/elfremote/file-return?'+query+'&download=1',{signal:s.abort.signal});if(!response.ok)throw Error('下载失败 HTTP '+response.status);
    reader=response.body.getReader();
    for(;;){fileManagerCheck(s);var chunk=await reader.read();if(chunk.done)break;hash.update(chunk.value);await writer.write(chunk.value);written+=chunk.value.length;progress(item.bytes+item.bytes*written/Math.max(1,meta.size));}
    var sum=Array.from(hash.digest(),function(b){return b.toString(16).padStart(2,'0');}).join('');
    if(written!==meta.size||sum!==meta.sha256)throw Error('文件校验失败，未保存不完整内容');
    await writer.close();return true;
  }catch(e){await writer.abort().catch(function(){});throw e;}
  finally{if(reader)await reader.cancel().catch(function(){});s.abort=null;}
}
async function fileManagerTake(){
  var s=fileManagerState(),picked=s&&fileManagerSelected(s);if(!s||s.busy||!picked.length)return;
  if(!window.showDirectoryPicker){fileManagerStatus(s,'请使用 Chrome 或 Edge 选择本机保存目录');return;}
  // 必须直接响应点击请求本机目录，不能先请求服务器而丢失浏览器用户手势。
  var root,directory=s.path;
  try{var selection=window.showDirectoryPicker({id:'elfremote-files',mode:'readwrite'});s.busy=true;renderFileManager(s);root=await selection;}catch(e){s.busy=false;if(e.name!=='AbortError'){s.error=true;s.message=e.message;}renderFileManager(s);return;}
  fileManagerBegin(s);fileManagerStatus(s,'正在准备取回');
  try{
    var items=[],dirs=[];await fileManagerCollect(s,directory,picked,[],items,dirs,new Set());
    for(var parts of dirs)await fileManagerLocalDirectory(root,parts);
    var total=items.reduce(function(n,e){return n+e.bytes*2;},0),done=0,skipped=0;
    for(var i=0;i<items.length;i++){
      fileManagerCheck(s);var item=items[i];
      var saved=await fileManagerDownload(s,item,root,function(bytes){var p=Math.min(99,Math.floor((done+bytes)*100/Math.max(1,total)));fileManagerStatus(s,'正在取回 '+p+'% · '+(i+1)+'/'+items.length,p);});
      done+=item.bytes*2;if(!saved)skipped++;
    }
    await fileManagerEnd(s,'取回完成'+(skipped?' · 已跳过 '+skipped+' 项':''));
  }catch(e){await fileManagerEnd(s,'',s.cancelled?Error('已取消'):e);}
}

async function startReturnFile(){
  var s=FILE_RETURN[FILE_VIEW];if(!s||s.busy)return;s.path=$('returnFilePath').value.trim();s.cellular=$('returnFileCell').checked;
  if(!s.path.startsWith('/')||s.path.endsWith('/')){$('returnFileStatus').textContent='请填写完整文件路径';return;}
  s.busy=true;s.message='正在下发取回任务';openReturnFile();
  try{var x=await fileApi('/api/elfremote/task',{device_id:s.device_id,type:'get_file',id:'return-'+crypto.randomUUID(),params:{path:s.path,allow_cellular:s.cellular}});s.task_id=x.task.id;pollReturnFile(s);loadDevices();}
  catch(e){s.busy=false;s.message=e.message;if(FILE_VIEW===s.device_id)openReturnFile();}
}
async function pollReturnFile(s){
  clearTimeout(FILE_POLL);if(FILE_VIEW!==s.device_id||!$('returnFileStatus')||!s.task_id)return;
  try{var x=await readWatchedTask(s,s.device_id,s.task_id),t=x&&x.task;
    if(t){s.message=t.detail||'等待设备取回';$('returnFileStatus').textContent=s.message;s.busy=['pending','claimed','running'].includes(t.state);
      if(!s.busy){['returnFileStart','returnFilePath','returnFileCell'].forEach(function(id){$(id).disabled=false;});if(t.state==='success'){$('returnFileDownload').href=returnUrl(s);$('returnFileDownload').style.display='inline';}return;}}
  }catch(e){$('returnFileStatus').textContent=e.message;if(e.stopPolling)return;}
  FILE_POLL=setTimeout(function(){pollReturnFile(s);},5000);
}
async function cancelReturnFile(){var s=FILE_RETURN[FILE_VIEW];if(!s||!s.task_id)return;try{await fileApi('/api/elfremote/task',{device_id:s.device_id,action:'cancel',task_id:s.task_id});pollReturnFile(s);}catch(e){$('returnFileStatus').textContent=e.message;}}
function pickSendFile(){var s=FILE_SEND[FILE_VIEW],f=$('sendFilePick').files[0];if(s&&f){s.file=f;if(!s.path||s.autoPath===s.path||s.directory)s.path=(s.directory||'/sdcard/Download').replace(/\/$/,'')+'/'+f.name;s.autoPath=s.path;$('sendFilePath').value=s.path;}}
async function fileApi(path,body,method){
  var r=await fetch(path,body===undefined?{}:{method:method||'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  var x=await r.json();if(!r.ok||!x.ok)throw Error(x.msg||'文件请求失败');return x;
}
async function startSendFile(){
  var s=FILE_SEND[FILE_VIEW];if(!s||s.busy)return;
  var f=s.file;s.path=$('sendFilePath').value.trim();s.cellular=true;s.overwrite=$('sendFileOverwrite').checked;
  if(!f||!s.path.startsWith('/')||s.path.endsWith('/')){fileSendMessage(s,'请选择文件并填写完整保存路径');return;}
  if(f.size>4*1024*1024*1024){fileSendMessage(s,'文件最大支持4 GB');return;}
  s.busy=true;s.stop=false;openSendFile();
  var resumeKey='elf-file-upload:'+s.device_id+':'+f.name+':'+f.size+':'+f.lastModified;
  try{
    var id=localStorage.getItem(resumeKey),m;
    if(id){try{m=(await fileApi('/api/elfremote/files/'+id)).file;}catch(e){if(/过期/.test(e.message))localStorage.removeItem(resumeKey);else throw e;}}
    if(m&&m.state==='delivered'){localStorage.removeItem(resumeKey);m=null;}
    if(!m){m=(await fileApi('/api/elfremote/files',{device_id:s.device_id,name:f.name,size:f.size})).file;localStorage.setItem(resumeKey,m.id);}
    var hash=(await import('/file-hash.js')).sha256.create();
    for(var i=0,offset=0;offset<f.size;i++,offset+=m.chunk_size){
      if(s.stop)throw Error('上传已停止，再次发送可继续');
      var bytes=new Uint8Array(await f.slice(offset,offset+m.chunk_size).arrayBuffer());hash.update(bytes);
      var partSha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),function(b){return b.toString(16).padStart(2,'0');}).join('');
      if(m.parts[i]&&m.parts[i].sha256!==partSha)throw Error('所选文件内容已变化，请重新选择原文件');
      if(!m.parts[i]){
        var failure;
        for(var attempt=0;attempt<3;attempt++){
          if(s.stop)throw Error('上传已停止，再次发送可继续');
          try{var r=await fetch('/api/elfremote/files/'+m.id+'/parts/'+i+'?sha256='+partSha,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:bytes});var x=await r.json();if(!r.ok||!x.ok)throw Error(x.msg||'分块上传失败');failure=null;break;}
          catch(e){failure=e;await new Promise(function(resolve){setTimeout(resolve,1000*(attempt+1));});}
        }
        if(failure)throw failure;
      }
      fileSendMessage(s,'上传到服务器 '+Math.floor(Math.min(f.size,offset+bytes.length)*100/Math.max(1,f.size))+'%');
    }
    if(s.stop)throw Error('上传已停止，再次发送可继续');
    var sha=Array.from(hash.digest(),function(b){return b.toString(16).padStart(2,'0');}).join('');
    await fileApi('/api/elfremote/files/'+m.id+'/complete',{sha256:sha});
    var jobKey=JSON.stringify([m.id,s.path,s.cellular,s.overwrite]);
    if(s.job_key!==jobKey){s.job_id='';s.job_key=jobKey;}
    s.job_id=s.job_id||('file-'+crypto.randomUUID());
    var assigned=await fileApi('/api/elfremote/task',{device_id:s.device_id,type:'send_file',id:s.job_id,params:{transfer_id:m.id,path:s.path,allow_cellular:s.cellular,overwrite:s.overwrite}});
    s.task_id=assigned.task.id;localStorage.removeItem(resumeKey);fileSendMessage(s,'文件已上传，等待设备接收');pollSendFile(s);loadDevices();
  }catch(e){fileSendMessage(s,e.message);}
  finally{s.busy=false;if(FILE_VIEW===s.device_id)['sendFileStart','sendFilePick','sendFilePath','sendFileCell','sendFileOverwrite'].forEach(function(id){if($(id))$(id).disabled=false;});}
}
async function pollSendFile(s){
  clearTimeout(FILE_POLL);if(FILE_VIEW!==s.device_id||!s.task_id)return;
  try{var x=await readWatchedTask(s,s.device_id,s.task_id);
    if(x&&x.task){fileSendMessage(s,x.task.detail||x.task.label||'等待设备接收');if(['success','failed','rejected','expired'].includes(x.task.state)){s.job_id='';return;}}
  }catch(e){fileSendMessage(s,e.message);if(e.stopPolling)return;}
  FILE_POLL=setTimeout(function(){pollSendFile(s);},5000);
}
async function stopSendFile(){var s=FILE_SEND[FILE_VIEW];if(!s)return;s.stop=true;if(s.busy){fileSendMessage(s,'当前分块完成后停止上传');return;}
  if(s.task_id)try{await fileApi('/api/elfremote/task',{device_id:s.device_id,action:'cancel',task_id:s.task_id});fileSendMessage(s,'正在通知设备停止接收');pollSendFile(s);}catch(e){fileSendMessage(s,e.message);}
}

var RELEASES=[], RELEASE_STATE='idle', RELEASE_REQUEST=null, RELEASE_DEVICE='', RELEASE_SEQUENCE=0;
function loadReleases(){
  var d=currentDev(),deviceId=d&&d.id;if(!deviceId)return;
  if(RELEASE_REQUEST && RELEASE_DEVICE===deviceId)return RELEASE_REQUEST;
  var sequence=++RELEASE_SEQUENCE;RELEASE_DEVICE=deviceId;RELEASES=[];
  RELEASE_STATE='loading';if(selFn==='update')renderOps();
  RELEASE_REQUEST=fetch('/api/elfremote/releases?'+new URLSearchParams({device_id:deviceId})).then(function(r){if(!r.ok)throw Error('版本读取失败');return r.json();}).then(function(x){
    if(sequence!==RELEASE_SEQUENCE)return;
    if(!x.ok || !Array.isArray(x.releases))throw Error('版本读取失败');
    RELEASES=x.releases.filter(function(r){return Number.isInteger(r.versionCode)&&r.versionCode>0;}).sort(function(a,b){return b.versionCode-a.versionCode;});RELEASE_STATE='ready';
  }).catch(function(){if(sequence===RELEASE_SEQUENCE)RELEASE_STATE='error';}).finally(function(){if(sequence===RELEASE_SEQUENCE){RELEASE_REQUEST=null;if(selFn==='update')renderOps();}});
  return RELEASE_REQUEST;
}
function selectedRelease(){
  var u=uiOf(),selected=u && u.releaseVersion;
  return RELEASES.find(function(r){return String(r.versionCode)===String(selected);}) || RELEASES[0];
}
function compareReleaseVersion(current,latest){
  var exact=RELEASES.find(function(r){return r.versionName===current;});
  if(exact)return Math.sign(exact.versionCode-latest.versionCode);
  var a=String(current||'').match(/^\d+(?:\.\d+)+/),b=String(latest.versionName||'').match(/^\d+(?:\.\d+)+/);
  if(!a||!b)return null;
  a=a[0].split('.').map(Number);b=b[0].split('.').map(Number);
  for(var i=0;i<Math.max(a.length,b.length);i++){var diff=(a[i]||0)-(b[i]||0);if(diff)return Math.sign(diff);}
  return 0;
}
function updateBusy(u){return ['pending','claimed','downloading','verifying','installing','wait_health','rollback'].includes(u.state);}
function updateProgress(u){
  var states={pending:'更新已发送，等待设备接收。',claimed:'设备已接收更新，正在准备下载安装包。',downloading:'设备正在下载安装包，请稍候。',verifying:'下载完成，正在检查安装包是否完整、签名是否正确。',installing:'正在设备上安装新版本，请等待安装结果。',wait_health:'新版本已安装，正在确认客户端能正常启动和上报。',success:'这次更新已完成，设备已确认客户端运行正常。',rollback:'更新后未能确认运行正常，正在恢复之前可用的版本。',recovered:'已恢复之前可用的版本，本次更新未完成。',rejected:'设备未执行本次更新。'};
  var reasons={'waiting-wifi':'等待连接Wi-Fi后自动下载。','download-interrupted':'下载中断，稍后自动重试。','download-failed':'多次下载失败，请检查网络后重新下发。','bad-task':'安装任务无效，请重新下发。','wrong-device':'安装包指定的设备与当前设备不符。',expired:'更新任务已过期，请重新下发。','insufficient-storage':'安装程序检查可用存储空间未通过，请检查设备存储。','hash-mismatch':'下载的安装包校验不通过，请重新下发。','cert-mismatch':'安装包签名与客户端要求不一致，未继续安装。','apk-metadata-mismatch':'安装包的包名或版本与发布记录不一致。','install-fail':'系统安装失败，正在等待设备报告恢复结果。','health-timeout':'等待新版本正常启动的时间已超过限制。','rollback-fail':'恢复旧版本失败，请拉取日志检查原因。'};
  if(!u.state)return '尚未从网页发起过客户端更新。';
  var prefix=u.target?'最近一次更新（'+u.target+'）：':'';
  return prefix+(states[u.state]||'设备尚未返回可识别的安装进展，请拉取最新信息。')+(reasons[u.detail]||'');
}
function installationProgress(u,now){
  var labels={pending:'等待设备接收',claimed:'准备下载',downloading:'下载中',verifying:'下载完成，正在校验安装包',installing:'安装中',wait_health:'安装完成，正在确认客户端正常运行',success:'安装完成',rollback:'正在重新安装之前可用的版本',recovered:'旧版本已恢复',rejected:'安装未执行'};
  if(!u.state)return '尚未开始安装';
  var text=labels[u.state]||'等待设备返回安装进展';
  if(u.detail==='install-fail')text='系统安装失败，等待设备报告后续处理结果';
  if(u.detail==='rollback-fail')text='旧版本重新安装失败，等待设备报告后续处理结果';
  var at=Date.parse(u.updated_at);
  if(updateBusy(u) && (!Number.isFinite(at) || (now||Date.now())-at>60000))text+=' · 尚未收到后续进展'+(Number.isFinite(at)?'（最后更新 '+sydney(u.updated_at)+'）':'');
  return text;
}
function installationResult(u){
  var success=u.state==='success',failed=['recovered','rejected'].includes(u.state)||['install-fail','rollback-fail'].includes(u.detail);
  if(!success&&!failed)return '<span>'+ (u.state?'等待安装结果':'暂无安装结果')+'</span>';
  var at=u.completed_at || (['install-fail','rollback-fail'].includes(u.detail)?u.updated_at:'');
  var h='<span style="color:'+(success?'#4ade80':'#f87171')+'">'+(success?'成功':'失败')+'</span> · '+esc(at?sydney(at):'时间未记录');
  if(u.target)h+='<br>'+esc('版本 '+u.target);
  if(failed)h+='<br>'+esc(updateProgress(u));
  return h;
}
function pageUpdate(dis){
  var d = currentDev();
  var u = d && d.update ? d.update : {};
  var ver = d && d.app_version ? d.app_version : (d ? managerLabel(d) : "未接入");
  var h = '<div class="update-facts">';
  h += kv("设备当前版本", ver);
  var latest=d && RELEASE_DEVICE===d.id ? RELEASES[0] : null,comparison=latest?compareReleaseVersion(d && d.app_version,latest):null;
  var check=RELEASE_STATE==='error'?'无法读取已发布版本，请重试。':RELEASE_STATE!=='ready'?'正在检查是否有新版本…':!latest?'暂无已发布版本。':comparison===null?'无法识别设备当前版本，请先拉取设备信息。':comparison>=0?'当前版本即最新版本':'新的软件版本 '+latest.versionName;
  h += '<div class="kv"><div class="k">更新安装状态</div><div class="v">'+esc(check);
  var busy=updateBusy(u),updateDisabled=dis || (!d || !d.can_update || busy || RELEASE_DEVICE!==d.id?' disabled':'');
  if(RELEASE_STATE==='ready' && comparison!==null && comparison<0)h+=' <button class="btn-green" onclick="assignUpdate('+latest.versionCode+')"'+(latest.expired?' disabled':updateDisabled)+'>更新</button>';
  h += '</div></div>';
  h += kv("安装进展", installationProgress(u));
  h += '<div class="kv"><div class="k">安装结果</div><div class="v">'+installationResult(u)+'</div></div>';
  h += "</div>";
  var status=functionSection('更新状态',h);h='';
  if(d && !d.can_update)h+='<p class="muted">设备尚未启用客户端更新功能</p>';
  h += '<div class="ops-actions" style="margin-top:.45rem">';
  var ready=d && RELEASE_DEVICE===d.id && RELEASE_STATE==='ready' && RELEASES.length>0,selected=selectedRelease(),blocked=updateDisabled || (!ready || selected.expired?' disabled':'');
  h += '<select id="updVc" class="inp release-select" aria-label="已发布版本" onchange="uiOf().releaseVersion=this.value;renderOps()"'+(ready?'':' disabled')+'>';
  if(!ready)h+='<option value="">'+(RELEASE_STATE==='error'?'版本读取失败':RELEASE_STATE==='ready'?'暂无已发布版本':'正在读取版本…')+'</option>';
  else RELEASES.forEach(function(r,i){h+='<option value="'+r.versionCode+'"'+(selected.versionCode===r.versionCode?' selected':'')+'>'+esc(r.versionName||String(r.versionCode))+' · '+r.versionCode+(i===0?'（最新发布）':'')+(r.expired?' · 发布已过期':'')+'</option>';});
  h+='</select><button class="btn-green" onclick="assignUpdate()"'+blocked+'>下发该版本</button>';
  if(RELEASE_STATE==='error')h+='<button class="btn-gray" onclick="loadReleases()">重试</button>';
  h += "</div>";
  return status+functionSection('下发版本',h);
}

function pageWifi(dis){
  var u = uiOf();
  var device = currentDev();
  var scan = device && device.wifi_scan;
  var list = scan ? scan.networks : [];
  var sel = u ? u.wifiSel : "";
  var last = scan ? sydney(scan.sampled_at_ms) : "";
  var h = '<div class="ops-actions">';
  h += '<button class="btn-gray" onclick="wifiScan()"'+dis+'>刷新扫描</button>';
  if(last) h += '<span class="muted">上次成功：'+esc(last)+"</span>";
  if(device && device.task && device.task.type==='scan_wifi') h += '<span class="muted">'+esc(device.task.label)+' '+esc(device.task.detail||'')+'</span>';
  h += "</div>";
  h += '<table style="margin-top:.55rem"><thead><tr><th>SSID</th><th style="white-space:nowrap">信号</th><th>加密</th><th></th></tr></thead><tbody>';
  if(!list.length) h += '<tr><td colspan="4" class="muted">'+(scan?'本次扫描未发现可显示的网络':'等待设备上报周围 Wi-Fi')+'</td></tr>';
  else for(var i=0;i<list.length;i++){
    var w=list[i];
    h += "<tr><td>"+esc(w.ssid)+"</td><td>"+esc(w.rssi)+"</td><td>"+esc(w.sec)+"</td>";
    h += '<td><button class="btn-gray" style="white-space:nowrap;padding:.45rem .55rem" onclick="wifiPickIndex('+i+')"'+dis+'>选择</button></td></tr>';
  }
  h += "</tbody></table>";
  h += '<div class="ops-actions" style="margin-top:.7rem">';
  h += '<input id="wifiSsid" class="inp" placeholder="SSID" value="'+esc(sel)+'" style="max-width:200px"'+dis+'>';
  h += '<input id="wifiPw" class="inp" type="password" placeholder="密码" style="max-width:200px"'+dis+'>';
  h += '<button class="btn-green" onclick="wifiConnect()"'+dis+'>连接</button>';
  h += "</div>";
  h += '<p class="muted">'+(device&&device.managed_system_settings?'已保存网络留空则沿用密码，填写新密码则修改。连接失败自动恢复原网络。':'已保存的网络密码留空；新网络支持开放网络或 WPA/WPA2。连接失败自动恢复原网络。')+'</p>';
  if(device&&device.managed_system_settings){var ws=systemSettingsState();h+='<span role="status">'+esc(ws.message||'')+'</span>';}
  h += configTaskStatus(device);
  return h;
}

function pageContacts(dis){
  var device=currentDev(), snapshot=device && device.contacts;
  var list = snapshot ? snapshot.items : [];
  var h = '<div class="ops-actions">';
  h += '<input id="cName" class="inp" placeholder="姓名" style="max-width:160px"'+dis+'>';
  h += '<input id="cPhone" class="inp" placeholder="号码" style="max-width:160px"'+dis+'>';
  h += '<button class="btn-green" onclick="contactAdd()"'+dis+'>添加</button>';
  h += '<button class="btn-gray" onclick="contactRefresh()"'+dis+'>刷新</button>';
  h += "</div>";
  h += configTaskStatus(device);
  if(snapshot) h += '<p class="muted">上次读取：'+sydney(snapshot.sampled_at_ms)+(snapshot.truncated?' · 仅显示前1000个号码':'')+'</p>';
  h += '<div class="function-table"><table style="margin-top:.55rem"><thead><tr><th>姓名</th><th>号码</th><th></th></tr></thead><tbody>';
  if(!list.length) h += '<tr><td colspan="3" class="muted">'+(snapshot?'暂无联系人号码':'尚未读取设备通信录')+'</td></tr>';
  else for(var i=0;i<list.length;i++){
    var c=list[i];
    h += "<tr><td>"+esc(c.name)+"</td><td>"+esc(c.phone)+"</td><td>";
    h += '<button class="btn-gray" onclick="contactEdit('+i+')"'+dis+'>改</button> ';
    h += '<button class="btn-gray" style="color:#f87171" onclick="contactDel('+i+')"'+dis+'>删</button>';
    h += "</td></tr>";
  }
  h += "</tbody></table></div>";
  return h;
}

var trajectoryLayer=null,trajectorySelectedLayer=null,trajectoryTimer=null;
function historyState(){var u=uiOf();if(!u)return null;if(!u.history){var day=trafficDay();u.history={from:day,to:day,preset:'today',rows:[],media:[],events:[],selected:-1,loaded:false,loading:false,sequence:0,error:'',historical:false};}return u.history;}
function trajectoryState(){return selFn==='locate'?historyState():null;}
function trajectoryEvent(){var s=trajectoryState();return s&&s.historical?s.events[s.selected]:null;}
function trajectoryClock(at){return new Date(at).toLocaleTimeString('en-GB',{timeZone:'Australia/Sydney',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});}
function trajectoryPreset(preset){var s=historyState(),today=trafficDay();if(!s)return;s.preset=preset;if(preset==='today')s.from=s.to=today;else if(preset==='yesterday')s.from=s.to=shiftTrafficDay(today,-1);else if(preset==='week'){s.from=shiftTrafficDay(today,-6);s.to=today;}else{renderOps();return;}queryHistory();}
function trajectoryDate(which,value){var s=historyState();s[which]=value;s.preset='custom';queryHistory();}
async function queryHistory(){var s=historyState(),id=selDev;if(!s)return;var range;try{range=Trajectory.dayRange(s.from,s.to);if(range.from>range.to||range.to-range.from>366*86400000)throw Error('请选择不超过366天的有效日期范围');}catch(e){s.sequence++;s.loading=false;s.loaded=false;s.historical=false;trajectoryStopPlayer(s);trajectoryStopReplay();clearHistoryMarker();s.error=e.message;renderOps();return;}
  var seq=++s.sequence;s.loading=true;s.error='';s.mediaError='';trajectoryStopPlayer(s);trajectoryStopReplay();s.historical=false;s.loaded=false;clearHistoryMarker();renderOps();
  async function pages(path){var rows=[],cursor=null,seen=new Set();do{var q=new URLSearchParams({device_id:id,from:new Date(range.from).toISOString(),to:new Date(range.to).toISOString(),limit:'500'});if(cursor)q.set('cursor',cursor);var r=await fetch(path+'?'+q),x=await readServiceJson(r);if(s.sequence!==seq)return null;rows=rows.concat(x.records||[]);cursor=x.next_cursor;if(cursor&&seen.has(cursor))throw Error('历史分页未推进');seen.add(cursor);}while(cursor);return rows;}
  try{var responses=await Promise.allSettled([pages('/api/devices/history'),pages('/api/devices/trajectory-media')]);if(seq!==s.sequence)return;if(responses[0].status==='rejected')throw responses[0].reason;var result=[responses[0].value,responses[1].status==='fulfilled'?responses[1].value:[]];if(!result[0]||!result[1])return;if(responses[1].status==='rejected')s.mediaError=responses[1].reason.message||'历史媒体暂不可用';
    s.track=Trajectory.build(result[0]);s.rows=s.track.rows;s.media=result[1];s.events=Trajectory.events(s.rows,s.media,range);s.selected=s.events.length-1;s.historical=s.selected>=0;s.viewFrom=range.from;s.viewTo=range.to;if(s.events.length){var pad=Math.max(900000,(s.events.at(-1).at-s.events[0].at)*.05);s.viewFrom=Math.max(range.from,s.events[0].at-pad);s.viewTo=Math.min(range.to,s.events.at(-1).at+pad);}s.loaded=true;s.range=range;
  }catch(e){if(seq===s.sequence)s.error=e.message||'轨迹读取失败';}
  finally{if(seq===s.sequence){s.loading=false;if(selDev===id&&selFn==='locate'){renderOps();trajectoryDrawMap(true);}}}
}
function pageLocate(){var s=historyState();if(!s)return '<p class="muted">请选择设备</p>';
  var h='<section id="trajectoryPanel" class="trajectory-panel"><div class="trajectory-toolbar"><div class="trajectory-presets">';
  [['today','今天'],['yesterday','昨天'],['week','最近7天'],['custom','自定义']].forEach(function(p){h+='<button type="button" class="'+(s.preset===p[0]?'active':'')+'" onclick="trajectoryPreset(\''+p[0]+'\')">'+p[1]+'</button>';});
  h+='</div><div class="trajectory-dates"><input type="date" aria-label="轨迹开始日期" value="'+esc(s.from)+'" onchange="trajectoryDate(\'from\',this.value)"><span>—</span><input type="date" aria-label="轨迹结束日期" value="'+esc(s.to)+'" onchange="trajectoryDate(\'to\',this.value)"><button type="button" class="traffic-link" onclick="queryHistory()"'+(s.loading?' disabled':'')+'>刷新</button></div></div>';
  if(s.error||s.mediaError)h+='<p class="trajectory-error" role="alert">'+esc(s.error||'历史媒体：'+s.mediaError)+'</p>';
  if(!s.loaded||!s.events.length)return h+'<div class="trajectory-empty">'+(s.loading?'轨迹读取中…':s.loaded?'该时间段没有记录':'请选择日期查看轨迹')+'</div></section>';
  h+='<div class="trajectory-playbar"><button type="button" aria-label="上一个时间点" onclick="trajectorySelect(historyState().selected-1)">‹</button><button type="button" id="trajectoryPlay" onclick="trajectoryReplay()">'+(trajectoryTimer?'暂停':'播放轨迹')+'</button><button type="button" aria-label="下一个时间点" onclick="trajectorySelect(historyState().selected+1)">›</button><span id="trajectoryTime">'+esc(sydney(s.events[s.selected]?.at))+'</span><span class="trajectory-count">'+s.rows.length+' 次上报</span><button type="button" aria-label="放大时间轴" onclick="trajectoryZoom(.5)">＋</button><button type="button" aria-label="缩小时间轴" onclick="trajectoryZoom(2)">−</button><button type="button" class="traffic-link" onclick="trajectoryReturnLive()">返回实时</button></div>';
  h+='<div id="trajectoryAxis">'+trajectoryAxisHtml(s)+'</div><div id="trajectoryDetail">'+trajectoryDetailHtml(s)+'</div></section>';return h;
}
function trajectoryAxisHtml(s){var span=Math.max(1,s.viewTo-s.viewFrom),percent=function(at){return Math.max(0,Math.min(100,(at-s.viewFrom)/span*100));};
  var h='<div class="trajectory-axis" role="group" aria-label="横向轨迹时间轴">';
  for(var i=0;i<5;i++){var at=Math.round((s.viewFrom+span*i/4)/60000)*60000;h+='<span class="trajectory-tick" style="left:'+i*25+'%"><time>'+esc(span>86400000?new Date(at).toLocaleDateString('en-GB',{timeZone:'Australia/Sydney',day:'2-digit',month:'2-digit'}):trajectoryClock(at))+'</time></span>';}
  s.events.forEach(function(e,index){if(e.at<s.viewFrom||e.at>s.viewTo)return;h+='<button type="button" class="trajectory-point'+(index===s.selected?' selected':'')+'" data-track-index="'+index+'" style="left:'+percent(e.at)+'%" onclick="trajectorySelect('+index+')" aria-label="'+esc(sydney(e.at)+' 时间点')+'" title="'+esc(sydney(e.at))+'"></button>';});
  h+='<i id="trajectoryCursor" style="left:'+percent(s.events[s.selected]?.at||s.viewFrom)+'%"></i></div><input class="trajectory-slider" type="range" aria-label="拖动选择轨迹时间" min="'+s.viewFrom+'" max="'+s.viewTo+'" step="1000" value="'+Math.max(s.viewFrom,Math.min(s.viewTo,s.events[s.selected]?.at||s.viewFrom))+'" oninput="trajectorySeek(Number(this.value))">';return h;
}
function trajectoryDetailHtml(s){var e=s.events[s.selected];if(!e)return '';var r=e.record,p=Trajectory.location(r),battery=r?batteryText(r):'—',media=Trajectory.related(e,s.media).filter(function(m){return m.type!=='photo';});
  function field(label,value){return '<div class="trajectory-detail-row"><span class="trajectory-field">'+label+'</span><span>'+esc(value)+'</span></div>';}
  var h='<div class="trajectory-detail-list">'+field('时间',sydney(e.at))+field(r&&r.battery_present===false?'供电':'电量',battery);
  h+=field('定位',p?locLabel(p.source)+(p.acc_m>0?' · '+Math.round(p.acc_m)+'m':'')+(Trajectory.quality(r)!=='good'?' · 不参与连线':''):'无对应位置');
  media.forEach(function(m){var expired=m.expired||m.expires_at<=Date.now(),label=m.type==='audio'?'录音':'录像';h+='<div class="trajectory-detail-row"><span class="trajectory-field">'+label+'</span><span>'+esc(trajectoryClock(m.captured_at))+' · '+Math.floor(m.duration_ms/60000)+':'+String(Math.floor(m.duration_ms/1000)%60).padStart(2,'0')+(m.time_source==='server'?' · 时间近似':'')+(expired?' · 已过期':!m.complete?' · 未完整结束':'')+'</span>'+(expired?'':'<button type="button" class="traffic-link" aria-label="播放'+label+'" onclick="trajectoryPlayMedia(\''+esc(m.type+':'+m.id)+'\')">播放</button>')+'</div>';});
  return h+'</div>';
}
function trajectorySeek(at){var s=historyState();if(s&&s.events.length)trajectorySelect(Trajectory.nearest(s.events,at));}
function trajectorySelect(index,keepPlayer){var s=historyState();if(!s||index<0||index>=s.events.length)return;if(index===s.selected&&s.historical&&!s.playItem&&!keepPlayer){trajectoryStopReplay();return;}if(!keepPlayer){trajectoryStopPlayer(s);trajectoryStopReplay();}var restoreTrack=!s.historical;s.selected=index;s.historical=true;if(restoreTrack)trajectoryDrawMap(false);
  var e=s.events[index];if(e.at<s.viewFrom||e.at>s.viewTo){var span=s.viewTo-s.viewFrom;s.viewFrom=Math.max(s.range.from,e.at-span/2);s.viewTo=Math.min(s.range.to,s.viewFrom+span);if($('trajectoryAxis'))$('trajectoryAxis').innerHTML=trajectoryAxisHtml(s);}
  if($('trajectoryDetail'))$('trajectoryDetail').innerHTML=trajectoryDetailHtml(s);if($('trajectoryTime'))$('trajectoryTime').textContent=sydney(e.at);
  if($('trajectoryAxis')){var input=$('trajectoryAxis').querySelector('input');if(input)input.value=e.at;$('trajectoryAxis').querySelectorAll('[data-track-index]').forEach(function(el){el.classList.toggle('selected',Number(el.dataset.trackIndex)===index);});}
  if($('trajectoryCursor'))$('trajectoryCursor').style.left=Math.max(0,Math.min(100,(e.at-s.viewFrom)/(s.viewTo-s.viewFrom)*100))+'%';
  trajectoryDrawSelected(true);renderRemoteConsole();
}
function trajectoryZoom(factor){var s=historyState();if(!s||!s.range)return;var center=s.events[s.selected]?.at||s.viewFrom,span=Math.max(60000,Math.min(s.range.to-s.range.from,(s.viewTo-s.viewFrom)*factor));s.viewFrom=Math.max(s.range.from,Math.min(s.range.to-span,center-span/2));s.viewTo=s.viewFrom+span;$('trajectoryAxis').innerHTML=trajectoryAxisHtml(s);}
function trajectoryStopReplay(){if(trajectoryTimer)clearInterval(trajectoryTimer);trajectoryTimer=null;if($('trajectoryPlay'))$('trajectoryPlay').textContent='播放轨迹';}
function trajectoryReplay(){if(trajectoryTimer){trajectoryStopReplay();return;}var s=historyState();if(!s||!s.events.length)return;trajectoryStopPlayer(s);if(s.selected>=s.events.length-1)trajectorySelect(0,true);trajectoryTimer=setInterval(function(){if(selFn!=='locate'||document.hidden||s!==historyState()||s.selected>=s.events.length-1){trajectoryStopReplay();return;}trajectorySelect(s.selected+1,true);},1000);if($('trajectoryPlay'))$('trajectoryPlay').textContent='暂停';}
function clearHistoryMarker(){if(historyMarker&&map)map.removeLayer(historyMarker);historyMarker=null;if(trajectoryLayer&&map)map.removeLayer(trajectoryLayer);trajectoryLayer=null;if(trajectorySelectedLayer&&map)map.removeLayer(trajectorySelectedLayer);trajectorySelectedLayer=null;Object.keys(markers).forEach(function(k){if(markers[k].setOpacity)markers[k].setOpacity(1);});Object.keys(circles).forEach(function(k){if(circles[k].setStyle)circles[k].setStyle({opacity:1,fillOpacity:.16});});}
function trajectoryDrawMap(fit){var s=trajectoryState();clearHistoryMarker();if(!s||!s.historical||!s.track||!map||typeof L==='undefined')return;trajectoryLayer=L.layerGroup().addTo(map);Object.keys(markers).forEach(function(k){markers[k].setOpacity(.18);});Object.keys(circles).forEach(function(k){circles[k].setStyle({opacity:.08,fillOpacity:.01});});var points=[];
  s.track.segments.forEach(function(segment){var coordinates=segment.map(function(i){var p=s.rows[i].location;points.push([p.lat,p.lng]);return [p.lat,p.lng];});if(coordinates.length>1)L.polyline(coordinates,{color:'#60a5fa',weight:2.5,opacity:.85}).addTo(trajectoryLayer);});
  s.track.groups.forEach(function(group){var i=group[0],r=s.rows[i],p=r.location;var layer=L.circleMarker([p.lat,p.lng],{radius:group.length>1?6:4,color:'#cfe4ff',weight:1,fillColor:'#60a5fa',fillOpacity:1}).addTo(trajectoryLayer);layer.bindTooltip(esc(trajectoryClock(Trajectory.time(r.timeline_at)))+(group.length>1?'—'+esc(trajectoryClock(Trajectory.time(s.rows[group.at(-1)].timeline_at)))+' · '+group.length+'次上报':''));layer.on('click',function(){trajectorySelect(s.events.findIndex(function(e){return e.index===i;}));});});
  s.track.areas.forEach(function(i){var p=s.rows[i].location;points.push([p.lat,p.lng]);var circle=L.circle([p.lat,p.lng],{radius:Number(p.acc_m)>0?Number(p.acc_m):2000,color:'#94a3b8',weight:1,fillOpacity:.035,dashArray:'3 5'}).addTo(trajectoryLayer);circle.on('click',function(){trajectorySelect(s.events.findIndex(function(e){return e.index===i;}));});});
  if(fit&&points.length)map.fitBounds(points,{padding:[30,30],maxZoom:17});trajectoryDrawSelected(false);
}
function trajectoryDrawSelected(pan){if(trajectorySelectedLayer&&map)map.removeLayer(trajectorySelectedLayer);trajectorySelectedLayer=null;var e=trajectoryEvent(),p=e&&Trajectory.location(e.record);if(!p||!map)return;trajectorySelectedLayer=L.layerGroup().addTo(map);if(p.acc_m>0)L.circle([p.lat,p.lng],{radius:p.acc_m,color:'#f5c451',weight:1,fillOpacity:.08}).addTo(trajectorySelectedLayer);L.circleMarker([p.lat,p.lng],{radius:6,color:'#fff0c2',weight:2,fillColor:'#f5c451',fillOpacity:1}).addTo(trajectorySelectedLayer).bindTooltip(esc(trajectoryClock(e.at)),{permanent:true,direction:'top',className:'trajectory-tooltip'});if(pan)map.panTo([p.lat,p.lng],{animate:false});}
function trajectoryStopPlayer(s){if(!s)return;if(s.playerNode){var el=s.playerNode.querySelector('audio,video');if(el){el.pause();el.removeAttribute('src');el.load();}s.playerNode=null;}if(s.audioFrame)cancelAnimationFrame(s.audioFrame);s.audioFrame=null;if(s.audioContext)s.audioContext.close().catch(function(){});s.audioContext=null;s.playItem=null;}
function trajectoryReturnLive(){var s=historyState();if(s){trajectoryStopPlayer(s);s.historical=false;}trajectoryStopReplay();clearHistoryMarker();renderRemoteConsole();}
function trajectoryLeave(){var s=historyState();if(s)s.historical=false;trajectoryStopPlayer(s);trajectoryStopReplay();clearHistoryMarker();}
function trajectoryPhotoStep(delta){var s=historyState(),e=trajectoryEvent();if(!s||!e)return;var indices=s.events.map(function(e,i){return Trajectory.related(e,s.media).some(function(m){return m.type==='photo';})?i:-1;}).filter(function(i){return i>=0;});var next=delta>0?indices.find(function(i){return i>s.selected;}):indices.slice().reverse().find(function(i){return i<s.selected;});if(next!=null)trajectorySelect(next);}
function trajectoryPreview(){var s=trajectoryState(),e=trajectoryEvent();if(!s||!e)return null;if(s.playItem)return '<div class="remote-preview trajectory-player"></div>';var photos=Trajectory.related(e,s.media).filter(function(m){return m.type==='photo';}),p=photos[0],expired=p&&(p.expired||p.expires_at<=Date.now());var h='<div class="remote-preview trajectory-photo">';
  h+=p&&!expired?'<img src="/api/elfremote/report-photo?'+esc(new URLSearchParams({device_id:selDev,report_id:p.report_id}).toString())+'" alt="所选时刻照片" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span hidden>照片暂不可用</span>':'<span>'+(s.mediaError?'照片记录暂不可用':expired?'照片已过期':'此时没有照片')+'</span>';
  h+='<button type="button" class="photo-nav photo-prev" aria-label="上一张历史照片" onclick="trajectoryPhotoStep(-1)">‹</button><button type="button" class="photo-nav photo-next" aria-label="下一张历史照片" onclick="trajectoryPhotoStep(1)">›</button><time class="photo-time">'+esc(sydney(p?p.captured_at:e.at))+'</time></div>';return h;
}
function trajectoryPlayMedia(key){var s=historyState(),item=s&&s.media.find(function(m){return m.type+':'+m.id===key;});if(!item||item.expired||item.expires_at<=Date.now())return;if(typeof ElfMedia!=='undefined'&&ElfMedia.isActive()){s.error='请先结束实时通信';renderOps();return;}trajectoryStopReplay();trajectoryStopPlayer(s);s.playItem=item;s.historical=true;renderRemoteConsole();}
function trajectoryMount(){var s=trajectoryState();if(!s||!s.playItem)return;var placeholder=document.querySelector('#remoteConsole .trajectory-player');if(!placeholder)return;if(s.playerNode){placeholder.replaceWith(s.playerNode);return;}var m=s.playItem;s.playerNode=placeholder;placeholder.innerHTML='<'+(m.type==='audio'?'audio':'video')+' controls playsinline preload="metadata"></'+(m.type==='audio'?'audio':'video')+'>'+(m.type==='audio'?'<canvas aria-label="历史录音波形"></canvas>':'')+'<time class="photo-time">'+esc(sydney(m.captured_at))+'</time>';var el=placeholder.querySelector('audio,video');el.src='/api/elfremote/media-recordings?'+new URLSearchParams({device_id:selDev,id:m.id});el.onloadedmetadata=function(){el.play().catch(function(){});};el.onerror=function(){if(s.playerNode!==placeholder)return;var message=placeholder.querySelector('.trajectory-play-error');if(!message){message=document.createElement('span');message.className='trajectory-play-error';message.setAttribute('role','alert');message.textContent='播放失败，请重新点击播放';placeholder.appendChild(message);}};
  el.ontimeupdate=function(){if(s!==historyState()||!s.playItem)return;var at=m.captured_at+el.currentTime*1000,index=Trajectory.playbackIndex(s.events,m,at);if(index>=0&&index!==s.selected)trajectorySelect(index,true);var t=s.playerNode&&s.playerNode.querySelector('time');if(t)t.textContent=sydney(at);};
  if(m.type==='audio')el.onplay=function(){try{if(!s.audioContext){s.audioContext=new AudioContext();var source=s.audioContext.createMediaElementSource(el),analyser=s.audioContext.createAnalyser();analyser.fftSize=512;source.connect(analyser);analyser.connect(s.audioContext.destination);s.analyser=analyser;}s.audioContext.resume();var canvas=placeholder.querySelector('canvas');canvas.width=600;canvas.height=140;var ctx=canvas.getContext('2d'),samples=new Uint8Array(s.analyser.frequencyBinCount);function draw(){if(!s.playerNode||el.paused)return;s.analyser.getByteTimeDomainData(samples);ctx.clearRect(0,0,600,140);ctx.strokeStyle='#60a5fa';ctx.beginPath();samples.forEach(function(v,i){var x=i/samples.length*600,y=v/128*70;if(i)ctx.lineTo(x,y);else ctx.moveTo(x,y);});ctx.stroke();s.audioFrame=requestAnimationFrame(draw);}if(s.audioFrame)cancelAnimationFrame(s.audioFrame);draw();}catch(e){}}
}

var DAILY_CACHE={}, DAILY_LAST={}, DAILY_FAILURES={}, TRAFFIC_HISTORY={seq:0};
var PHOTO_HISTORY={};
var MEDIA_HISTORY={device:null,type:'photo'},MEDIA_RECORDS={};
function photoHistory(d){
  if(!PHOTO_HISTORY[d.id])PHOTO_HISTORY[d.id]={photos:[],selected:null,loaded:0,pending:false,retry:0,latest:''};
  return PHOTO_HISTORY[d.id];
}
function visiblePhotos(state){return state.photos.filter(function(p){return p.expires_at>Date.now();});}
function loadReportPhotos(d){
  var state=photoHistory(d),latest=d.report_photo&&d.report_photo.report_id||'';
  if(state.pending)return state.promise;
  if(Date.now()<state.retry||(state.loaded&&state.latest===latest&&Date.now()-state.loaded<300000))return;
  state.pending=true;state.error='';var rows=[];
  function page(cursor){
    return fetch('/api/elfremote/report-photo?'+new URLSearchParams({device_id:d.id,list:'1',cursor:cursor||''})).then(function(r){if(!r.ok)throw Error('照片读取失败');return r.json();}).then(function(x){
      if(!x.ok)throw Error('照片读取失败');rows=rows.concat(x.photos);return x.next?page(x.next):rows;
    });
  }
  return state.promise=page('').then(function(){
    state.photos=rows.sort(function(a,b){return b.captured_at.localeCompare(a.captured_at)||b.report_id.localeCompare(a.report_id);});
    state.loaded=Date.now();state.latest=latest;
    if(state.selected&&!state.photos.some(function(p){return p.report_id===state.selected;}))state.selected=null;
  }).catch(function(){state.error='照片读取失败';state.retry=Date.now()+15000;}).finally(function(){
    state.pending=false;if(currentDev()&&currentDev().id===d.id)renderRemoteConsole();renderMediaHistory();
  });
}
function stepReportPhoto(delta){
  var d=currentDev();if(!d)return;var state=photoHistory(d),photos=visiblePhotos(state);
  var index=Math.max(0,photos.findIndex(function(p){return p.report_id===state.selected;})),next=index+delta;
  if(next<0||next>=photos.length)return;
  state.selected=next===0?null:photos[next].report_id;renderRemoteConsole();
}
function openMediaHistory(){
  var d=currentDev();if(!d)return;
  MEDIA_HISTORY={device:d.id,type:'photo'};
  if(!$('mediaHistoryWrap')){
    var wrap=document.createElement('div');wrap.id='mediaHistoryWrap';wrap.className='media-history-wrap';
    wrap.onclick=function(e){if(e.target===wrap)closeMediaHistory();};document.body.appendChild(wrap);
  }
  $('mediaHistoryWrap').style.display='flex';renderMediaHistory();
  Promise.resolve(loadReportPhotos(d)).then(renderMediaHistory);
  MEDIA_RECORDS[d.id]=null;fetch('/api/elfremote/media-recordings?'+new URLSearchParams({device_id:d.id,list:'1'})).then(function(r){if(!r.ok)throw Error('历史记录读取失败');return r.json();}).then(function(x){MEDIA_RECORDS[d.id]=x.records;renderMediaHistory();}).catch(function(){MEDIA_RECORDS[d.id]={error:'历史记录读取失败'};renderMediaHistory();});
}
function closeMediaHistory(){MEDIA_HISTORY.device=null;var wrap=$('mediaHistoryWrap');if(wrap){wrap.querySelectorAll('audio,video').forEach(function(el){el.pause();});wrap.style.display='none';}}
function selectMediaType(type){MEDIA_HISTORY.type=type;renderMediaHistory();}
function showMediaPhoto(index){
  var d=DEV.find(function(x){return x.id===MEDIA_HISTORY.device;});if(!d)return;
  var photos=visiblePhotos(photoHistory(d)),photo=photos[index];if(!photo)return;
  photoHistory(d).selected=photo.report_id;closeMediaHistory();if(selDev!==d.id){selDev=d.id;renderList();renderOps();}renderRemoteConsole();
}
function renderMediaHistory(){
  if(!MEDIA_HISTORY.device||!$('mediaHistoryWrap'))return;
  var d=DEV.find(function(x){return x.id===MEDIA_HISTORY.device;});if(!d){closeMediaHistory();return;}
  var state=photoHistory(d),photos=visiblePhotos(state),type=MEDIA_HISTORY.type;
  var h='<section class="media-history-card" role="dialog" aria-modal="true" aria-label="历史记录"><div class="media-history-head"><h3>历史记录</h3><span>'+esc(d.name)+'</span><button type="button" class="btn-close" aria-label="关闭历史记录" onclick="closeMediaHistory()">&times;</button></div><div class="media-history-tabs">';
  [['photo','照片'],['audio','录音'],['video','录像']].forEach(function(row){h+='<button type="button" class="'+(type===row[0]?'active':'')+'" onclick="selectMediaType(\''+row[0]+'\')">'+row[1]+'</button>';});
  h+='</div><div class="media-history-grid">';
  if(type==='photo'&&photos.length)photos.forEach(function(p,i){h+='<button type="button" class="media-history-photo" onclick="showMediaPhoto('+i+')"><img loading="lazy" src="/api/elfremote/report-photo?'+esc(new URLSearchParams({device_id:d.id,report_id:p.report_id}).toString())+'" alt="照片"><time>'+esc(sydney(p.captured_at))+'</time></button>';});
  else if(type!=='photo'){
    var records=MEDIA_RECORDS[d.id];
    if(Array.isArray(records)&&records.some(function(r){return r.type===type;}))records.filter(function(r){return r.type===type;}).forEach(function(r){var url='/api/elfremote/media-recordings?'+new URLSearchParams({device_id:d.id,id:r.id});h+='<div class="media-history-record"><time>'+esc(sydney(r.captured_at))+' · '+Math.ceil(r.duration_ms/1000)+'s'+(r.complete?'':' · 中断')+'</time><'+(type==='audio'?'audio':'video')+' controls preload="none" src="'+esc(url)+'"></'+(type==='audio'?'audio':'video')+'></div>';});
    else h+='<p class="media-history-empty">'+(!records?'读取中…':records.error||('暂无'+(type==='audio'?'录音':'录像')))+'</p>';
  }else h+='<p class="media-history-empty">'+(state.error||(!state.loaded?'读取中…':'暂无照片'))+'</p>';
  $('mediaHistoryWrap').innerHTML=h+'</div></section>';
}
function reportPhotoHtml(d){
  var state=d?photoHistory(d):null,photos=state?visiblePhotos(state):[];
  var index=state?Math.max(0,photos.findIndex(function(p){return p.report_id===state.selected;})):0,photo=photos[index];
  var h='<div class="remote-preview">';
  h+=photo?'<img src="/api/elfremote/report-photo?'+esc(new URLSearchParams({device_id:d.id,report_id:photo.report_id}).toString())+'" alt="设备上报照片" onerror="this.hidden=true;this.parentNode.querySelector(\'.photo-error\').hidden=false"><span class="photo-error" hidden>照片暂不可用</span>':'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg><span>'+(state?(state.error||(!state.loaded?'照片读取中…':'暂无上报照片')):'画面与播放区域')+'</span>';
  h+='<button type="button" class="photo-nav photo-prev" aria-label="上一张照片" onclick="stepReportPhoto(1)"'+(index+1<photos.length?'':' disabled')+'><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m14 6-6 6 6 6"/></svg></button>';
  h+='<button type="button" class="photo-nav photo-next" aria-label="下一张照片" onclick="stepReportPhoto(-1)"'+(index>0?'':' disabled')+'><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m10 6 6 6-6 6"/></svg></button>';
  if(photo)h+='<time class="photo-time" datetime="'+esc(photo.captured_at)+'" title="拍摄时间 · 悉尼">'+esc(sydney(photo.captured_at))+'</time>';
  return h+'</div>';
}
function trafficDay(){var p=new Intl.DateTimeFormat('en-CA',{timeZone:'Australia/Sydney',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());var v={};p.forEach(function(x){v[x.type]=x.value;});return v.year+'-'+v.month+'-'+v.day;}
function shiftTrafficDay(day,n){return new Date(Date.parse(day+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);}
function trafficBytes(n){return (Number(n||0)/1000).toFixed(1)+' KB';}
function dailyTrafficHtml(row){return row && row.available?'接收 '+trafficBytes(row.rx_bytes)+'　发送 '+trafficBytes(row.tx_bytes):'无数据';}
function renderRemoteConsole(){
  var box=$('remoteConsole');if(!box) return;
  var d=currentDev(),day=trafficDay(),key=d?d.id+'|'+day+'|'+(d.traffic&&d.traffic.sampled_at_ms||0):'',cached=DAILY_CACHE[key];
  var errorText=serviceErrorText();
  var h='<div class="remote-head"><div class="remote-title"><h3>通信终端</h3><span id="serviceError" role="status"'+(errorText?'':' hidden')+'>'+esc(errorText)+'</span></div><div class="remote-head-actions"><span class="remote-device">'+esc(d?d.name:'未选择设备')+'</span><button type="button" class="traffic-link" onclick="openMediaHistory()"'+(d?'':' disabled')+'>历史记录</button></div></div>';
  var media=typeof ElfMedia!=='undefined'?ElfMedia:null,historical=trajectoryPreview(),event=trajectoryEvent(),photoNode=box.querySelector('.trajectory-photo'),photoKey=event&&!historyState().playItem?JSON.stringify([selDev,event.key,historical]):null,retainPhoto=photoNode&&photoKey&&photoNode.dataset.trajectoryKey===photoKey?photoNode:null;if(retainPhoto)historical='<div class="remote-preview trajectory-photo"></div>';
  if(trajectoryEvent())h+='<div class="trajectory-preview-caption">历史 · '+esc(sydney(trajectoryEvent().at))+'<button type="button" class="traffic-link" onclick="trajectoryReturnLive()">返回实时</button></div>';
  h+=(historical&&!(media&&media.isActive())?historical:(media?media.preview(d,reportPhotoHtml(d)):reportPhotoHtml(d)))+'<div class="remote-controls">';
  h+=media?media.controls(d):['PTT','电话','麦克风','拍照','录像','响铃'].map(function(label){return '<button type="button" disabled>'+label+'</button>';}).join('');
  h+='</div>'+(media?media.feedback(d):'')+'<div class="remote-traffic"><strong>当日流量</strong><span>'+(d?(cached?(cached.error?(DAILY_LAST[d.id+'|'+day]?dailyTrafficHtml(DAILY_LAST[d.id+'|'+day]):'—'):(cached.pending?'读取中…':dailyTrafficHtml(cached.row))):'读取中…'):'未选择设备')+'</span><button class="traffic-link" onclick="openTrafficHistory()"'+(d?'':' disabled')+'>查看历史流量</button></div>';
  box.innerHTML=h;
  var placeholder=box.querySelector('.trajectory-photo');if(placeholder&&retainPhoto)placeholder.replaceWith(retainPhoto);else if(placeholder&&photoKey)placeholder.dataset.trajectoryKey=photoKey;
  if(media)media.mount(d);
  trajectoryMount();
  if(d)loadReportPhotos(d);
  if(d && !document.hidden && (!cached||(cached.error&&Date.now()>=cached.retryAt))){
    DAILY_CACHE[key]={pending:true};
    fetch('/api/devices/traffic?'+new URLSearchParams({device_id:d.id,from:day,to:day})).then(readServiceJson).then(function(x){
      DAILY_CACHE[key]={row:x.days[0]};DAILY_LAST[d.id+'|'+day]=x.days[0];DAILY_FAILURES[d.id]=0;setServiceError('traffic:'+d.id,null);
    }).catch(function(e){
      var failures=DAILY_FAILURES[d.id]=(DAILY_FAILURES[d.id]||0)+1;
      DAILY_CACHE[key]={error:true,retryAt:Date.now()+Math.max(e.retryAfter||0,Math.min(300000,15000*Math.pow(2,Math.min(5,failures-1))))};setServiceError('traffic:'+d.id,e);
    }).finally(function(){if(currentDev()&&currentDev().id===d.id) renderRemoteConsole();});
  }
}
function openTrafficHistory(){
  var d=currentDev();if(!d)return;var to=trafficDay();
  TRAFFIC_HISTORY={seq:TRAFFIC_HISTORY.seq+1,id:d.id,name:d.name,days:[]};
  $('trafficHistoryBody').innerHTML='<div class="traffic-header"><h3>历史流量</h3><div class="traffic-range"><input type="date" aria-label="开始日期" id="trafficFrom" value="'+shiftTrafficDay(to,-29)+'" onchange="loadTrafficHistory()"><span>–</span><input type="date" aria-label="结束日期" id="trafficTo" value="'+to+'" onchange="loadTrafficHistory()"></div><button class="btn-close" onclick="closeTrafficHistory()" aria-label="关闭流量历史">&times;</button></div><div class="traffic-chart-frame"><div id="trafficY"></div><div id="trafficChart"></div></div><p id="trafficDetail" role="status"></p>';
  show('trafficHistoryWrap');loadTrafficHistory();
}
function closeTrafficHistory(){TRAFFIC_HISTORY.seq++;hide('trafficHistoryWrap');}
function loadTrafficHistory(){
  var state=TRAFFIC_HISTORY,seq=++state.seq,from=$('trafficFrom').value,to=$('trafficTo').value;
  if(!from||!to||from>to||Date.parse(to)-Date.parse(from)>365*86400000){$('trafficDetail').textContent='请选择不超过366天的有效日期范围';return Promise.resolve();}
  $('trafficDetail').textContent='读取中…';
  return fetch('/api/devices/traffic?'+new URLSearchParams({device_id:state.id,from:from,to:to})).then(function(r){if(!r.ok)throw Error('查询失败');return r.json();}).then(function(x){
    if(TRAFFIC_HISTORY!==state||seq!==state.seq)return;if(!x.ok)throw Error(x.msg||'查询失败');
    state.days=x.days;renderTrafficChart();selectTrafficBar(state.days.length-1);
  }).catch(function(e){if(TRAFFIC_HISTORY===state&&seq===state.seq){$('trafficChart').innerHTML='';$('trafficDetail').textContent=e.message;}});
}
function renderTrafficChart(){
  var days=TRAFFIC_HISTORY.days,peak=Math.max(1000,...days.map(function(d){return d.rx_bytes+d.tx_bytes;}));
  var power=Math.pow(10,Math.floor(Math.log10(peak/3))),step=[1,2,5,10].map(function(n){return n*power;}).find(function(n){return n>=peak/3;}),max=step*3;
  $('trafficY').innerHTML='<small>KB</small>'+[3,2,1,0].map(function(n){return '<span style="top:'+((3-n)*70)+'px">'+(n*step/1000).toLocaleString('en',{maximumFractionDigits:1})+'</span>';}).join('');
  var axis=days.length?[0,Math.floor((days.length-1)/2),days.length-1].filter(function(n,i,a){return a.indexOf(n)===i;}):[];
  $('trafficChart').innerHTML='<div class="traffic-plot" style="min-width:'+Math.max(0,days.length*8)+'px"><div class="traffic-bars">'+days.map(function(d,i){
    var title=d.date+' · '+dailyTrafficHtml(d);
    return '<button class="traffic-bar" onclick="selectTrafficBar('+i+')" title="'+esc(title)+'" aria-label="'+esc(title)+'"><span class="traffic-stack">'+(d.available?'<i class="traffic-tx" style="height:'+Math.max(d.tx_bytes?1:0,d.tx_bytes/max*210)+'px"></i><i class="traffic-rx" style="height:'+Math.max(d.rx_bytes?1:0,d.rx_bytes/max*210)+'px"></i>':'')+'</span>'+(!d.available||d.rx_bytes+d.tx_bytes===0?'<span class="traffic-empty" aria-hidden="true"></span>':'')+'</button>';
  }).join('')+'</div><div class="traffic-axis">'+axis.map(function(i){return '<span style="left:'+((i+.5)/days.length*100)+'%">'+days[i].date.slice(5).replace('-','/')+'</span>';}).join('')+'</div></div>';
}
function selectTrafficBar(i){
  var d=TRAFFIC_HISTORY.days[i];if(!d)return;
  $('trafficDetail').innerHTML=esc(d.date)+' · '+(d.available?'<span class="traffic-rx-text">接收 '+trafficBytes(d.rx_bytes)+'</span> / <span class="traffic-tx-text">发送 '+trafficBytes(d.tx_bytes)+'</span> / 总计 '+trafficBytes(d.rx_bytes+d.tx_bytes):'无数据');
  document.querySelectorAll('.traffic-bar').forEach(function(b,n){b.classList.toggle('selected',n===i);if(n===i){var chart=$('trafficChart'),bar=b.getBoundingClientRect(),view=chart.getBoundingClientRect();chart.scrollLeft+=bar.left-view.left-(chart.clientWidth-bar.width)/2;}});
}
var SYSTEM_TAB='Wi-Fi';
var SYSTEM_GROUPS={'Wi-Fi':[],'网络与连接':['移动数据','热点','蓝牙与已配对设备','USB状态'],'应用':['应用列表','权限','通知','后台限制'],'声音与显示':['音量','亮度','字体大小'],'语言与时间':['语言','自动时间','时区'],'账号配置':[]};
function selectSystemTab(tab){SYSTEM_TAB=tab;renderOps();if(tab!=='账号配置'&&tab!=='故障记录')readSystemSettings();}
function pageSystem(dis){
  var tabs=Object.keys(SYSTEM_GROUPS),faults=typeof ElfFaults!=='undefined'&&ElfFaults.available(currentDev());if(faults)tabs.push('故障记录');if(SYSTEM_TAB==='故障记录'&&!faults)SYSTEM_TAB='Wi-Fi';
  var h='<div class="system-layout"><nav class="system-tabs" aria-label="系统配置分类">'+tabs.map(function(k){return '<button class="btn-gray'+(SYSTEM_TAB===k?' active':'')+'" aria-pressed="'+(SYSTEM_TAB===k)+'" onclick="selectSystemTab(\''+k+'\')">'+k+'</button>';}).join('')+'</nav><section class="system-content">';
  if(SYSTEM_TAB==='账号配置')return h+pageAccountSettings(dis)+'</section></div>';
  if(SYSTEM_TAB==='故障记录')return h+ElfFaults.page()+'</section></div>';
  if(SYSTEM_TAB==='Wi-Fi')return h+'<div class="system-wifi">'+pageWifi(dis).replace('<table','<div class="system-table-scroll"><table').replace('</table>','</table></div>')+'</div></section></div>';
  return h+pageSystemSettings(dis)+'</section></div>';
}

var SYSTEM_GROUP_IDS={'Wi-Fi':'wifi','网络与连接':'network','应用':'apps','声音与显示':'sound','语言与时间':'time'};
function systemSettingsState(){var u=uiOf();return u.systemSettings||(u.systemSettings={pending:false,message:'',package:'',offset:0});}
function systemSnapshot(){var d=currentDev();return d&&d.system_settings&&d.system_settings[SYSTEM_GROUP_IDS[SYSTEM_TAB]];}
function systemField(key,label,control,blocked){return '<form class="system-setting-row" onsubmit="event.preventDefault();saveSystemField(\''+key+'\')"><label for="setting-'+key+'">'+esc(label)+'</label>'+control+'<button class="btn-green" type="submit"'+blocked+'>保存</button></form>';}
function systemNumber(key,label,value,min,max,step,blocked){return systemField(key,label,'<input class="inp" id="setting-'+key+'" type="number" value="'+esc(value)+'" min="'+min+'" max="'+max+'" step="'+step+'" required'+blocked+'>',blocked);}
function systemToggle(key,label,value,blocked){return systemField(key,label,'<select class="inp" id="setting-'+key+'"'+blocked+'><option value="true"'+(value?' selected':'')+'>开启</option><option value="false"'+(!value?' selected':'')+'>关闭</option></select>',blocked);}
function systemBackgroundSetting(data,blocked){
  if(data.background_supported===false)return '<div class="system-setting-row"><label>允许后台运行</label><span class="muted">此系统不支持单独设置</span></div>';
  return systemToggle('background','允许后台运行',data.background,blocked);
}
function pageSystemSettings(dis){
  var d=currentDev();if(!d)return '<p class="muted">请先选择设备</p>';
  var state=systemSettingsState(),data=systemSnapshot(),group=SYSTEM_GROUP_IDS[SYSTEM_TAB],blocked=dis||(!d.managed_system_settings||d.enabled===false||state.pending?' disabled':'');
  var h='<div class="ops-actions"><button class="btn-gray" onclick="readSystemSettings()"'+blocked+'>读取当前设置</button><span role="status">'+esc(state.message||(!d.managed_system_settings?'请更新客户端后使用':data?'读取于 '+sydney(data.sampled_at):'尚未读取设备设置'))+'</span></div>';
  if(!data)return h;
  if(group==='sound'){
    h+='<div class="system-settings-grid">';[['media','媒体音量'],['ring','铃声音量'],['alarm','闹钟音量'],['call','通话音量']].forEach(function(item){h+=systemNumber(item[0],item[1],data[item[0]],0,data.maximum[item[0]],1,blocked);});
    h+=systemToggle('brightness_auto','自动亮度',data.brightness_auto,blocked)+systemNumber('brightness','屏幕亮度',data.brightness,1,255,1,blocked||(data.brightness_auto?' disabled':''))+systemNumber('font_scale','字体大小',data.font_scale,.85,1.5,.05,blocked)+'</div>';
  }else if(group==='time'){
    h+='<div class="system-settings-grid">'+systemToggle('auto_time','自动时间',data.auto_time,blocked)+systemToggle('auto_time_zone','自动时区',data.auto_time_zone,blocked);
    var locales=Array.from(new Set([data.locale].concat(data.locales||[]))).filter(Boolean),names;try{names=new Intl.DisplayNames(['zh-CN'],{type:'language'});}catch(e){}
    h+=systemField('locale','系统语言','<select class="inp" id="setting-locale"'+blocked+'>'+locales.map(function(l){var label=l;try{if(names)label=names.of(l);}catch(e){}return '<option value="'+esc(l)+'"'+(l===data.locale?' selected':'')+'>'+esc(label)+' · '+esc(l)+'</option>';}).join('')+'</select>',blocked);
    var zones;try{zones=Intl.supportedValuesOf('timeZone');}catch(e){zones=['Australia/Sydney','Australia/Brisbane','Australia/Perth','UTC'];}zones=Array.from(new Set([data.timezone,'UTC'].concat(zones))).filter(function(zone){return !data.timezones||data.timezones.includes(zone);});
    var zoneDisabled=blocked||(data.auto_time_zone?' disabled':'');
    h+=systemField('timezone','时区','<select class="inp" id="setting-timezone"'+zoneDisabled+'>'+zones.map(function(z){return '<option value="'+esc(z)+'"'+(z===data.timezone?' selected':'')+'>'+esc(z)+'</option>';}).join('')+'</select>',zoneDisabled)+'</div>';
  }else if(group==='network'){
    h+='<div class="system-settings-grid">'+systemToggle('mobile_data',data.mobile_available?'移动数据':'未检测到SIM卡',data.mobile_data,blocked||(!data.mobile_available?' disabled':''))+systemToggle('bluetooth',data.bluetooth_supported?'蓝牙':'设备无蓝牙',data.bluetooth,blocked||(!data.bluetooth_supported?' disabled':''))+'</div>';
    h+='<div class="system-setting-section"><h4>热点</h4><form class="ops-actions" onsubmit="event.preventDefault();saveSystemHotspot(true)"><input class="inp" id="setting-hotspot-name" aria-label="热点名称" placeholder="热点名称" value="'+esc(data.hotspot.ssid||'')+'" required'+blocked+'><input class="inp" id="setting-hotspot-password" type="password" aria-label="热点密码" placeholder="热点密码" minlength="8" maxlength="63" autocomplete="new-password" required'+blocked+'><button class="btn-green"'+blocked+'>保存并开启</button><button type="button" class="btn-gray" onclick="saveSystemHotspot(false)"'+(blocked||(!data.hotspot.enabled?' disabled':''))+'>关闭热点</button><span>'+esc(data.hotspot.enabled?'已开启':'已关闭')+'</span></form></div>';
    h+='<div class="system-setting-section"><h4>已配对蓝牙设备</h4>'+((data.paired||[]).length?'<div class="system-items">'+data.paired.map(function(p){return '<div><span>'+esc(p.name||'蓝牙设备')+'</span><span>'+esc(p.address)+'</span></div>';}).join('')+'</div>':'<p class="muted">'+(data.bluetooth?'暂无已配对设备':'蓝牙已关闭')+'</p>')+'</div><div class="system-items"><div><span>USB模式</span><span>'+esc((data.usb||'none').split(',').map(function(mode){return {mtp:'文件传输',adb:'USB调试',rndis:'USB网络共享',ptp:'照片传输',none:'未启用'}[mode]||mode;}).join(' · '))+'</span></div></div>';
  }else if(group==='apps'){
    if(data.package){
      h+='<div class="system-setting-section"><div class="ops-actions"><button class="btn-gray" onclick="systemChooseApp(\'\')"'+blocked+'>返回应用列表</button><span>'+esc(data.name)+' · '+esc(data.version||'')+'</span></div><p class="muted">'+esc(data.package)+'</p></div><div class="system-settings-grid">'+systemToggle('enabled','应用启用',data.enabled,blocked)+systemToggle('notifications','允许通知',data.notifications,blocked)+systemBackgroundSetting(data,blocked)+'</div><div class="system-setting-section"><h4>运行时权限</h4><div class="system-items">';
      (data.permissions||[]).forEach(function(p,i){h+='<div><span>'+esc(p.label||p.name)+'</span><button class="'+(p.granted?'btn-gray':'btn-green')+'" onclick="systemPermission('+i+')"'+blocked+'>'+esc(p.granted?'撤销':'允许')+'</button></div>';});h+=data.permissions.length?'':'<p class="muted">该应用没有可调整的运行时权限</p>';h+='</div></div>';
    }else{
      h+='<div class="system-setting-section function-table"><table><thead><tr><th>应用</th><th>状态</th><th></th></tr></thead><tbody>'+(data.apps||[]).map(function(a){return '<tr><td>'+esc(a.name)+'<br><span class="muted">'+esc(a.package)+'</span></td><td>'+esc(a.enabled?'已启用':'已停用')+'</td><td><button class="btn-gray" data-package="'+esc(a.package)+'" onclick="systemChooseApp(this.dataset.package)"'+blocked+'>设置</button></td></tr>';}).join('')+'</tbody></table></div><div class="ops-actions"><button class="btn-gray" onclick="systemAppsPage(-1)"'+(blocked||data.offset===0?' disabled':'')+'>上一页</button><span>共 '+data.total+' 个应用</span><button class="btn-gray" onclick="systemAppsPage(1)"'+(blocked||data.next<0?' disabled':'')+'>下一页</button></div>';
    }
  }
  return h;
}
async function runSystemSettings(params){
  var d=currentDev();if(!d||!d.managed_system_settings||d.enabled===false)return;var state=systemSettingsState();if(state.pending){if(params.action==='read')state.nextRead=params;return;}
  state.pending=true;state.message=params.action==='set'?'正在应用设置':'正在读取设备设置';renderOps();
  try{
    var r=await fileApi('/api/elfremote/task',{device_id:d.id,type:'system_config',id:'settings-'+crypto.randomUUID(),params:params}),task;
    for(var start=Date.now();Date.now()-start<150000;){
      var x=await fileApi('/api/elfremote/tasks?'+new URLSearchParams({device_id:d.id,task_id:r.task.id}));task=x.task;
      if(task&&['success','failed','rejected','expired'].includes(task.state))break;
      await new Promise(function(resolve){setTimeout(resolve,1200);});
    }
    if(!task||task.state!=='success')throw Error(task&&task.result&&task.result.text||task&&task.detail||'尚未收到完成结果，请稍后重新读取');
    if(task.result.truncated)throw Error('设备结果不完整，请重新读取');
    var snapshot=JSON.parse(task.result.text),current=DEV.find(function(x){return x.id===d.id;});if(current)current.system_settings=Object.assign({},current.system_settings,{[params.group]:snapshot});
    state.message=params.action==='set'?'设置已生效':'已读取 · '+sydney(snapshot.sampled_at);
    if(params.group==='wifi'&&$('wifiPw'))$('wifiPw').value='';
  }catch(e){state.message=e.message;}finally{state.pending=false;var next=state.nextRead;state.nextRead=null;if(selDev===d.id&&selFn==='wifi'){renderOps();if(next&&next.group===SYSTEM_GROUP_IDS[SYSTEM_TAB])runSystemSettings(next);}}
}
function readSystemSettings(){var d=currentDev();if(!d||!d.managed_system_settings)return;var group=SYSTEM_GROUP_IDS[SYSTEM_TAB],s=systemSettingsState();if(group)runSystemSettings({group:group,action:'read',package:group==='apps'?s.package:'',offset:group==='apps'?s.offset:0});}
function saveSystemField(key){var group=SYSTEM_GROUP_IDS[SYSTEM_TAB],el=$('setting-'+key),v=el.value;if(el.type==='number')v=Number(v);else if(v==='true'||v==='false')v=v==='true';runSystemSettings({group:group,action:'set',key:key,value:v,package:group==='apps'?systemSnapshot().package:''});}
function saveSystemHotspot(enabled){runSystemSettings({group:'network',action:'set',key:'hotspot',value:{enabled:enabled,ssid:$('setting-hotspot-name').value.trim(),password:$('setting-hotspot-password').value}});}
function systemChooseApp(pkg){var s=systemSettingsState();s.package=pkg;s.offset=0;readSystemSettings();}
function systemAppsPage(direction){var s=systemSettingsState(),d=systemSnapshot();s.offset=direction>0?d.next:Math.max(0,d.offset-15);readSystemSettings();}
function systemPermission(i){var d=systemSnapshot(),p=d.permissions[i];runSystemSettings({group:'apps',action:'set',package:d.package,key:'permission',value:{name:p.name,granted:!p.granted}});}
var ACCOUNT_LABELS={Linphone:'Linphone',Zello:'Zello',Nexui:'Nexui 电话',QUIK:'QUIK 短信'};
var ACCOUNT_TARGETS={Linphone:'linphone',Nexui:'nexui',QUIK:'quik'};
function accountSoftware(d){
  if(!d)return [];
  var model=MODELS.find(function(m){return m.id===d.model_id;}),key=String(model&&model.registration_key||({mdl_d22:'d22',mdl_d31:'d31',mdl_h13:'h13'}[d.model_id])||d.model_name||'').toLowerCase().replace(/[^a-z0-9]/g,'');
  var items=key==='d31'?['Nexui','QUIK']:key==='d22'?['Linphone','Zello']:key==='h13'?['Zello']:[];
  Object.keys(ACCOUNT_TARGETS).forEach(function(name){if((d.sip_targets||[]).some(function(t){return t.target===ACCOUNT_TARGETS[name];})&&!items.includes(name))items.push(name);});
  if(d.managed_zello_account===true&&!items.includes('Zello'))items.push('Zello');
  if(d.managed_sip_account===true&&!Array.isArray(d.sip_targets)&&key!=='d31'&&!items.includes('Linphone'))items.unshift('Linphone');
  return items;
}
function selectAccountTab(name){var d=currentDev();if(d&&accountSoftware(d).includes(name)){uiOf().accountTab=name;renderOps();}}
function pageAccountSettings(dis){
  var d=currentDev(),items=accountSoftware(d),u=uiOf();
  if(!items.length)return '<p class="muted">此型号尚未配置账号项目</p>';
  if(!items.includes(u.accountTab))u.accountTab=items[0];
  var h='<div class="account-tabs" role="group" aria-label="账号类型">'+items.map(function(name){return '<button class="btn-gray'+(u.accountTab===name?' active':'')+'" aria-pressed="'+(u.accountTab===name)+'" onclick="selectAccountTab(\''+name+'\')">'+ACCOUNT_LABELS[name]+'</button>';}).join('')+'</div>';
  return h+(u.accountTab==='Zello'?pageZelloAccount(dis):u.accountTab==='Linphone'?pageSipAccount(dis):pageMultiSipAccount(dis,ACCOUNT_TARGETS[u.accountTab]));
}
function pageZelloAccount(dis){
  var d=currentDev(),saved=d&&d.zello_account||{},t=d&&d.task||{},blocked=dis||(!d||!d.managed_zello_account||!maintenanceAvailable(d,'configure_zello')?' disabled':'');
  return '<form id="zelloAccountForm" class="account-fields" onsubmit="configureZelloAccount(event)"><label>普通Zello账号<input id="zelloAccountUser" class="inp" required autocomplete="off" value="'+esc(saved.username||'')+'"'+blocked+'></label><label>密码<input id="zelloAccountPassword" class="inp" required type="password" autocomplete="new-password"'+blocked+'></label><div class="ops-actions"><button type="submit" class="btn-green"'+blocked+'>保存并登录</button><span id="zelloAccountFeedback" role="status">'+esc(t.type==='configure_zello'?(t.detail||t.label):saved.updated_at?'上次登录成功 · '+sydney(saved.updated_at):d&&!d.managed_zello_account?'请更新客户端后使用':'尚未配置账号')+'</span></div></form>';
}
async function configureZelloAccount(event){
  event.preventDefault();var d=currentDev();if(!d||!d.managed_zello_account)return;
  var params={username:$('zelloAccountUser').value.trim(),password:$('zelloAccountPassword').value,type:'regular'},button=$('zelloAccountForm').querySelector('button[type=submit]');button.disabled=true;
  try{await fileApi('/api/elfremote/task',{device_id:d.id,type:'configure_zello',id:'zello-'+crypto.randomUUID(),params:params});if(selDev===d.id&&$('zelloAccountPassword')){$('zelloAccountPassword').value='';$('zelloAccountFeedback').textContent='已发送，等待设备登录';}loadDevices();}
  catch(e){if(selDev===d.id&&$('zelloAccountFeedback'))$('zelloAccountFeedback').textContent=e.message;}
  finally{params.password='';if(button.isConnected)button.disabled=false;}
}
function sipAccountRows(d){var rows=d&&Array.isArray(d.sip_accounts)?d.sip_accounts:[],target=d&&ACCOUNT_TARGETS[UI[d.id]&&UI[d.id].accountTab];return target?rows.filter(function(a){return a.target===target;}):rows;}
function selectedSipAccount(){
  var d=currentDev(),rows=sipAccountRows(d),u=uiOf();if(!u)return null;
  var found=rows.find(function(a){return a.target+'|'+a.account_id===u.sipSelection;});
  if(!found&&rows.length){found=rows[0];u.sipSelection=found.target+'|'+found.account_id;}
  return found||null;
}
function selectSipAccount(index){var rows=sipAccountRows(currentDev()),a=rows[Number(index)];if(a){uiOf().sipSelection=a.target+'|'+a.account_id;renderOps();}}
function sipConfigurationLabel(a){
  var r=a.configuration_result;if(!r)return a.configuration?'配置已保存':'尚未配置';
  return {pending:'等待设备配置',claimed:'设备已接收',running:'正在配置',success:'配置已写入',failed:'配置失败',rejected:'设备拒绝配置',expired:'配置任务超时'}[r.state]||'配置状态未知';
}
function sipRegistrationLabel(d,a){
  if(d.online===false)return '设备离线，注册状态待确认';
  var r=a.registration;if(!r)return '尚未收到注册状态';
  if(!r.fresh)return '注册状态已过期，等待更新';
  return {registered:'已注册',registering:'正在注册',unregistered:'未注册',failed:'注册失败',unknown:'注册状态未知'}[r.state]||'注册状态未知';
}
var SIP_DIRECTORY=null,SIP_DIRECTORY_REQUEST=null,SIP_DIRECTORY_ATTEMPTED=false;
function managedSipOptions(target){
  return '<option value="">请选择分机</option>'+(SIP_DIRECTORY||[]).map(function(a){
    var disabled=!a.available||(target==='quik'&&!a.sms);
    return '<option value="'+esc(a.extension)+'"'+(disabled?' disabled':'')+'>'+esc(a.extension+(a.name?' · '+a.name:'')+(!a.available?' · 未设置密码':target==='quik'&&!a.sms?' · 未开启短信':''))+'</option>';
  }).join('');
}
async function loadManagedSipDirectory(){
  if(SIP_DIRECTORY_REQUEST)return SIP_DIRECTORY_REQUEST;
  SIP_DIRECTORY_ATTEMPTED=true;
  SIP_DIRECTORY_REQUEST=(async function(){
    try{
      var body=await readServiceJson(await fetch('/api/devices/sip-directory'));
      if(!body.ok||!Array.isArray(body.accounts))throw Error(body.msg||'读取分机列表失败');
      SIP_DIRECTORY=body.accounts;
      var select=$('managedSipExtension');
      if(select){var old=select.value;select.innerHTML=managedSipOptions(select.dataset.target);select.value=old;}
      if($('managedSipFeedback'))$('managedSipFeedback').textContent=SIP_DIRECTORY.length?'':'SIP管理中暂无分机';
    }catch(e){if($('managedSipFeedback'))$('managedSipFeedback').textContent=e.message;}
    finally{SIP_DIRECTORY_REQUEST=null;}
  })();
  return SIP_DIRECTORY_REQUEST;
}
async function configureManagedSip(event){
  event.preventDefault();var d=currentDev(),a=selectedSipAccount(),form=$('managedSipForm');
  if(!d||!a||!maintenanceAvailable(d,'configure_sip'))return;
  var selection=a.target+'|'+a.account_id;
  if(form.dataset.sipSelection!==selection){renderOps();return;}
  var params={source:'managed',target:a.target,account_id:a.account_id,extension:$('managedSipExtension').value};
  if(!params.extension)return;
  var button=form.querySelector('button[type=submit]');button.disabled=true;
  try{
    await fileApi('/api/elfremote/task',{device_id:d.id,type:'configure_sip',id:'sip-'+crypto.randomUUID(),params:params});
    if(selDev===d.id&&uiOf().sipSelection===selection&&$('managedSipFeedback'))$('managedSipFeedback').textContent='已发送，等待设备配置';
    loadDevices();
  }catch(e){if(selDev===d.id&&uiOf().sipSelection===selection&&$('managedSipFeedback'))$('managedSipFeedback').textContent=e.message;}
  finally{if(button.isConnected)button.disabled=false;}
}
function pageMultiSipAccount(dis,preset){
  var d=currentDev(),rows=sipAccountRows(d),a=selectedSipAccount();
  if(!a&&!preset)return '<p class="muted">设备尚未开放可配置的SIP线路或账号</p>';
  var available=!!a;a=a||{target:preset,account_id:''};
  var target=(d.sip_targets||[]).find(function(t){return t.target===a.target;})||{},saved=a.configuration||{},blocked=dis||(!available||!maintenanceAvailable(d,'configure_sip')?' disabled':'');
  var h=available?'<div class="ops-actions"><label for="sipAccountSlot">配置账号</label><select id="sipAccountSlot" class="inp" onchange="selectSipAccount(this.value)">'+rows.map(function(row,i){return '<option value="'+i+'"'+(row.target===a.target&&row.account_id===a.account_id?' selected':'')+'>'+esc(row.target_label+' · '+row.label)+'</option>';}).join('')+'</select></div>':'';
  if(available)h+='<div class="function-table"><table><thead><tr><th>应用 / 线路</th><th>配置结果</th><th>注册状态</th></tr></thead><tbody>'+rows.map(function(row){var r=row.registration,c=row.configuration_result;return '<tr><td>'+esc(row.target_label+' · '+row.label)+'</td><td>'+esc(sipConfigurationLabel(row))+(c?.detail?'<br><span class="muted">'+esc(c.detail)+'</span>':'')+(c?.at?'<br><span class="muted">'+esc(sydney(c.at))+'</span>':'')+'</td><td>'+esc(sipRegistrationLabel(d,row))+(r?'<br><span class="muted">'+esc(sydney(r.sampled_at))+(r.reason?' · '+esc(r.reason):'')+'</span>':'')+'</td></tr>';}).join('')+'</tbody></table></div>';
  var integrated=a.target==='nexui'||a.target==='quik';
  if(integrated){
    h+='<form id="managedSipForm" data-sip-selection="'+esc(a.target+'|'+a.account_id)+'" onsubmit="configureManagedSip(event)"><div class="ops-actions"><label for="managedSipExtension">SIP 管理账号</label><select id="managedSipExtension" class="inp" style="width:260px;max-width:100%" data-target="'+a.target+'" required'+blocked+'>'+managedSipOptions(a.target)+'</select><button type="submit" class="btn-green"'+blocked+'>一键配置</button><button type="button" class="btn-gray" onclick="loadManagedSipDirectory()">刷新分机</button></div><p id="managedSipFeedback" class="muted" role="status">'+(!available?'等待客户端支持':'')+'</p></form><details id="sipThirdParty" class="function-extra"'+(uiOf().sipThirdPartyOpen?' open':'')+' ontoggle="uiOf().sipThirdPartyOpen=this.open"><summary>第三方服务器</summary>';
    if(!SIP_DIRECTORY_ATTEMPTED){SIP_DIRECTORY_ATTEMPTED=true;setTimeout(loadManagedSipDirectory,0);}
  }
  h+='<form id="sipAccountForm" data-sip-selection="'+esc(a.target+'|'+a.account_id)+'" class="account-fields" onsubmit="configureMultiSipAccount(event)"><label>服务器<input id="sipAccountServer" class="inp" required autocomplete="off" value="'+esc(saved.server||'')+'"'+blocked+'></label><label>账号<input id="sipAccountUser" class="inp" required autocomplete="off" value="'+esc(saved.username||'')+'"'+blocked+'></label>';
  h+='<label>密码<input id="sipAccountPassword" class="inp" required type="password" autocomplete="new-password"'+blocked+'></label><label>连接方式<select id="sipAccountTransport" class="inp" onchange="document.getElementById(\'sipAccountPort\').value=this.value===\'tls\'?5061:5060"'+blocked+'>'+['tls','tcp','udp'].map(function(k){return '<option value="'+k+'"'+((saved.transport||'tls')===k?' selected':'')+'>'+k.toUpperCase()+'</option>';}).join('')+'</select></label><label>端口<input id="sipAccountPort" class="inp" type="number" min="1" max="65535" required value="'+(saved.port||5061)+'"'+blocked+'></label>';
  if(a.target!=='nexui'){
    h+='<details id="sipAdvanced" style="grid-column:1/-1"'+(uiOf().sipAdvancedOpen?' open':'')+' ontoggle="uiOf().sipAdvancedOpen=this.open"><summary>高级设置</summary><div class="account-fields">';
    if(target.auth_username_supported)h+='<label>认证账号<input id="sipAccountAuth" class="inp" placeholder="留空时使用账号" autocomplete="off" value="'+esc(saved.auth_username||'')+'"'+blocked+'></label>';
    h+='<label>认证域（可选）<input id="sipAccountRealm" class="inp" autocomplete="off" value="'+esc(saved.realm||'')+'"'+blocked+'></label></div></details>';
  }
  h+='<div class="ops-actions"><button type="submit" class="btn-green"'+blocked+'>保存配置</button><span id="sipAccountFeedback" role="status">'+esc(!available?'等待客户端支持':sipConfigurationLabel(a)+(a.configuration_result?.detail?' · '+a.configuration_result.detail:''))+'</span></div></form>';
  if(integrated)h+='</details>';
  return h;
}
async function configureMultiSipAccount(event){
  event.preventDefault();var d=currentDev(),a=selectedSipAccount();if(!a||!maintenanceAvailable(d,'configure_sip'))return;
  if($('sipAccountForm').dataset.sipSelection!==a.target+'|'+a.account_id){renderOps();if($('sipAccountFeedback'))$('sipAccountFeedback').textContent='账号列表已变化，请检查所选账号后重新填写';return;}
  var selection=a.target+'|'+a.account_id,params={target:a.target,account_id:a.account_id,server:$('sipAccountServer').value.trim(),username:$('sipAccountUser').value.trim(),password:$('sipAccountPassword').value,transport:$('sipAccountTransport').value,port:Number($('sipAccountPort').value)};
  if($('sipAccountAuth')&&$('sipAccountAuth').value.trim())params.auth_username=$('sipAccountAuth').value.trim();
  if($('sipAccountRealm')&&$('sipAccountRealm').value.trim())params.realm=$('sipAccountRealm').value.trim();
  var button=$('sipAccountForm').querySelector('button[type=submit]');button.disabled=true;
  try{await fileApi('/api/elfremote/task',{device_id:d.id,type:'configure_sip',id:'sip-'+crypto.randomUUID(),params:params});if(selDev===d.id&&uiOf().sipSelection===selection&&$('sipAccountPassword')){$('sipAccountPassword').value='';$('sipAccountFeedback').textContent='已发送，等待设备配置';}loadDevices();}
  catch(e){if(selDev===d.id&&uiOf().sipSelection===selection&&$('sipAccountFeedback'))$('sipAccountFeedback').textContent=e.message;}
  finally{params.password='';if(button.isConnected)button.disabled=false;}
}
function pageSipAccount(dis){
  var device=currentDev();if(device&&Array.isArray(device.sip_targets))return pageMultiSipAccount(dis);
  var d=currentDev(),saved=d&&d.sip_account||{},t=d&&d.task||{},blocked=dis||(!d||!d.managed_sip_account||!maintenanceAvailable(d,'configure_sip')?' disabled':'');
  var h='<form id="sipAccountForm" class="account-fields" onsubmit="configureSipAccount(event)"><label>服务器<input id="sipAccountServer" class="inp" required autocomplete="off" placeholder="sip.example.com" value="'+esc(saved.server||'')+'"'+blocked+'></label><label>账号<input id="sipAccountUser" class="inp" required autocomplete="off" value="'+esc(saved.username||'')+'"'+blocked+'></label><label>认证账号<input id="sipAccountAuth" class="inp" autocomplete="off" placeholder="留空时使用账号" value="'+esc(saved.auth_username||'')+'"'+blocked+'></label><label>密码<input id="sipAccountPassword" class="inp" required type="password" autocomplete="new-password"'+blocked+'></label><label>连接方式<select id="sipAccountTransport" class="inp" onchange="document.getElementById(\'sipAccountPort\').value=this.value===\'tls\'?5061:5060"'+blocked+'>'+['tls','tcp','udp'].map(function(k){return '<option value="'+k+'"'+((saved.transport||'tls')===k?' selected':'')+'>'+k.toUpperCase()+'</option>';}).join('')+'</select></label><label>端口<input id="sipAccountPort" class="inp" type="number" min="1" max="65535" required value="'+(saved.port||5061)+'"'+blocked+'></label><div class="ops-actions"><button type="submit" class="btn-green"'+blocked+'>保存并登录</button><span id="sipAccountFeedback" role="status">'+esc(t.type==='configure_sip'?(t.detail||t.label):saved.updated_at?'上次注册成功 · '+sydney(saved.updated_at):d&&!d.managed_sip_account?'请更新客户端后使用':'尚未配置账号')+'</span></div></form>';
  return h;
}
async function configureSipAccount(event){
  event.preventDefault();var d=currentDev();if(!d||!d.managed_sip_account)return;
  var params={server:$('sipAccountServer').value.trim(),username:$('sipAccountUser').value.trim(),password:$('sipAccountPassword').value,transport:$('sipAccountTransport').value,port:Number($('sipAccountPort').value)};
  var auth=$('sipAccountAuth').value.trim();if(auth)params.auth_username=auth;
  var button=$('sipAccountForm').querySelector('button[type=submit]');button.disabled=true;
  try{await fileApi('/api/elfremote/task',{device_id:d.id,type:'configure_sip',id:'sip-'+crypto.randomUUID(),params:params});if(selDev===d.id&&$('sipAccountPassword')){$('sipAccountPassword').value='';$('sipAccountFeedback').textContent='已发送，等待设备登录';}loadDevices();}
  catch(e){if(selDev===d.id&&$('sipAccountFeedback'))$('sipAccountFeedback').textContent=e.message;}
  finally{params.password='';if(button.isConnected)button.disabled=false;}
}

function pageAlarm(dis){
  var device = currentDev(), alarm = device && device.alarm;
  var labels = {idle:'未播放',starting:'正在启动',playing:'播放中',completed:'播放结束',stopped:'已停止',interrupted:'播放中断',failed:'播放失败'};
  var h = '<div class="ops-actions">';
  h += '<button class="btn-green" onclick="alarmPlay()"'+dis+'>播放警报声</button>';
  h += '<button class="btn-gray" onclick="enqueueRepair(\'stop_alarm\')"'+dis+'>停止警报</button>';
  h += "</div>";
  h += '<div class="function-table"><table style="margin-top:.55rem"><thead><tr><th>最近播放时间</th><th>最长时长</th><th>状态</th></tr></thead><tbody>';
  if(!alarm || !alarm.started_at_ms) h += '<tr><td colspan="3" class="muted">还没有播放记录</td></tr>';
  else h += '<tr><td>'+sydney(alarm.started_at_ms)+'</td><td>'+esc(alarm.duration_ms/1000)+' 秒</td><td>'+esc(labels[alarm.state]||'未知')+'</td></tr>';
  h += "</tbody></table></div>";
  return h;
}

function pageLost(dis){
  var d=currentDev(),m=d&&d.lost_mode||{},off=dis||(d&&d.managed_lost_safety_v1&&m.state!=='unknown'?'':' disabled'),exitOff=d&&d.managed_lost_v2?'':' disabled';
  var h='<div class="ops-actions" style="align-items:flex-end;gap:12px"><label style="flex:1;display:flex;flex-direction:column;gap:4px">锁屏显示文字<input id="lostMessage" class="inp" maxlength="300" value="'+esc(m.message||'')+'"'+off+'></label>';
  h+='<label style="display:flex;flex-direction:column;gap:4px">解锁密码<input id="lockPw" class="inp" type="password" autocomplete="new-password" placeholder="'+(m.enabled?'留空保留密码':'4至32位字母或数字')+'" style="width:180px"'+off+'></label><button class="btn-green" onclick="setLostMode(true)"'+off+'>启用</button><button class="btn-gray" onclick="setLostMode(false)"'+exitOff+'>退出</button></div>';
  h+='<div class="ops-actions" style="margin-top:16px"><label><input id="lostAutoWipe" type="checkbox" onchange="lostAutoChanged(this)"'+(m.auto_wipe_enabled?' checked':'')+(m.auto_wipe_enabled&&d&&d.managed_lost_safety_v1?'':off)+'> 自毁程序</label><span class="muted">失联或解除配对持续</span><input id="lostTimeout" class="inp" type="number" min="1" max="168" value="'+(m.timeout_hours||24)+'" style="width:70px"'+off+'><span class="muted">小时后清除；退出丢失模式同时关闭</span></div>';
  h+='<p class="muted">'+esc(({enabled:'已启用',disabled:'未启用',pending:'设置尚未完成',unknown:'设备状态暂未确认'})[m.state]||'设备状态暂未确认')+(m.deadline_at?' · '+esc(m.trigger==='manual'?'手动':m.trigger==='unpaired'?'未配对':'失联')+'清除时间 '+esc(new Date(m.deadline_at).toLocaleString('zh-CN',{timeZone:'Australia/Sydney',hour12:false})): '')+'</p>';
  h+='<p class="muted">'+(m.auto_wipe_enabled?'自毁程序：已开启':'自毁程序：'+(m.state==='unknown'?'未确认':'已关闭'))+'</p>';
  if(d&&d.safety_task)h+='<p class="muted">'+esc(d.safety_task.label)+' · '+esc(lostTaskText(d.safety_task.detail))+'</p>';
  if(m.wipe_state==='failed'||m.wipe_state==='started')h+='<p style="color:#fca5a5">'+(m.wipe_state==='failed'?'数据清除执行失败，尚未完成':'数据清除已开始，离线不代表已完成')+'</p>';
  if(d&&d.task&&['set_lost_mode','wipe_data'].includes(d.task.type))h+='<p class="muted">'+esc(d.task.label)+' · '+esc(lostTaskText(d.task.detail))+'</p>';
  h+='<div style="border-top:1px solid #334155;margin-top:20px;padding-top:16px"><p style="color:#fca5a5">永久清除设备内部数据，保留操作系统；此操作无法撤销。</p><div class="ops-actions"><input id="lostWipePhrase" class="inp" autocomplete="off" placeholder="请输入：擦除数据" oninput="lostWipeInput()" style="width:210px"><button id="lostWipeNext" class="btn-gray" style="background:#783c49;color:#fff" onclick="lostWipe()" disabled>继续</button></div></div>';
  return h;
}
function lostTaskText(detail){return ({'lost-enabled':'系统锁屏已启用','lost-disabled':'已退出并关闭自毁程序','lost-password-required':'请填写解锁密码','lost-current-password-required':'设备已有系统密码，请填写当前密码','lost-current-password-changed':'系统密码已改变，请先核对','lost-system-credential-unsupported':'该系统的锁屏接口尚未适配','lost-system-operation-failed':'系统操作失败，未确认完成','lost-boot-setting-unavailable':'无法读取开机解密设置，已停止操作','lost-boot-setting-failed':'开机解密设置未保存，已停止操作','lost-boot-password-required':'设备需要开机解密密码，暂不能远程更改锁屏','lost-system-lock-pending':'系统尚未确认锁屏，请检查状态','lost-system-password-failed':'系统未成功保存解锁密码'})[detail]||detail||'';}
function lostWipeInput(){var d=currentDev(),b=$('lostWipeNext');if(b)b.disabled=!d||!d.managed_wipe_v1||!d.managed_lost_safety_v1||d.lost_mode?.state==='unknown'||$('lostWipePhrase').value!=='擦除数据';}
async function lostWipe(){
  var d=currentDev(),id=d&&d.id,phrase=$('lostWipePhrase')&&$('lostWipePhrase').value;if(!id||phrase!=='擦除数据'||!d.managed_wipe_v1||!d.managed_lost_safety_v1||d.lost_mode?.state==='unknown')return;
  if(!confirm('第一次确认：清除 '+d.name+' 内部存储的账号、应用和文件，保留操作系统。是否继续？'))return;
  try{
    var p=await fileApi('/api/elfremote/task',{device_id:id,action:'prepare_wipe',phrase:phrase});
    if(!currentDev()||currentDev().id!==id)return;
    if(!confirm('第二次确认：立即永久清除 '+d.name+' 的内部数据，无法撤销。确定执行？'))return;
    if(!currentDev()||currentDev().id!==id)return;
    await fileApi('/api/elfremote/task',{device_id:id,id:crypto.randomUUID(),type:'wipe_data',params:{phrase:phrase,confirmation_id:p.confirmation.id}});loadDevices();
  }catch(e){alert(e.message||'清除请求未发送');}
}
function lostRecTable(u){
  var rows = u ? u.recs : [];
  var h = '<table><thead><tr><th>时间</th><th>类型</th><th>状态</th></tr></thead><tbody>';
  if(!rows.length) h += '<tr><td colspan="3" class="muted">暂无记录</td></tr>';
  else for(var i=0;i<rows.length;i++){
    var r=rows[i];
    h += "<tr><td>"+sydney(r.at)+"</td><td>"+esc(r.kind)+"</td><td>"+esc(r.state)+"</td></tr>";
  }
  h += "</tbody></table>";
  return h;
}
function lostPhotoTable(u){
  var rows = u ? u.photos : [];
  var h = '<table><thead><tr><th>时间</th><th>镜头</th><th>状态</th></tr></thead><tbody>';
  if(!rows.length) h += '<tr><td colspan="3" class="muted">暂无照片</td></tr>';
  else for(var i=0;i<rows.length;i++){
    var r=rows[i];
    h += "<tr><td>"+sydney(r.at)+"</td><td>"+esc(r.cam)+"</td><td>"+esc(r.state)+"</td></tr>";
  }
  h += "</tbody></table>";
  return h;
}

function needDev(){
  if(uiOf()) return true;
  return false;
}
function terminalBind(){
  var term=$("taskOut");
  if(term) term.scrollTop=term.scrollHeight;
  var inp=$("shellCmd");
  if(!inp) return;
  inp.onkeydown=function(e){
    if(e.key==="Enter"){ e.preventDefault(); shellSend(); return; }
    if(e.key==="ArrowUp"){ e.preventDefault(); shellHist(-1); return; }
    if(e.key==="ArrowDown"){ e.preventDefault(); shellHist(1); }
  };
}
function shellPrint(kind, text){
  var u=uiOf(); if(!u) return;
  if(!u.shell.lines) u.shell.lines=[];
  u.shell.lines.push({ k: kind, t: String(text) });
  if(u.shell.lines.length>500) u.shell.lines=u.shell.lines.slice(-400);
}
function shellLog(kind, text){
  shellPrint(kind, "["+sydney(nowIso())+"] "+text);
}
function shellNorm(raw){
  return String(raw||'').trim();
}
function shellHist(dir){
  var u=uiOf(); if(!u) return;
  var inp=$("shellCmd"); if(!inp) return;
  var h=u.shell.hist||[];
  if(!h.length) return;
  var i = u.shell.histI==null ? h.length : u.shell.histI;
  i += dir;
  if(i<0) i=0;
  if(i>h.length) i=h.length;
  u.shell.histI = i;
  inp.value = i<h.length ? h[i] : "";
}
var ADB_VIEW=null;
function disposeAdbView(){if(ADB_VIEW){ADB_VIEW.resize.disconnect();ADB_VIEW.terminal.dispose();ADB_VIEW=null;}}
function bindAdbView(){
  var u=uiOf(),el=$('adbTerm');if(!u||!el)return;
  if(typeof Terminal==='undefined'||typeof FitAddon==='undefined'){el.textContent='终端资源未加载，请刷新页面';return;}
  var adb=u.adb,terminal=new Terminal({fontSize:12,fontFamily:'Consolas, monospace',cursorBlink:true,disableStdin:!adb.connected,scrollback:1000,theme:{background:'#101827',foreground:'#d4deec'}}),fit=new FitAddon.FitAddon();
  el.textContent='';terminal.loadAddon(fit);terminal.open(el);fit.fit();
  terminal.write(adb.output||((adb.connecting?'ADB 连接中':'ADB 未连接')+'\r\n'));
  terminal.onData(function(data){adbWrite(u,data);});
  var resize=new ResizeObserver(function(){fit.fit();if(adb.connected&&adb.socket&&adb.socket.readyState===1)adb.socket.send(JSON.stringify({type:'resize',rows:terminal.rows,columns:terminal.cols}));});resize.observe(el);
  ADB_VIEW={u:u,terminal:terminal,resize:resize};
  var input=$('adbCmd');if(input)input.onkeydown=function(e){if(e.key==='Enter'){e.preventDefault();adbSendCommand();}if(e.ctrlKey&&e.key.toLowerCase()==='c'){e.preventDefault();adbWrite(u,'\x03');}};
}
function adbWrite(u,text){
  if(!u.adb.connected||!u.adb.socket||u.adb.socket.readyState!==1)return;
  var bytes=new TextEncoder().encode(text);if(bytes.length>65536)return;
  var encoded='';for(var i=0;i<bytes.length;i++)encoded+=String.fromCharCode(bytes[i]);
  u.adb.socket.send(JSON.stringify({type:'input',data:btoa(encoded)}));
}
function adbSendCommand(){var u=uiOf(),input=$('adbCmd');if(u&&input){adbWrite(u,input.value+'\n');input.value='';}}
function adbInterrupt(){var u=uiOf();if(u)adbWrite(u,'\x03');}
function adbAppend(u,text){u.adb.output=((u.adb.output||'')+text).slice(-131072);if(ADB_VIEW&&ADB_VIEW.u===u)ADB_VIEW.terminal.write(text);}
async function adbConnect(){
  var u=uiOf(),d=currentDev();if(!u||!d||u.adb.connecting||!d.managed_adb_session||d.enabled===false)return;
  var a=u.adb;a.connecting=true;a.connected=false;a.output='ADB 连接中\r\n';renderOps();
  try{
    var response=await fetch('/api/elfremote/adb/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({device_id:d.id})}),result=await response.json();
    if(!response.ok||!result.ok)throw Error(result.msg||'ADB连接失败');
    var socket=new WebSocket(location.origin.replace(/^http/,'ws')+'/api/elfremote/adb/browser?session_id='+encodeURIComponent(result.session_id)),decoder=new TextDecoder();a.socket=socket;
    socket.onmessage=function(event){if(a.socket!==socket)return;try{
      var message=JSON.parse(event.data);
      if(message.type==='ready'){a.connected=true;a.connecting=false;adbAppend(u,'ADB 已连接\r\n');if(selDev===d.id)renderOps();}
      else if(message.type==='output'){var raw=atob(message.data),bytes=Uint8Array.from(raw,function(c){return c.charCodeAt(0);});adbAppend(u,decoder.decode(bytes,{stream:true}));}
      else if(message.type==='closed'){a.connected=false;a.connecting=false;adbAppend(u,'\r\n'+(message.message||'ADB 已断开')+(message.exit!=null?' · 退出码 '+message.exit:'')+'\r\n');socket.close();if(selDev===d.id)renderOps();}
    }catch{socket.close();}};
    socket.onclose=function(){if(a.socket!==socket)return;var was=a.connected||a.connecting;a.connected=false;a.connecting=false;if(was)adbAppend(u,'\r\nADB连接已关闭\r\n');if(selDev===d.id)renderOps();};
    socket.onerror=function(){socket.close();};
  }catch(error){a.connected=false;a.connecting=false;adbAppend(u,error.message+'\r\n');if(selDev===d.id)renderOps();}
}
function adbDisconnect(){var u=uiOf();if(!u)return;var a=u.adb;if(a.socket)a.socket.close();a.connected=false;a.connecting=false;adbAppend(u,'\r\nADB 已断开\r\n');renderOps();}
async function shellSend(){
  var u=uiOf(),d=currentDev(),inp=$('shellCmd');if(!u||!d)return;
  var raw=shellNorm(inp?inp.value:'');if(!raw||d.enabled===false||u.shell.pending||!d.managed_exec_tasks)return;
  var id=crypto.randomUUID();u.shell.pending=id;u.shell.cancelRequested=false;
  u.shell.hist=u.shell.hist||[];u.shell.hist.push(raw);u.shell.histI=u.shell.hist.length;
  if(inp)inp.value='';shellPrint('in',raw);renderOps();
  try {
    var r=await fetch('/api/elfremote/task',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({device_id:d.id,type:'root_exec',id:id,params:{command:raw,timeout:30,cwd:'/'}})});
    var x=await r.json();if(!r.ok||!x.ok)throw Error(x.msg||'命令下发失败');
    u.shell.lines.push({k:'sys',t:'命令已发送，等待设备返回结果。'});
    watchCommand(d.id,id,u);
  } catch(e) {u.shell.lines.push({k:'sys',t:e.message+'；如网络中断，可刷新查询任务记录。'});u.shell.pending=null;}
  if(selDev===d.id)renderOps();
}
function commandResult(u,t){
  if(u.shell.lastResult===t.id)return;
  u.shell.lastResult=t.id;var result=t.result||{};
  if(result.text)u.shell.lines.push({k:'out',t:result.text});
  u.shell.lines.push({k:'sys',t:(t.detail||t.label)+(result.exit_code!=null?' · 退出码 '+result.exit_code:'')+(result.elapsed_ms!=null?' · '+(result.elapsed_ms/1000).toFixed(1)+'s':'')});
  if(u.shell.lines.length>500)u.shell.lines=u.shell.lines.slice(-400);
}
// 查询退避仅影响结果显示，不取消任务，也不重发设备命令。
async function readWatchedTask(owner,deviceId,id){
  var key=deviceId+'/'+id,p=owner.resultPoll;
  if(!p||p.key!==key)p=owner.resultPoll={key:key,failures:0,next:0};
  if(document.hidden||p.next>Date.now()||p.busy)return null;
  p.busy=true;
  try{
    var r=await fetch('/api/elfremote/tasks?'+new URLSearchParams({device_id:deviceId,task_id:id}));
    if(!r.ok){var e=Error(r.status===404?'任务记录已不存在':'结果暂不可用，稍后自动重试');e.stopPolling=r.status===401||r.status===403||r.status===404;e.retryAfter=Math.min(900,Math.max(0,Number(r.headers.get('Retry-After'))||0))*1000;throw e;}
    var x=await r.json();if(!x.ok||!x.task){var missing=Error('任务记录已不存在');missing.stopPolling=true;throw missing;}
    p.failures=0;p.next=0;return x;
  }catch(e){p.failures++;p.next=Date.now()+Math.max(e.retryAfter||0,Math.min(300000,15000*Math.pow(2,Math.min(5,p.failures-1))));throw e;}
  finally{p.busy=false;}
}
async function watchCommand(deviceId,id,u){
  if(u.shell.pending!==id)return;
  try {
    var x=await readWatchedTask(u.shell,deviceId,id),t=x&&x.task;
    if(t&&['success','failed','rejected','expired'].includes(t.state)){
      commandResult(u,t);
      u.shell.pending=null;u.shell.cancelRequested=false;
      if(selDev===deviceId)renderOps();return;
    }
  } catch(e) {if(e.stopPolling){u.shell.pending=null;u.shell.lines.push({k:'sys',t:e.message});if(selDev===deviceId)renderOps();return;}}
  if(u.shell.pending===id)setTimeout(function(){watchCommand(deviceId,id,u);},2000);
}
async function cancelCommand(){
  var d=currentDev(),u=uiOf();if(!d||!u||!u.shell.pending)return;
  u.shell.cancelRequested=true;renderOps();
  try {
    var r=await fetch('/api/elfremote/task',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({device_id:d.id,action:'cancel',task_id:u.shell.pending})});
    var x=await r.json();if(!r.ok||!x.ok)throw Error(x.msg||'停止请求失败');
  } catch(e){u.shell.cancelRequested=false;u.shell.lines.push({k:'sys',t:e.message});if(selDev===d.id)renderOps();}
}
function assignUpdate(versionCode){
  var d = currentDev();
  if(!d || !d.can_update || RELEASE_DEVICE!==d.id || updateBusy(d.update||{})) return;
  var vc = parseInt(versionCode===undefined ? ($("updVc") && $("updVc").value) : versionCode, 10);
  if(RELEASE_STATE!=='ready' || !RELEASES.some(function(r){return r.versionCode===vc && !r.expired;})){ alert('请选择已发布版本'); return; }
  fetch("/api/elfremote/assign",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({device_id:d.id,channel:d.update_channel,versionCode:vc,request_id:crypto.randomUUID()})})
    .then(function(r){ return r.json(); })
    .then(function(x){
      if(!x.ok){ alert(x.msg || "下发失败"); return; }
      loadDevices();
    });
}
function enqueueRepair(type,params){
  var d = currentDev();
  if(!d) return;
  var run=null;
  if(MAINTENANCE_CAPS[type]){
    if(!maintenanceAvailable(d,type))return Promise.resolve();
    run={pending:true};MAINTENANCE_RUN[d.id]=run;renderOps();
  }
  return fetch("/api/elfremote/task",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({device_id:d.id,type:type,params:params||{}})})
    .then(function(r){return r.json();})
    .then(function(x){
      if(!x.ok){if(run)run.error=true;alert(x.msg||'下发失败');return;}
      if(run)run.id=x.task && x.task.id;
      loadDevices();
      return x;
    }).catch(function(){if(run)run.error=true;alert('下发失败，请检查连接');})
    .finally(function(){if(run){run.pending=false;if(selDev===d.id)renderOps();}});
}
function wifiScan(){
  enqueueRepair('scan_wifi');
}
function wifiPickIndex(index){
  var d=currentDev(), networks=d && d.wifi_scan && d.wifi_scan.networks;
  if(networks && networks[index]) wifiPick(networks[index].ssid);
}
function wifiPick(ssid){
  var u=uiOf(); if(!u) return;
  u.wifiSel=ssid;
  renderOps();
}
function wifiConnect(){
  if(currentDev()&&currentDev().managed_system_settings)return runSystemSettings({group:'wifi',action:'set',key:'connect',value:{ssid:$('wifiSsid').value.trim(),password:$('wifiPw').value}});
  var ssid=$('wifiSsid').value,password=$('wifiPw').value;
  return enqueueRepair('connect_wifi',{ssid:ssid,password:password});
}
function unavailableAction(name){alert(name+'尚未接通，未发送到设备');}
function contactRefresh(){return enqueueRepair('contacts_read');}
function contactAdd(){
  return enqueueRepair('contact_add',{name:$('cName').value,phone:$('cPhone').value});
}
function contactEdit(i){
  var d=currentDev(),c=d && d.contacts && d.contacts.items[i];if(!c) return;
  var name=prompt('姓名',c.name);if(name==null) return;
  var phone=prompt('号码',c.phone);if(phone==null) return;
  return enqueueRepair('contact_update',{id:c.id,name:name,phone:phone});
}
function contactDel(i){
  var d=currentDev(),c=d && d.contacts && d.contacts.items[i];if(c) return enqueueRepair('contact_delete',{id:c.id});
}
function configTaskStatus(d){
  var t=d && d.task;if(!t || !/^(connect_wifi|contacts_read|contact_add|contact_update|contact_delete)$/.test(t.type)) return '';
  var labels={'wifi-connected':'连接成功','wifi-timeout-rolled-back':'连接超时，已恢复原网络','wifi-connect-failed-rolled-back':'连接失败，已恢复原网络','wifi-interrupted-rolled-back':'操作中断，已恢复原网络','wifi-saved-use-empty-password':'该网络已保存，请将密码留空以复用原配置','wifi-disabled':'设备 Wi-Fi 已关闭','wifi-no-fallback-connection':'缺少可回退的原 Wi-Fi 连接','contacts-complete':'已完成并读取最新通信录'};
  var detail=(t.detail||'').replace(/^[A-Za-z]+Exception: /,'');
  return '<p class="muted">'+esc(t.type_label)+' · '+esc(t.label)+' · '+esc(labels[detail]||detail)+'</p>';
}
function locNow(){
  return enqueueRepair('locate_now');
}
function alarmPlay(){
  enqueueRepair('play_alarm');
}
function lostRec(){
  unavailableAction('远程录音');
}
async function lostAutoChanged(box){
  var d=currentDev(),m=d&&d.lost_mode||{};if(!d)return;
  if(box.checked){if(!m.auto_wipe_enabled)alert('选择时限后点击“启用”保存；当前尚未开启自毁程序。');return;}
  if(!m.auto_wipe_enabled)return;
  box.checked=true;box.disabled=true;
  await enqueueRepair('set_lost_mode',{version:2,enabled:!!m.enabled,cancel_auto:true,auto_wipe_enabled:false,timeout_hours:m.timeout_hours||24});
  if(currentDev()&&currentDev().id===d.id)renderOps();
}
function setLostMode(enabled){
  var d=currentDev(),m=d&&d.lost_mode||{};if(!d)return;
  var auto=enabled&&$('lostAutoWipe').checked,hours=Number($('lostTimeout').value)||24;
  if(enabled&&(!d.managed_lost_safety_v1||m.state==='unknown'||!m.revision))return;
  if(auto&&!confirm('启用 '+d.name+' 的自毁程序：失联或解除配对持续 '+hours+' 小时后清除设备数据。输入正确系统密码可在设备上取消。确定启用？'))return;
  return enqueueRepair('set_lost_mode',{version:2,enabled:enabled,message:enabled?$('lostMessage').value:'',password:enabled?$('lockPw').value:'',auto_wipe_enabled:auto,timeout_hours:hours,...(enabled?{expected_revision:m.revision}:{})});
}
function lostVideo(cam){
  unavailableAction('远程录像');
}
function lostPhoto(cam){
  unavailableAction('远程拍照');
}
function lostTalk(){
  unavailableAction('远程对讲');
}
function lostLock(){
  unavailableAction('远程锁机');
}
function lostUnlock(){
  unavailableAction('远程解锁');
}

function stubAct(){
  if(!deviceReady()) return;
}

function openEdit(){
  var d = currentDev(); if(!d) return;
  $("edName").value = d.name;
  fillModelSelect($("edModel"), d.model_id);
  $("edErr").innerText = "";
  show("editWrap");
}
function closeEdit(){ hide("editWrap"); }
function saveEdit(){
  var d = currentDev(); if(!d) return;
  var name = $("edName").value.trim();
  var model_id = $("edModel").value;
  fetch("/api/devices/update",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:d.id,name:name,model_id:model_id})})
  .then(function(r){return r.json();}).then(function(x){
    if(!x.ok){ $("edErr").innerText=x.msg||"保存失败"; return; }
    closeEdit(); loadDevices();
  });
}
function setEnabled(on){
  var d = currentDev(); if(!d) return;
  fetch("/api/devices/update",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:d.id,enabled:on})})
  .then(function(r){return r.json();}).then(function(){ loadDevices(); });
}
function delDev(){
  var d = currentDev(); if(!d) return;
  if(!confirm("确定解除配对「"+d.name+"」？在线时仍可管理，离线后不再保留列表项。")) return;
  fetch("/api/devices/delete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:d.id,confirm:true})})
  .then(function(r){return r.json();}).then(function(x){
    if(!x.ok){ alert(x.msg||"删除失败"); return; }
    selDev=""; loadDevices();
  });
}

function fillModelSelect(sel, val){
  var h = "";
  for(var i=0;i<MODELS.length;i++){
    var m = MODELS[i];
    h += '<option value="'+esc(m.id)+'"'+(m.id===val?" selected":"")+">"+esc(m.name)+"</option>";
  }
  sel.innerHTML = h || '<option value="">请先添加型号</option>';
}

function pairCodeOk(){
  return /^\d{6}$/.test(String($("pairCode") ? $("pairCode").value : "").replace(/\s+/g, ""));
}
function syncAddButtons(){
  var ok = pairCodeOk();
  ["btnPair", "btnSave"].forEach(function(id){
    var b = $(id);
    if(!b) return;
    b.disabled = !ok;
  });
}
function openAdd(){
  fillModelSelect($("dModel"), MODELS[0] ? MODELS[0].id : "");
  $("dName").value=""; $("pairCode").value="";
  if($("pairErr")) $("pairErr").innerText="";
  show("addWrap");
  var inp = $("pairCode");
  if(inp && !inp._pairBound){
    inp._pairBound = true;
    inp.addEventListener("input", syncAddButtons);
    inp.addEventListener("keyup", syncAddButtons);
    inp.addEventListener("paste", function(){ setTimeout(syncAddButtons, 0); });
  }
  syncAddButtons();
}
function closeAdd(){ hide("addWrap"); }

function openPairSelected(){
  var d = currentDev();
  if(!d || d.paired!==false) return;
  openAdd();
  $("dName").value = d.name || "";
  fillModelSelect($("dModel"), d.model_id);
  $("pairCode").focus();
}

function saveManual(){ submitPair(); }
function submitPair(){
  if(!pairCodeOk()){
    $("pairErr").innerText = "请填写六位数字配对码";
    syncAddButtons();
    return;
  }
  var body = {
    code: $("pairCode").value.trim(),
    name: $("dName").value.trim(),
    model_id: $("dModel").value || "mdl_d22"
  };
  fetch("/api/devices/pair",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})
  .then(function(r){return r.json();}).then(function(d){
    if(!d.ok){ $("pairErr").innerText=d.msg||"配对失败"; return; }
    closeAdd();
    selDev = d.device && d.device.id;
    loadDevices();
  }).catch(function(){ $("pairErr").innerText="请求失败"; });
}

function addModel(){
  var name = $("mName").value.trim();
  var note = $("mNote").value.trim();
  fetch("/api/device-models",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:name,note:note,power_type:$("mPower").value})})
  .then(function(r){return r.json();}).then(function(d){
    if(!d.ok){ alert(d.msg||"失败"); return; }
    MODELS = d.models; renderOps();
  });
}
function editModel(id){
  var cur=null; for(var i=0;i<MODELS.length;i++) if(MODELS[i].id===id) cur=MODELS[i];
  if(!cur) return;
  var name = prompt("型号名称", cur.name); if(name==null) return;
  name = name.trim(); if(!name) return;
  fetch("/api/device-models",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:id,name:name,note:cur.note||"",icon:cur.icon||""})})
  .then(function(r){return r.json();}).then(function(d){
    if(!d.ok){ alert(d.msg||"失败"); return; }
    MODELS = d.models; renderOps();
  });
}
function delModel(id){
  if(!confirm("删除该型号？")) return;
  fetch("/api/device-models",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"delete",id:id})})
  .then(function(r){return r.json();}).then(function(d){
    if(!d.ok){ alert(d.msg||"失败"); return; }
    MODELS = d.models; renderOps();
  });
}

var lastPollAt=0,devicePollFailures=0,devicePollRetryAt=0,deviceRefreshAt=0;
function deviceRetryDelay(){return devicePollFailures?Math.min(300000,15000*Math.pow(2,Math.min(devicePollFailures-1,5))):0;}
var panelEvents=typeof window!=='undefined'&&window.createPanelEvents?window.createPanelEvents({
  active:function(){return adminSession.authenticated&&!document.hidden;},
  allowed:function(){return Date.now()>=Math.max(devicePollRetryAt,lastPollAt+deviceRetryDelay());},
  refresh:function(){return deviceLoad?deviceLoad.then(loadDevices):loadDevices();}
}):null;
checkAuth();
setTimeout(function(){ if(typeof L!=="undefined") renderMap(); }, 200);
function devicePollDelay(){
  if(devicePollRetryAt>Date.now())return Math.max(0,devicePollRetryAt-lastPollAt);
  if(devicePollFailures)return deviceRetryDelay();
  if(panelEvents&&panelEvents.connected())return Math.max(0,deviceRefreshAt-lastPollAt);
  var active=DEV.some(function(d){return (updateBusy(d.update||{})&&(!d.update.expires_at||d.update.expires_at>Date.now())&&(!d.update.updated_at||Date.now()-Date.parse(d.update.updated_at)<120000)) || (d.task&&['pending','claimed','running'].includes(d.task.state)&&(!d.task.expires_at||d.task.expires_at>Date.now()));});
  return active?3000:30000;
}
setInterval(function(){
  if(panelEvents)panelEvents.tick();
  if(adminSession.authenticated && !document.hidden && Date.now()-lastPollAt>=devicePollDelay()){
    lastPollAt=Date.now();loadDevices();
  }
}, 2000);
if(typeof document!=='undefined'&&document.addEventListener)document.addEventListener('visibilitychange',function(){
  if(panelEvents)panelEvents.tick();
  if(!document.hidden&&adminSession.authenticated&&Date.now()-lastPollAt>=devicePollDelay())loadDevices();
});

if(typeof document!=="undefined"&&document.addEventListener)document.addEventListener("keydown",function(e){if(e.key==="Escape"&&MEDIA_HISTORY.device)closeMediaHistory();});
