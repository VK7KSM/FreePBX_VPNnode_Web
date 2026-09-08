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
var LIST_FILTER = {text:"",model:"",state:""};

var FN_ITEMS = [
  ["adb", "远程Shell", '<rect x="3" y="4" width="18" height="14" rx="2"></rect><path d="M8 20h8M12 18v2"></path><path d="M7 10h.01M10 10h6"></path>'],
  ["update", "更新客户端", '<path d="M21 12a9 9 0 1 1-3-6.7"></path><polyline points="21 3 21 9 15 9"></polyline>'],
  ["wifi", "配置Wi-Fi", '<path d="M5 12.5a9 9 0 0 1 14 0"></path><path d="M8.5 16a5 5 0 0 1 7 0"></path><circle cx="12" cy="20" r="1"></circle>'],
  ["contacts", "通信录", '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle>'],
  ["locate", "立即定位", '<path d="M12 21s7-6 7-11a7 7 0 1 0-14 0c0 5 7 11 7 11z"></path><circle cx="12" cy="10" r="2.5"></circle>'],
  ["alarm", "播放警报", '<path d="M11 5a1 1 0 0 1 2 0v1.1A7 7 0 0 1 19 13v4l1.5 2H3.5L5 17v-4a7 7 0 0 1 6-6.9V5z"></path><path d="M9 21h6"></path>'],
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
function uiOf(){
  var d = currentDev();
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
      adb: { connected: false, lines: [], hist: [], histI: 0 },
      talk: false,
      live: ""
    };
  }
  var adb = UI[d.id].adb;
  if(!adb || !Array.isArray(adb.lines)){
    UI[d.id].adb = { connected: false, lines: [], hist: [], histI: 0 };
  } else {
    if(!Array.isArray(adb.hist)) adb.hist = [];
    if(adb.histI == null) adb.histI = adb.hist.length;
  }
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
function logout(){ return adminSession.logout(); }

function loadDevices(){
  if(deviceLoad) return deviceLoad;
  function read(url){return fetch(url).then(function(r){if(!r.ok) throw new Error('刷新失败（'+r.status+'）');return r.json();});}
  deviceLoad = Promise.all([
    read("/api/devices"), read("/api/device-models")
  ]).then(function(arr){
    if(!Array.isArray(arr[0].devices) || !Array.isArray(arr[1].models)) throw new Error('刷新返回无效');
    var previousId=selDev;
    var savedInputs=Array.from($("devOps").querySelectorAll('input[id],textarea[id],select[id]')).filter(function(el){return el.type!=='file';}).map(function(el){return {id:el.id,value:el.value,checked:el.checked};});
    var trafficOpen=!!$("devOps").querySelector('details[open]');
    if(arr[0].devices) DEV = arr[0].devices;
    UNPAIRED = arr[0].unpaired || [];
    if(arr[1].models) MODELS = arr[1].models;
    if(!currentDev() && DEV.length) selDev = DEV[0].id;
    renderList();
    renderMap();
    var editing = $("devOps").contains(document.activeElement) && document.activeElement.matches("input,textarea,select,[contenteditable=true]");
    if(!editing){
      renderOps();
      if(previousId===selDev){
        savedInputs.forEach(function(saved){var el=$(saved.id);if(el){el.value=saved.value;if(typeof saved.checked==='boolean') el.checked=saved.checked;}});
        var details=$("devOps").querySelector('details');if(details) details.open=trafficOpen;
      }
    }
    renderFilters();
    if($("deviceLoadError")) $("deviceLoadError").textContent='';
    return true;
  }).catch(function(error){
    if($("deviceLoadError")) $("deviceLoadError").textContent=error.message||'刷新失败，保留上次数据';
    return false;
  }).finally(function(){deviceLoad=null;});
  return deviceLoad;
}

