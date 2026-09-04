var DEV = [];
var MODELS = [];
var selDev = "";
var selFn = "adb";
var map = null;
var markers = {};
var circles = {};

var FN_ITEMS = [
  ["adb", "远程ADB", '<rect x="3" y="4" width="18" height="14" rx="2"></rect><path d="M8 20h8M12 18v2"></path><path d="M7 10h.01M10 10h6"></path>'],
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
  if(src==="ip") return "IP 大致区域";
  return "未知";
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
  return !!(d && d.online && d.enabled !== false);
}
function disAttr(){ return deviceReady() ? "" : " disabled"; }
function waitHint(){
  if(!currentDev()) return "请先在左侧选择设备。管理程序未接入时，页内操作不可用。";
  if(!deviceReady()) return "该设备尚未接入管理程序，页内操作不可用。";
  return "";
}

function checkAuth(){
  if(localStorage.getItem("_pt")){ hide("loginWrap"); loadDevices(); }
  else show("loginWrap");
}
function doLogin(){
  fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:$("lu").value,password:$("lp").value})})
  .then(function(r){return r.json();}).then(function(d){
    if(d.ok){ localStorage.setItem("_pt","1"); hide("loginWrap"); loadDevices(); }
    else { $("lerr").style.display="block"; $("lerr").innerText=d.msg||"登录失败"; }
  }).catch(function(){ $("lerr").style.display="block"; $("lerr").innerText="登录失败"; });
}
function logout(){ localStorage.removeItem("_pt"); location.href="/"; }

function loadDevices(){
  Promise.all([
    fetch("/api/devices").then(function(r){return r.json();}),
    fetch("/api/device-models").then(function(r){return r.json();})
  ]).then(function(arr){
    if(arr[0].devices) DEV = arr[0].devices;
    if(arr[1].models) MODELS = arr[1].models;
    renderList();
    renderMap();
    renderOps();
  }).catch(function(){});
}

function renderList(){
  var box = $("devList");
  if(!DEV.length){
    box.innerHTML = '<p class="muted">还没有设备</p>';
    return;
  }
  var h = "";
  for(var i=0;i<DEV.length;i++){
    var d = DEV[i];
    var on = d.online && d.enabled!==false;
    var cls = "dev-row" + (d.id===selDev ? " sel" : "");
    var upd = d.update && d.update.state ? '<span class="tag">升级中</span>' : "";
    h += '<div class="'+cls+'" onclick="selectDev(\''+d.id+'\')">';
    h += '<span class="dot '+(on?"dot-on":"dot-off")+'"></span>';
    h += '<span class="dev-name">'+esc(d.name)+'</span>'+upd;
    h += '</div>';
  }
  box.innerHTML = h;
}

function esc(s){
  return String(s||"").replace(/[&<>"']/g, function(c){
    return ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" })[c];
  });
}

function selectDev(id){
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
}

function markerHtml(d, selected){
  var on = d.online && d.enabled!==false;
  var gps = d.loc && d.loc.source==="gps";
  var color = !d.enabled ? "#64748b" : (on ? (gps ? "#22c55e" : "#38bdf8") : "#94a3b8");
  var fill = gps ? color : "transparent";
  var ring = selected ? "0 0 0 3px #93c5fd" : "0 0 0 2px rgba(15,23,42,.8)";
  return '<div style="width:16px;height:16px;border-radius:50%;background:'+fill+';border:3px solid '+color+';box-shadow:'+ring+'"></div>';
}

