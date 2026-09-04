var DEV = [];
var MODELS = [];
var selDev = "";
var map = null;
var markers = {};
var circles = {};

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

function currentDev(){
  for(var i=0;i<DEV.length;i++) if(DEV[i].id===selDev) return DEV[i];
  return null;
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

function renderOps(){
  var box = $("devOps");
  var d = currentDev();
  var dis = d ? "" : " disabled";
  var bat = !d || d.battery==null ? "—" : (d.battery+"%");
  var net = !d ? "—" : (d.network==="wifi" ? "Wi-Fi" : (d.network==="cellular" ? "移动数据" : "未知"));
  var src = d && d.loc ? locLabel(d.loc.source) : "—";
  var online = !d ? "—" : (d.online ? "在线" : (d.enabled===false ? "已停用" : "未接入"));
  var h = "";
  h += '<div class="ops-head"><h3>功能设置</h3>';
  if(d) h += '<span class="muted">'+esc(d.name)+" · "+esc(d.model_name||modelName(d.model_id))+"</span>";
  else h += '<span class="muted">请先从左侧选择设备，或点「添加设备」</span>';
  h += "</div>";
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
  h += '<div class="ops-sec"><div class="ops-sec-title">本机</div><div class="ops-actions">';
  h += '<input id="opName" class="inp" placeholder="设备名称" value="'+(d?esc(d.name):"")+'" style="max-width:220px"'+dis+">";
  h += '<button class="btn-green" onclick="saveName()"'+dis+">保存名称</button>";
  if(d && d.enabled===false) h += '<button class="btn-gray" onclick="setEnabled(true)">启用</button>';
  else h += '<button class="btn-gray" onclick="setEnabled(false)"'+dis+">停用</button>";
  h += '<button class="btn-gray" style="color:#f87171" onclick="delDev()"'+dis+">解除配对</button>";
  h += "</div></div>";
  h += '<div class="ops-sec"><div class="ops-sec-title">远程（需管理程序，当前不可用）</div><div class="ops-actions">';
  h += '<button class="btn-gray" disabled title="等待设备端">远程调试</button>';
  h += '<button class="btn-gray" disabled title="等待设备端">丢失模式</button>';
  h += '<button class="btn-gray" disabled title="等待设备端">立即定位</button>';
  h += '<button class="btn-gray" disabled title="等待设备端">播放报警</button>';
  h += '<button class="btn-gray" disabled title="等待设备端">Wi-Fi</button>';
  h += '<button class="btn-gray" disabled title="等待设备端">通讯录</button>';
  h += '<button class="btn-gray" disabled title="等待设备端">推送更新</button>';
  h += "</div></div>";
  box.innerHTML = h;
}
function kv(k,v){ return '<div class="kv"><div class="k">'+k+'</div><div class="v">'+esc(v)+'</div></div>'; }

function saveName(){
  var d = currentDev(); if(!d) return;
  var name = $("opName").value.trim();
  fetch("/api/devices/update",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:d.id,name:name})})
  .then(function(r){return r.json();}).then(function(x){
    if(!x.ok){ alert(x.msg||"保存失败"); return; }
    loadDevices();
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
    h += '<option value="'+esc(m.id)+'"'+(m.id===val?" selected":"")+'>'+esc(m.name)+'</option>';
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

function openModels(){
  renderModelTable();
  show("modelWrap");
}
function closeModels(){ hide("modelWrap"); }
function renderModelTable(){
  var h = "<table><thead><tr><th>名称</th><th>备注</th><th></th></tr></thead><tbody>";
  for(var i=0;i<MODELS.length;i++){
    var m = MODELS[i];
    h += '<tr><td>'+esc(m.name)+'</td><td class="muted">'+esc(m.note||"")+'</td>';
    h += '<td><button class="btn-gray" onclick="editModel(\''+m.id+'\')">改</button> ';
    h += '<button class="btn-gray" style="color:#f87171" onclick="delModel(\''+m.id+'\')">删</button></td></tr>';
  }
  h += "</tbody></table>";
  $("modelTable").innerHTML = h;
}
function addModel(){
  var name = $("mName").value.trim();
  var note = $("mNote").value.trim();
  fetch("/api/device-models",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:name,note:note})})
  .then(function(r){return r.json();}).then(function(d){
    if(!d.ok){ alert(d.msg||"失败"); return; }
    MODELS = d.models; $("mName").value=""; $("mNote").value="";
    renderModelTable(); fillModelSelect($("dModel"), $("dModel").value);
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
    MODELS = d.models; renderModelTable(); loadDevices();
  });
}
function delModel(id){
  if(!confirm("删除该型号？")) return;
  fetch("/api/device-models",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"delete",id:id})})
  .then(function(r){return r.json();}).then(function(d){
    if(!d.ok){ alert(d.msg||"失败"); return; }
    MODELS = d.models; renderModelTable();
  });
}

checkAuth();
setTimeout(function(){ if(typeof L!=="undefined") renderMap(); }, 200);