function matchesDevice(d){
  return (!LIST_FILTER.text || String(d.name||'').toLowerCase().includes(LIST_FILTER.text.toLowerCase())) &&
    (!LIST_FILTER.model || d.model_id===LIST_FILTER.model) &&
    (!LIST_FILTER.state || (LIST_FILTER.state==='unpaired' ? d.paired===false : LIST_FILTER.state==='disabled' ? d.enabled===false : LIST_FILTER.state==='online' ? d.online && d.enabled!==false : !d.online && d.enabled!==false));
}
function setListFilter(field,value){LIST_FILTER[field]=value;renderList();}
function renderFilters(){
  var box=$("deviceModelFilter");if(!box || document.activeElement===box) return;
  var h='<option value="">全部型号</option>';
  MODELS.forEach(function(m){h+='<option value="'+esc(m.id)+'">'+esc(m.name)+'</option>';});
  box.innerHTML=h;box.value=LIST_FILTER.model;
}

function deviceListStatus(d){
  if(d.enabled===false) return "已停用";
  var update=d.update;
  if(update && update.state && !["success","recovered","rejected"].includes(update.state)) return update.label || "升级中";
  var task=d.task;
  if(task && ["pending","claimed","running"].includes(task.state)) return (task.type_label || "任务")+" · "+(task.label || "执行中");
  return STATUS[d.id] || (d.contact_state==="report_overdue" ? "报告超时" : "等待上报信息");
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
    if(!matchesDevice(d)) continue;
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

async function requestDeviceStatus(id){
  if(["拉取中","等待设备领取","等待完整上报"].includes(STATUS[id])) return false;
  var device=DEV.find(function(d){return d.id===id;});
  STATUS_SEEN[id]=device && device.last_seen;
  STATUS[id]="拉取中"; renderList();
  var started=performance.now();
  REQUEST_TIMING[id]={};
  try {
    var result = await (await fetch("/api/devices/request-status", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({device_id:id})})).json();
    if(!result.ok) throw new Error(result.msg || "请求失败");
    var requestId = result.request && result.request.request_id;
    STATUS[id]="等待设备领取"; renderList();
    for(var attempt=0;attempt<150;attempt++){
      await new Promise(function(resolve){setTimeout(resolve,2000);});
      var state = await (await fetch("/api/devices/status-request?device_id="+encodeURIComponent(id))).json();
      if(!state.ok) throw new Error(state.msg || "查询失败");
      if(state.request && state.request.request_id===requestId && state.request.received_at && REQUEST_TIMING[id].receivedMs==null){
        REQUEST_TIMING[id].receivedMs=Math.round(performance.now()-started);
        STATUS[id]="等待完整上报"; renderList();
      }
      if(state.request && state.request.request_id===requestId && state.request.state==="completed") {
        REQUEST_TIMING[id].completedMs=Math.round(performance.now()-started);
        STATUS[id]=""; await loadDevices(); return true;
      }
      if(state.request && state.request.state==="expired") break;
    }
    STATUS[id]="拉取超时";
  } catch(error) { STATUS[id]="拉取失败"; }
  renderList();
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
  clearHistoryMarker();
  selDev = id;
  renderList();
  renderOps();
  flyTo(id);
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
function battHtml(pct){
  var p = pct==null || !isFinite(Number(pct)) ? -1 : Math.max(0, Math.min(100, Math.round(Number(pct))));
  var fill = p<0 ? 0 : p;
  var col = p<0 ? "#64748b" : (p<=20 ? "#f87171" : (p<=50 ? "#fbbf24" : "#4ade80"));
  var title = p<0 ? "电量未知" : ("电量 "+p+"%");
  return '<span class="mbatt" title="'+title+'"><span class="mbatt-b"><span class="mbatt-l" style="width:'+fill+'%;background:'+col+'"></span></span><span class="mbatt-n"></span></span>';
}
function pinHtml(d, selected){
  var on = d.online && d.enabled!==false;
  var col = deviceColor(d.id, on);
  var seen = sydney(d.last_seen);
  return '<div class="dpin'+(selected?" pin-on":"")+'">'+
    '<div class="dpin-dot" style="background:'+col+';box-shadow:0 0 0 1px #0f172a,0 0 0 2px '+col+'"></div>'+
    '<div class="dpin-card">'+
      '<div class="dpin-name"><span>'+esc(d.name||"")+'</span> '+battHtml(d.battery)+'</div>'+
      '<div class="dpin-time">'+esc(seen)+'</div>'+
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

function kv(k,v){ return '<div class="kv"><div class="k">'+k+'</div><div class="v">'+esc(v)+'</div></div>'; }

function pickFn(id){
  selFn = id;
  renderOps();
}

function onFnClick(ev){
  var t = ev.target;
  while(t && t !== ev.currentTarget && !t.getAttribute("data-fn")) t = t.parentNode;
  if(!t || !t.getAttribute("data-fn")) return;
  pickFn(t.getAttribute("data-fn"));
}

function renderOps(){
  var box = $("devOps");
  var d = currentDev();
  var dis = d ? "" : " disabled";
  var bat = !d || d.battery==null ? "—" : (d.battery+"%");
  var net = !d ? "—" : (d.network==="wifi" ? "Wi-Fi" : (d.network==="cellular" ? "移动数据" : "未知"));
  var src = d && d.loc ? locLabel(d.loc.source) : "—";
  if(d && d.loc && d.loc.source==="gps" && d.loc.lat!=null && d.loc.lng!=null && isFinite(Number(d.loc.lat)) && isFinite(Number(d.loc.lng))) {
    src = "GPS · " + Number(d.loc.lat).toFixed(6) + " · " + Number(d.loc.lng).toFixed(6);
  } else if(d && d.loc) {
    src = ({ip:"IP",wifi:"Wi-Fi",cell:"Cell",network:"Wi-Fi / Cell"})[d.loc.source] || locLabel(d.loc.source);
    if(Number(d.loc.acc_m)>0) src += " · " + Math.round(Number(d.loc.acc_m)) + "m";
  }
  var shell = !d ? "—" : ((uiOf() && uiOf().adb && uiOf().adb.connected) ? "会话已开" : "未接入");
  var h = "";
  h += '<div class="ops-head"><div class="ops-head-left"><h3>功能设置</h3>';
  if(d) h += '<span class="muted">'+esc(d.name)+" · "+esc(d.model_name||modelName(d.model_id))+"</span>";
  else h += '<span class="muted">请先从左侧选择设备，或点「添加设备」</span>';
  h += '</div><div class="ops-head-actions">';
  h += '<button class="device-action action-edit" onclick="openEdit()"'+dis+'>编辑</button>';
  if(d && d.enabled===false) h += '<button class="device-action action-enable" onclick="setEnabled(true)">启用</button>';
  else h += '<button class="device-action action-disable" onclick="setEnabled(false)"'+dis+'>停用</button>';
  if(d && d.paired===false) h += '<button class="device-action action-pair" onclick="openPairSelected()">立即配对</button>';
  else h += '<button class="device-action action-unpair" onclick="delDev()"'+dis+'>解除配对</button>';
  h += "</div></div>";
  h += '<div class="ops-grid">';
  h += kv("电量", bat);
  h += kv("网络", net);
  h += kv("IP", d && d.ip ? d.ip : "—");
  h += kv("定位", src);
  h += kv("系统", d && d.os_version ? d.os_version : "—");
  h += kv("elfRemote", d ? managerLabel(d) : "—");
  h += kv("最后上报", d ? sydney(d.last_seen) : "—");
  h += kv("远程Shell", shell);
  h += "</div>";
  if(d) h += trafficHtml(d.traffic);
  if(d && REQUEST_TIMING[d.id]){
    var timing=REQUEST_TIMING[d.id];
    h+='<p class="muted" style="font-size:12px">本次拉取 · 领取回执 '+(timing.receivedMs==null?'待确认':(timing.receivedMs/1000).toFixed(1)+'s')+' · 完整报告 '+(timing.completedMs==null?'等待中':(timing.completedMs/1000).toFixed(1)+'s')+'</p>';
  }
  h += '<div class="fn-menu" onclick="onFnClick(event)">';
  for(var i=0;i<FN_ITEMS.length;i++){
    var it = FN_ITEMS[i];
    h += '<button type="button" class="fn-btn'+(selFn===it[0]?" on":"")+'" data-fn="'+it[0]+'">';
    h += '<svg class="fn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'+it[2]+"</svg>";
    h += "<span>"+it[1]+"</span></button>";
  }
  h += "</div>";
  h += '<div class="fn-page">'+fnPageHtml()+"</div>";
  box.innerHTML = h;
  adbBind();
}

function fnPageHtml(){
  var dis = disAttr();
  if(selFn==="update") return pageUpdate(dis);
  if(selFn==="wifi") return pageWifi(dis);
  if(selFn==="contacts") return pageContacts(dis);
  if(selFn==="locate") return pageLocate(dis);
  if(selFn==="alarm") return pageAlarm(dis);
  if(selFn==="lost") return pageLost(dis);
  if(selFn==="model") return pageModel();
  return pageAdb(dis);
}

function pageAdb(dis){
  var d = currentDev();
  var t = d && d.task ? d.task : {};
  var r = t.result || {};
  var u = uiOf();
  var on = !!(u && u.adb.connected);
  var st = t.label || t.state || "";
  var h = '<div class="ops-actions" style="margin:.55rem 0">';
  h += '<button class="btn-green" onclick="enqueueRepair(\'pull_logs\')"'+dis+'>拉取日志</button>';
  h += '<button class="btn-green" onclick="enqueueRepair(\'heal_network\')"'+dis+'>强制自愈</button>';
  h += '<button class="btn-green" onclick="enqueueRepair(\'reboot\')"'+dis+'>受控重启</button>';
  h += '<button class="btn-green" onclick="enqueueRepair(\'restart_adbd\')"'+dis+'>重启本机adbd</button>';
  if(st) h += '<span class="muted" style="margin-left:.55rem">'+esc(st)+"</span>";
  h += "</div>";
  h += '<pre class="adb-term" id="taskOut" style="margin-bottom:.55rem;min-height:120px;max-height:180px">'+esc(r.text||"")+"</pre>";
  if(d && r.artifact) h+='<a class="btn-gray" href="/api/elfremote/task-log?device_id='+encodeURIComponent(d.id)+'&amp;task_id='+encodeURIComponent(t.id)+'">下载日志 · '+Math.ceil(r.artifact.bytes/1024)+' KiB'+(r.artifact.truncated?' · 已截断':'')+'</a>';
  h += '<div class="ops-actions" style="margin-bottom:.55rem">';
  h += '<button class="btn-green" onclick="adbConnect()"'+dis+'>连接 ADB</button>';
  h += '<button class="btn-gray" onclick="adbDisconnect()"'+dis+'>断开</button>';
  h += '<span class="muted">'+(on ? "ADB 会话已开" : "ADB 未接入，指令仍写入日志")+"</span>";
  h += "</div>";
  h += '<div class="adb-box">';
  h += '<pre class="adb-term" id="adbTerm">';
  var lines = (u && u.adb.lines) ? u.adb.lines : [];
  if(!lines.length) h += '<span class="adb-sys">这里记录设备管理发出的每条指令。ADB 未接入时也可以输入，结果会标明尚未送到设备。</span>';
  else {
    for(var i=0;i<lines.length;i++){
      h += '<span class="adb-'+esc(lines[i].k)+'">'+esc(lines[i].t)+"</span>\n";
    }
  }
  h += "</pre>";
  h += '<div class="adb-row">';
  h += '<span class="adb-prompt">shell&gt;</span>';
  h += '<input id="adbCmd" class="inp adb-cmd" autocomplete="off" spellcheck="false" placeholder="pm list packages"';
  h += dis ? " disabled>" : ">";
  h += '<button class="btn-green" onclick="adbSend()"'+dis+'>发送</button>';
  h += "</div></div>";
  return h;
}

function pageUpdate(dis){
  var d = currentDev();
  var u = d && d.update ? d.update : {};
  var ver = d && d.app_version ? d.app_version : (d ? managerLabel(d) : "未接入");
  var h = '<div class="ops-grid">';
  h += kv("当前版本", ver);
  h += kv("目标版本", u.target || "无");
  h += kv("阶段", u.label || u.state || "无");
  h += kv("说明", u.detail || "");
  h += "</div>";
  h += '<p class="muted" style="margin-top:.7rem">只显示设备回传的真实阶段。安装成功不等于健康确认。</p>';
  h += '<div class="ops-actions" style="margin-top:.45rem">';
  h += '<input id="updVc" class="inp" placeholder="已发布 versionCode" style="max-width:180px"'+dis+'>';
  h += '<button class="btn-green" onclick="assignUpdate()"'+dis+'>下发该版本</button>';
  h += "</div>";
  return h;
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
  return h;
}

function pageContacts(dis){
  var u = uiOf();
  var list = u ? u.contacts : [];
  var h = '<div class="ops-actions">';
  h += '<input id="cName" class="inp" placeholder="姓名" style="max-width:160px"'+dis+'>';
  h += '<input id="cPhone" class="inp" placeholder="号码" style="max-width:160px"'+dis+'>';
  h += '<button class="btn-green" onclick="contactAdd()"'+dis+'>添加</button>';
  h += '<button class="btn-gray" onclick="contactRefresh()"'+dis+'>刷新</button>';
  h += "</div>";
  h += '<table style="margin-top:.55rem"><thead><tr><th>姓名</th><th>号码</th><th></th></tr></thead><tbody>';
  if(!list.length) h += '<tr><td colspan="3" class="muted">暂无联系人</td></tr>';
  else for(var i=0;i<list.length;i++){
    var c=list[i];
    h += "<tr><td>"+esc(c.name)+"</td><td>"+esc(c.phone)+"</td><td>";
    h += '<button class="btn-gray" onclick="contactEdit('+i+')"'+dis+'>改</button> ';
    h += '<button class="btn-gray" style="color:#f87171" onclick="contactDel('+i+')"'+dis+'>删</button>';
    h += "</td></tr>";
  }
  h += "</tbody></table>";
  return h;
}

function pageLocate(dis){
  var state = historyState();
  var rows = state ? state.rows : [];
  var h = '<div class="ops-actions">';
  h += '<button class="btn-green" onclick="locNow()"'+dis+'>立即更新位置</button>';
  h += '<button class="btn-gray" onclick="clearHistoryMarker();flyTo(selDev)">实时位置</button>';
  h += "</div>";
  if(!state) return h;
  h += '<div class="ops-actions" style="margin-top:8px"><label>开始 <input class="inp" type="datetime-local" aria-label="开始时间" value="'+esc(state.from)+'" onchange="historyState().from=this.value"></label>';
  h += '<label>结束 <input class="inp" type="datetime-local" aria-label="结束时间" value="'+esc(state.to)+'" onchange="historyState().to=this.value"></label>';
  h += '<button class="btn-gray" onclick="queryHistory(false)"'+(state.loading?' disabled':'')+'>查询历史</button></div>';
  h += '<p class="muted">筛选时间：浏览器本地时间；记录时间：悉尼</p>';
  if(state.error) h += '<p role="alert">'+esc(state.error)+'</p>';
  h += '<div style="overflow:auto;max-height:360px"><table style="margin-top:.55rem;min-width:540px"><thead><tr><th>上报 / 采样 / 接收时间</th><th>位置</th><th>公网 IP</th></tr></thead><tbody>';
  if(!rows.length) h += '<tr><td colspan="3" class="muted">'+(state.loading?'查询中':state.loaded?'该时间范围没有记录':'尚未查询历史')+'</td></tr>';
  else for(var i=0;i<rows.length;i++){
    var r=rows[i], loc=r.location;
    var label=loc ? locLabel(loc.source)+' · '+Number(loc.lat).toFixed(6)+' · '+Number(loc.lng).toFixed(6)+(loc.acc_m!=null?' · '+loc.acc_m+'m':'') : '无坐标 · '+(r.location_reason||r.location_status||'未提供');
    h += '<tr><td>'+sydney(r.reported_at)+'<br><span class="muted">'+sydney(r.sample_at)+'<br>'+sydney(r.received_at)+'</span></td><td>';
    h += loc ? '<button class="btn-gray" onclick="showHistoryRecord('+i+')">'+esc(label)+'</button>' : esc(label);
    h += '</td><td>'+esc(r.ip||'—')+'</td></tr>';
  }
  h += "</tbody></table></div>";
  if(state.cursor) h += '<button class="btn-gray" onclick="queryHistory(true)"'+(state.loading?' disabled':'')+'>更多记录</button>';
  return h;
}

function localDateInput(date){
  return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);
}
function historyState(){
  var u=uiOf(); if(!u) return null;
  if(!u.history) u.history={from:localDateInput(new Date(Date.now()-86400000)),to:localDateInput(new Date()),rows:[],cursor:null,loading:false,loaded:false,error:'',sequence:0};
  return u.history;
}
async function queryHistory(more){
  var id=selDev, state=historyState(); if(!state || state.loading) return;
  var from=new Date(state.from), to=new Date(state.to);
  if(!state.from || !state.to || !isFinite(from.getTime()) || !isFinite(to.getTime()) || from>to){state.error='请选择有效的起止时间';renderOps();return;}
  var range=from.toISOString()+'|'+to.toISOString();
  if(more && state.range!==range) more=false;
  var params=new URLSearchParams({device_id:id,from:from.toISOString(),to:to.toISOString(),limit:'100'});
  if(more && state.cursor) params.set('cursor',state.cursor);
  if(!more){state.rows=[];state.cursor=null;clearHistoryMarker();}
  state.loading=true;state.error='';state.range=range;
  var sequence=++state.sequence;renderOps();
  try{
    var response=await fetch('/api/devices/history?'+params.toString()), data=await response.json();
    if(!response.ok || !data.ok) throw new Error(data.msg||'历史查询失败');
    if(state.sequence!==sequence) return;
    state.rows=more?state.rows.concat(data.records):data.records;
    state.cursor=data.next_cursor;state.loaded=true;
  }catch(error){state.error=error.message||'历史查询失败';}
  finally{state.loading=false;if(selDev===id) renderOps();}
}
function clearHistoryMarker(){
  if(historyMarker && map) map.removeLayer(historyMarker);
  historyMarker=null;
}
function showHistoryRecord(index){
  var state=historyState(), record=state && state.rows[index];
  if(!record || !record.location || !map) return;
  clearHistoryMarker();
  var loc=record.location;
  historyMarker=L.marker([loc.lat,loc.lng],{zIndexOffset:1000}).addTo(map)
    .bindPopup('历史位置 · '+esc(sydney(record.timeline_at))).openPopup();
  map.panTo([loc.lat,loc.lng]);
}

function trafficHtml(traffic){
  if(!traffic || !traffic.available) return '<p class="muted">应用流量：暂无有效计量'+(traffic && traffic.reason?'（'+esc(traffic.reason)+'）':'')+'</p>';
  function bytes(value){return (value/1024).toFixed(1)+' KiB';}
  var h='<details><summary>应用流量 · 接收 '+bytes(traffic.rx_bytes)+' · 发送 '+bytes(traffic.tx_bytes)+'</summary>';
  h+='<p class="muted">'+sydney(traffic.started_at_ms)+' 至 '+sydney(traffic.sampled_at_ms)+' · 覆盖 '+(traffic.covered_ms/3600000).toFixed(2)+' 小时 · 缺口 '+traffic.gaps+'</p>';
  h+='<p class="muted">elfRemote 应用累计计量，不含其他应用和运营商计费差异</p>';
  Object.keys(traffic.interfaces||{}).forEach(function(name){var v=traffic.interfaces[name];h+='<div>'+esc(name)+' · 接收 '+bytes(v.rx_bytes)+' · 发送 '+bytes(v.tx_bytes)+'</div>';});
  return h+'</details>';
}

function pageAlarm(dis){
  var device = currentDev(), alarm = device && device.alarm;
  var labels = {idle:'未播放',starting:'正在启动',playing:'播放中',completed:'播放结束',stopped:'已停止',interrupted:'播放中断',failed:'播放失败'};
  var h = '<div class="ops-actions">';
  h += '<button class="btn-green" onclick="alarmPlay()"'+dis+'>播放警报声</button>';
  h += '<button class="btn-gray" onclick="enqueueRepair(\'stop_alarm\')"'+dis+'>停止警报</button>';
  h += "</div>";
  h += '<table style="margin-top:.55rem"><thead><tr><th>最近播放时间</th><th>时长</th><th>状态</th></tr></thead><tbody>';
  if(!alarm || !alarm.started_at_ms) h += '<tr><td colspan="3" class="muted">还没有播放记录</td></tr>';
  else h += '<tr><td>'+sydney(alarm.started_at_ms)+'</td><td>'+esc(alarm.duration_ms/1000)+' 秒</td><td>'+esc(labels[alarm.state]||'未知')+'</td></tr>';
  h += "</tbody></table>";
  return h;
}

function pageLost(dis){
  var u = uiOf();
  var live = u && u.live ? u.live : "未开始";
  var h = '<div class="lost-bar">';
  h += '<button class="btn-gray" onclick="lostRec()"'+dis+'>远程录音</button>';
  h += '<button class="btn-gray" onclick="lostVideo(\'front\')"'+dis+'>前置录像</button>';
  h += '<button class="btn-gray" onclick="lostVideo(\'back\')"'+dis+'>后置录像</button>';
  h += '<button class="btn-gray" onclick="lostPhoto(\'front\')"'+dis+'>前置拍照</button>';
  h += '<button class="btn-gray" onclick="lostPhoto(\'back\')"'+dis+'>后置拍照</button>';
  h += '<button class="btn-gray" onclick="lostTalk()"'+dis+'>远程对讲</button>';
  h += "</div>";
  h += '<div class="fn-live">'+esc(live)+"</div>";
  h += '<div class="ops-actions" style="margin-top:.7rem">';
  h += '<input id="lockPw" class="inp" type="password" placeholder="解锁密码" style="max-width:180px"'+dis+'>';
  h += '<button class="btn-green" onclick="lostLock()"'+dis+'>远程锁机</button>';
  h += '<button class="btn-gray" onclick="lostUnlock()"'+dis+'>远程解锁</button>';
  h += "</div>";
  h += '<p class="ops-sec-title" style="margin-top:.85rem">录音 / 录像</p>';
  h += lostRecTable(u);
  h += '<p class="ops-sec-title" style="margin-top:.85rem">照片</p>';
  h += lostPhotoTable(u);
  return h;
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
function adbBind(){
  var term=$("adbTerm");
  if(term) term.scrollTop=term.scrollHeight;
  var inp=$("adbCmd");
  if(!inp) return;
  inp.onkeydown=function(e){
    if(e.key==="Enter"){ e.preventDefault(); adbSend(); return; }
    if(e.key==="ArrowUp"){ e.preventDefault(); adbHist(-1); return; }
    if(e.key==="ArrowDown"){ e.preventDefault(); adbHist(1); }
  };
}
function adbPrint(kind, text){
  var u=uiOf(); if(!u) return;
  if(!u.adb.lines) u.adb.lines=[];
  u.adb.lines.push({ k: kind, t: String(text) });
  if(u.adb.lines.length>500) u.adb.lines=u.adb.lines.slice(-400);
}
function shellLog(kind, text){
  adbPrint(kind, "["+sydney(nowIso())+"] "+text);
}
function adbNorm(raw){
  var s = String(raw||"").replace(/^\s+/, "");
  s = s.replace(/^adb(\.exe)?(\s+|$)/i, "");
  return s.replace(/^\s+|\s+$/g, "");
}
function adbHist(dir){
  var u=uiOf(); if(!u) return;
  var inp=$("adbCmd"); if(!inp) return;
  var h=u.adb.hist||[];
  if(!h.length) return;
  var i = u.adb.histI==null ? h.length : u.adb.histI;
  i += dir;
  if(i<0) i=0;
  if(i>h.length) i=h.length;
  u.adb.histI = i;
  inp.value = i<h.length ? h[i] : "";
}
function adbConnect(){
  var u=uiOf(); if(!u) return;
  if(u.adb.connected){
    adbPrint("sys", "已经连接。");
    renderOps();
    return;
  }
  u.adb.connected=true;
  shellLog("sys", "已打开网页侧 ADB 会话标记。互联网 ADB 隧道尚未接入，命令仍不会到达设备。");
  renderOps();
}
function adbDisconnect(){
  var u=uiOf(); if(!u) return;
  if(!u.adb.connected){
    adbPrint("sys", "当前未连接。");
    renderOps();
    return;
  }
  u.adb.connected=false;
  adbPrint("sys", "已断开。");
  renderOps();
}
function adbSend(){
  var u=uiOf(); if(!u) return;
  var inp=$("adbCmd");
  var raw=adbNorm(inp ? inp.value : "");
  if(!raw) return;
  if(inp) inp.value="";
  if(!u.adb.hist) u.adb.hist=[];
  if(!u.adb.hist.length || u.adb.hist[u.adb.hist.length-1]!==raw) u.adb.hist.push(raw);
  u.adb.histI = u.adb.hist.length;
  adbPrint("in", (u.adb.connected ? "adb " : "shell ")+raw);
  if(!u.adb.connected){
    adbPrint("sys", "已记下。ADB 未接入，命令未送到设备。");
  } else {
    adbPrint("out", "远程配置客户端未接入，命令未送达设备。");
  }
  renderOps();
}
function assignUpdate(){
  var d = currentDev();
  if(!d) return;
  var vc = parseInt($("updVc") && $("updVc").value, 10);
  if(!vc){ alert("请填写已发布的 versionCode"); return; }
  fetch("/api/elfremote/assign",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({device_id:d.id,versionCode:vc})})
    .then(function(r){ return r.json(); })
    .then(function(x){
      if(!x.ok){ alert(x.msg || "下发失败"); return; }
      loadDevices();
      requestDeviceStatus(d.id);
    });
}
function enqueueRepair(type){
  var d = currentDev();
  if(!d) return;
  fetch("/api/elfremote/task",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({device_id:d.id,type:type})})
    .then(function(r){ return r.json(); })
    .then(function(x){
      if(!x.ok){ alert(x.msg || "下发失败"); return; }
      loadDevices();
      requestDeviceStatus(d.id);
    });
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
  unavailableAction('Wi-Fi 配置');
}
function unavailableAction(name){alert(name+'尚未接通，未发送到设备');}
function contactRefresh(){ unavailableAction('读取通信录'); }
function contactAdd(){
  unavailableAction('添加通信录');
}
function contactEdit(i){
  unavailableAction('修改通信录');
}
function contactDel(i){
  unavailableAction('删除通信录');
}
async function locNow(){
  var id=selDev;if(!currentDev()) return;
  var ok=await requestDeviceStatus(id);
  if(selDev!==id) return;
  if(ok){historyState().to=localDateInput(new Date(Date.now()+60000));await queryHistory(false);}
  else{historyState().error=STATUS[id]||'已有拉取请求正在执行';renderOps();}
}
function alarmPlay(){
  enqueueRepair('play_alarm');
}
function lostRec(){
  unavailableAction('远程录音');
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
  fetch("/api/device-models",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:name,note:note})})
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

checkAuth();
setTimeout(function(){ if(typeof L!=="undefined") renderMap(); }, 200);
var lastPollAt=0;
setInterval(function(){
  if(adminSession.authenticated && Date.now()-lastPollAt >= (document.hidden?60000:10000)){
    lastPollAt=Date.now();loadDevices();
  }
}, 10000);