function renderMap(){
  initMap();
  if(!map) return;
  setTimeout(function(){ map.invalidateSize(); }, 50);
  Object.keys(markers).forEach(function(k){ map.removeLayer(markers[k]); });
  Object.keys(circles).forEach(function(k){ map.removeLayer(circles[k]); });
  markers = {}; circles = {};
  var bounds = [];
  for(var i=0;i<DEV.length;i++){
    var d = DEV[i];
    if(!d.loc || !isFinite(d.loc.lat) || !isFinite(d.loc.lng)) continue;
    var ll = [d.loc.lat, d.loc.lng];
    bounds.push(ll);
    var acc = Number(d.loc.acc_m) || (d.loc.source==="gps" ? 40 : 25000);
    var gps = d.loc.source==="gps";
    var col = d.online && d.enabled!==false ? (gps ? "#22c55e" : "#38bdf8") : "#94a3b8";
    circles[d.id] = L.circle(ll, {
      radius: acc,
      color: col,
      weight: gps ? 1 : 1,
      fillColor: col,
      fillOpacity: gps ? 0.12 : 0.15
    }).addTo(map);
    var ic = L.divIcon({ className: "", html: markerHtml(d, d.id===selDev), iconSize: [16,16], iconAnchor: [8,8] });
    (function(id){
      markers[id] = L.marker(ll, { icon: ic }).addTo(map).on("click", function(){ selectDev(id); });
    })(d.id);
    var bat = d.battery==null ? "—" : (d.battery+"%");
    markers[d.id].bindPopup(
      "<b>"+esc(d.name)+"</b><br>电量 "+bat+"<br>IP "+esc(d.ip||"—")+"<br>"+locLabel(d.loc.source)+"<br>"+sydney(d.loc.at)
    );
  }
  if(bounds.length) map.fitBounds(bounds, { padding: [40,40], maxZoom: 14 });
}

function flyTo(id){
  var d = null;
  for(var i=0;i<DEV.length;i++) if(DEV[i].id===id) d = DEV[i];
  if(!d || !d.loc || !map) { renderMap(); return; }
  renderMap();
  map.flyTo([d.loc.lat, d.loc.lng], d.loc.source==="gps" ? 14 : 10, { duration: 0.6 });
  if(markers[id]) markers[id].openPopup();
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
  var online = !d ? "—" : (d.online ? "在线" : (d.enabled===false ? "已停用" : "未接入"));
  var h = "";
  h += '<div class="ops-head"><div class="ops-head-left"><h3>功能设置</h3>';
  if(d) h += '<span class="muted">'+esc(d.name)+" · "+esc(d.model_name||modelName(d.model_id))+"</span>";
  else h += '<span class="muted">请先从左侧选择设备，或点「添加设备」</span>';
  h += '</div><div class="ops-head-actions">';
  h += '<button class="btn-gray" onclick="openEdit()"'+dis+'>编辑</button>';
  if(d && d.enabled===false) h += '<button class="btn-gray" onclick="setEnabled(true)">启用</button>';
  else h += '<button class="btn-gray" onclick="setEnabled(false)"'+dis+'>停用</button>';
  h += '<button class="btn-gray" style="color:#f87171" onclick="delDev()"'+dis+'>解除配对</button>';
  h += "</div></div>";
  h += '<div class="ops-grid">';
  h += kv("在线", online);
  h += kv("电量", bat);
  h += kv("网络", net);
  h += kv("IP", d && d.ip ? d.ip : "—");
  h += kv("定位", src);
  h += kv("系统", d && d.os_version ? d.os_version : "—");
  h += kv("管理程序", d && d.app_version ? d.app_version : (d ? "未接入" : "—"));
  h += kv("最后上报", d ? sydney(d.last_seen) : "—");
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
  box.innerHTML = h;
}

function fnPageHtml(){
  var d = currentDev();
  var name = d ? d.name : "未选择设备";
  var ready = deviceReady();
  var dis = disAttr();
  var hint = waitHint();
  if(selFn==="update") return pageUpdate(d, name, dis, hint);
  if(selFn==="wifi") return pageWifi(d, name, dis, hint);
  if(selFn==="contacts") return pageContacts(d, name, dis, hint);
  if(selFn==="locate") return pageLocate(d, name, dis, hint);
  if(selFn==="alarm") return pageAlarm(d, name, dis, hint);
  if(selFn==="lost") return pageLost(d, name, dis, hint);
  if(selFn==="model") return pageModel();
  return pageAdb(d, name, dis, hint, ready);
}

function pageHead(title, desc, hint){
  var h = "<h4>"+title+"</h4>";
  h += '<p class="muted">'+desc+"</p>";
  if(hint) h += '<p class="fn-wait">'+hint+"</p>";
  return h;
}

function pageAdb(d, name, dis, hint, ready){
  var h = pageHead("远程 ADB", "在管理员电脑 127.0.0.1 上开临时端口，用标准 adb.exe 连接。设备不开放公网 ADB。", hint);
  h += '<div class="ops-grid">';
  h += kv("目标设备", name);
  h += kv("会话状态", ready ? "未开始" : "不可用");
  h += kv("本机端口", "—");
  h += kv("过期时间", "—");
  h += "</div>";
  h += '<div class="ops-actions" style="margin-top:.7rem">';
  h += '<button class="btn-green" onclick="stubAct()"'+dis+'>申请会话</button>';
  h += '<button class="btn-gray" onclick="stubAct()"'+dis+'>关闭会话</button>';
  h += "</div>";
  h += '<p class="ops-sec-title" style="margin-top:.85rem">本机 ADB 公钥</p>';
  h += '<textarea class="inp" id="adbPub" placeholder="粘贴这台电脑的 adbkey.pub，不含私钥"'+dis+"></textarea>";
  h += '<div class="ops-actions" style="margin-top:.5rem">';
  h += '<button class="btn-gray" onclick="stubAct()"'+dis+'>授权这台电脑</button>';
  h += "</div>";
  h += '<p class="muted" style="margin-top:.55rem">电脑需运行 remote-adb-bridge。授权后执行 adb connect 127.0.0.1:端口。</p>';
  return h;
}

function pageUpdate(d, name, dis, hint){
  var ver = d && d.app_version ? d.app_version : "未接入";
  var st = d && d.update && d.update.state ? d.update.state : "空闲";
  var h = pageHead("更新客户端", "把已签名的管理程序推到选中设备。失败会保留上一版并可回滚。", hint);
  h += '<div class="ops-grid">';
  h += kv("目标设备", name);
  h += kv("当前版本", ver);
  h += kv("发布版本", "—");
  h += kv("更新状态", st);
  h += "</div>";
  h += '<div class="ops-actions" style="margin-top:.7rem">';
  h += '<button class="btn-green" onclick="stubAct()"'+dis+'>推送到此设备</button>';
  h += '<button class="btn-gray" onclick="stubAct()"'+dis+'>取消更新</button>';
  h += '<button class="btn-gray" onclick="stubAct()"'+dis+'>回滚上一版</button>';
  h += "</div>";
  h += '<p class="muted" style="margin-top:.55rem">制品校验、健康检查和自动回滚要等更新助手上线后才能真正下发。</p>';
  return h;
}

function pageWifi(d, name, dis, hint){
  var h = pageHead("配置 Wi-Fi", "查询、添加、修改、删除设备上的 Wi-Fi。新配置失效时自动回滚。", hint);
  h += '<div class="ops-grid">';
  h += kv("目标设备", name);
  h += kv("当前连接", d && d.network==="wifi" ? "Wi-Fi" : "—");
  h += "</div>";
  h += '<p class="muted" style="margin:.7rem 0 .4rem">已保存网络</p>';
  h += '<p class="muted">还没有从设备读到网络列表。</p>';
  h += '<div class="ops-actions" style="margin-top:.7rem">';
  h += '<input class="inp" placeholder="SSID" style="max-width:160px"'+dis+'>';
  h += '<input class="inp" placeholder="密码" type="password" style="max-width:160px"'+dis+'>';
  h += '<button class="btn-green" onclick="stubAct()"'+dis+'>添加并下发</button>';
  h += '<button class="btn-gray" onclick="stubAct()"'+dis+'>删除</button>';
  h += '<button class="btn-gray" onclick="stubAct()"'+dis+'>失效回滚</button>';
  h += "</div>";
  return h;
}

function pageContacts(d, name, dis, hint){
  var h = pageHead("通信录", "查询、导入、修改和删除设备通信录。", hint);
  h += kv("目标设备", name);
  h += '<p class="muted" style="margin:.7rem 0">还没有从设备读到联系人。</p>';
  h += '<div class="ops-actions">';
  h += '<button class="btn-gray" onclick="stubAct()"'+dis+'>刷新</button>';
  h += '<button class="btn-green" onclick="stubAct()"'+dis+'>添加</button>';
  h += '<button class="btn-gray" onclick="stubAct()"'+dis+'>导入</button>';
  h += '<button class="btn-gray" onclick="stubAct()"'+dis+'>删除</button>';
  h += "</div>";
  return h;
}

function pageLocate(d, name, dis, hint){
  var loc = d && d.loc ? d.loc : null;
  var coord = loc ? (Number(loc.lat).toFixed(5)+", "+Number(loc.lng).toFixed(5)) : "—";
  var h = pageHead("立即定位", "请求设备立刻更新位置。室内可能没有有效坐标，可改用播放警报寻找。", hint);
  h += '<div class="ops-grid">';
  h += kv("目标设备", name);
  h += kv("来源", loc ? locLabel(loc.source) : "—");
  h += kv("精度", loc && loc.acc_m ? (loc.acc_m+" 米") : "—");
  h += kv("时间", loc ? sydney(loc.at) : "—");
  h += kv("坐标", coord);
  h += "</div>";
  h += '<div class="ops-actions" style="margin-top:.7rem">';
  h += '<button class="btn-green" onclick="stubAct()"'+dis+'>立即更新位置</button>';
  h += "</div>";
  return h;
}

function pageAlarm(d, name, dis, hint){
  var h = pageHead("播放警报", "以最大允许音量循环播放管理程序内置报警声，便于近处寻找设备。", hint);
  h += '<div class="ops-grid">';
  h += kv("目标设备", name);
  h += kv("播放状态", "未播放");
  h += "</div>";
  h += '<div class="ops-actions" style="margin-top:.7rem">';
  h += '<button class="btn-green" onclick="stubAct()"'+dis+'>开始播放</button>';
  h += '<button class="btn-gray" onclick="stubAct()"'+dis+'>停止</button>';
  h += "</div>";
  return h;
}

function pageLost(d, name, dis, hint){
  var h = pageHead("丢失模式", "定位、播放警报，并全屏显示失主文字。重启或换网后仍继续，直到管理员退出。", hint);
  h += '<div class="ops-grid">';
  h += kv("目标设备", name);
  h += kv("丢失模式", "未开启");
  h += "</div>";
  h += '<p class="ops-sec-title" style="margin-top:.85rem">失主文字</p>';
  h += '<textarea class="inp" placeholder="例如：此设备已丢失，请联系……"'+dis+"></textarea>";
  h += '<div class="ops-actions" style="margin-top:.5rem">';
  h += '<button class="btn-green" onclick="stubAct()"'+dis+'>进入丢失模式</button>';
  h += '<button class="btn-gray" onclick="stubAct()"'+dis+'>退出丢失模式</button>';
  h += "</div>";
  return h;
}

function pageModel(){
  var h = "<h4>添加型号</h4>";
  h += '<p class="muted">型号目录给登记设备用，不依赖设备是否在线。</p>';
  h += '<div id="modelTable">'+modelTableHtml()+"</div>";
  h += '<div class="ops-actions" style="margin-top:.8rem">';
  h += '<input id="mName" class="inp" placeholder="新型号名称" style="max-width:180px">';
  h += '<input id="mNote" class="inp" placeholder="备注" style="max-width:180px">';
  h += '<button class="btn-green" onclick="addModel()">添加</button>';
  h += "</div>";
  return h;
}

function modelTableHtml(){
  var h = "<table><thead><tr><th>名称</th><th>备注</th><th></th></tr></thead><tbody>";
  for(var i=0;i<MODELS.length;i++){
    var m = MODELS[i];
    h += "<tr><td>"+esc(m.name)+'</td><td class="muted">'+esc(m.note||"")+"</td>";
    h += '<td><button class="btn-gray" onclick="editModel(\''+m.id+'\')">改</button> ';
    h += '<button class="btn-gray" style="color:#f87171" onclick="delModel(\''+m.id+'\')">删</button></td></tr>';
  }
  h += "</tbody></table>";
  return h;
}

function stubAct(){
  if(!deviceReady()) return;
  alert("等待设备管理程序接入后才能下发。");
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
  if(!confirm("确定解除配对「"+d.name+"」？此台将从列表和地图消失。")) return;
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

function openAdd(){
  fillModelSelect($("dModel"), MODELS[0] ? MODELS[0].id : "");
  $("dName").value=""; $("dIp").value=""; $("pairCode").value="";
  $("addErr").innerText=""; $("pairErr").innerText="";
  show("addWrap");
}
function closeAdd(){ hide("addWrap"); }

function saveManual(){
  var body = { name:$("dName").value.trim(), model_id:$("dModel").value, ip:$("dIp").value.trim() };
  fetch("/api/devices",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})
  .then(function(r){return r.json();}).then(function(d){
    if(!d.ok){ $("addErr").innerText=d.msg||"保存失败"; return; }
    closeAdd(); selDev=d.device && d.device.id; loadDevices();
  });
}
function submitPair(){
  fetch("/api/devices/pair",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:$("pairCode").value.trim()})})
  .then(function(r){return r.json();}).then(function(d){
    $("pairErr").innerText=d.msg||"等待设备端，请先用手工登记";
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
