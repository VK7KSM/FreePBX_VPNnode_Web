var DEV = [];
var MODELS = [];
var selDev = "";
var selFn = "adb";
var map = null;
var markers = {};
var circles = {};
var UI = {};

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
      adb: { state: "未连接", port: "", cmd: "" },
      talk: false,
      live: ""
    };
  }
  return UI[d.id];
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
    if(!currentDev() && DEV.length) selDev = DEV[0].id;
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
  var u = uiOf();
  var st = u ? u.adb.state : "未连接";
  var port = u && u.adb.port ? u.adb.port : "—";
  var cmd = (u && u.adb.cmd) ? u.adb.cmd : "adb connect 127.0.0.1:<端口>";
  var h = "<h4>远程 ADB</h4>";
  h += '<div class="ops-grid">';
  h += kv("会话", st);
  h += kv("本机端口", port);
  h += kv("连接命令", cmd);
  h += "</div>";
  h += '<div class="ops-actions" style="margin-top:.7rem">';
  h += '<button class="btn-green" onclick="adbStart()"'+dis+'>开启会话</button>';
  h += '<button class="btn-gray" onclick="adbStop()"'+dis+'>关闭会话</button>';
  h += "</div>";
  h += '<p class="ops-sec-title" style="margin-top:.85rem">授权本机 ADB 公钥</p>';
  h += '<textarea class="inp" id="adbPub" placeholder="粘贴本机 adbkey.pub，私钥留在这台电脑"'+dis+"></textarea>";
  h += '<div class="ops-actions" style="margin-top:.5rem">';
  h += '<button class="btn-gray" onclick="adbAuth()"'+dis+'>写入设备信任列表</button>';
  h += "</div>";
  return h;
}

function pageUpdate(dis){
  var u = uiOf();
  var d = currentDev();
  var ver = d && d.app_version ? d.app_version : "未接入";
  var h = "<h4>更新客户端</h4>";
  h += '<div class="ops-grid">'+kv("当前版本", ver)+"</div>";
  h += '<div class="ops-actions" style="margin-top:.7rem">';
  h += '<input id="ghRel" class="inp" placeholder="GitHub Releases 地址" style="max-width:360px"'+dis+'>';
  h += '<button class="btn-green" onclick="updateFromGithub()"'+dis+'>从 GitHub 安装</button>';
  h += "</div>";
  h += '<div class="ops-actions" style="margin-top:.45rem">';
  h += '<input id="apkFile" type="file" accept=".apk"'+dis+'>';
  h += '<button class="btn-green" onclick="updateFromFile()"'+dis+'>从本地文件安装</button>';
  h += "</div>";
  h += '<table style="margin-top:.7rem"><thead><tr><th>时间</th><th>来源</th><th>文件/版本</th><th>结果</th></tr></thead><tbody>';
  var rows = u ? u.updates : [];
  if(!rows.length) h += '<tr><td colspan="4" class="muted">还没有安装记录</td></tr>';
  else for(var i=0;i<rows.length;i++){
    var r=rows[i];
    h += "<tr><td>"+sydney(r.at)+"</td><td>"+esc(r.src)+"</td><td>"+esc(r.name)+"</td><td>"+esc(r.result)+"</td></tr>";
  }
  h += "</tbody></table>";
  return h;
}

function pageWifi(dis){
  var u = uiOf();
  var list = u ? u.wifi : [];
  var sel = u ? u.wifiSel : "";
  var last = u ? u.wifiLastOk : "";
  var h = "<h4>配置 Wi-Fi</h4>";
  h += '<div class="ops-actions">';
  h += '<button class="btn-gray" onclick="wifiScan()"'+dis+'>刷新扫描</button>';
  if(last) h += '<span class="muted">上次成功：'+esc(last)+"</span>";
  h += "</div>";
  h += '<table style="margin-top:.55rem"><thead><tr><th>SSID</th><th>信号</th><th>加密</th><th></th></tr></thead><tbody>';
  if(!list.length) h += '<tr><td colspan="4" class="muted">等待设备上报周围 Wi-Fi</td></tr>';
  else for(var i=0;i<list.length;i++){
    var w=list[i];
    h += "<tr><td>"+esc(w.ssid)+"</td><td>"+esc(w.rssi)+"</td><td>"+esc(w.sec)+"</td>";
    h += '<td><button class="btn-gray" onclick="wifiPick(\''+esc(w.ssid)+'\')"'+dis+'>选择</button></td></tr>';
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
  var h = "<h4>通信录</h4>";
  h += '<div class="ops-actions">';
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
  var u = uiOf();
  var rows = u ? u.loc : [];
  var h = '<div class="ops-actions">';
  h += '<button class="btn-green" onclick="locNow()"'+dis+'>立即更新位置</button>';
  h += "</div>";
  h += '<table style="margin-top:.55rem"><thead><tr><th>时间</th><th>纬度</th><th>经度</th></tr></thead><tbody>';
  if(!rows.length) h += '<tr><td colspan="3" class="muted">还没有定位记录</td></tr>';
  else for(var i=0;i<rows.length;i++){
    var r=rows[i];
    h += "<tr><td>"+sydney(r.at)+"</td><td>"+esc(r.lat)+"</td><td>"+esc(r.lng)+"</td></tr>";
  }
  h += "</tbody></table>";
  return h;
}

function pageAlarm(dis){
  var u = uiOf();
  var rows = u ? u.alarm : [];
  var h = '<div class="ops-actions">';
  h += '<button class="btn-green" onclick="alarmPlay()"'+dis+'>播放警报声</button>';
  h += "</div>";
  h += '<table style="margin-top:.55rem"><thead><tr><th>时间</th><th>时长</th></tr></thead><tbody>';
  if(!rows.length) h += '<tr><td colspan="2" class="muted">还没有播放记录</td></tr>';
  else for(var i=0;i<rows.length;i++){
    var r=rows[i];
    h += "<tr><td>"+sydney(r.at)+"</td><td>"+esc(r.dur)+"</td></tr>";
  }
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
function adbStart(){
  var u=uiOf(); if(!u) return;
  u.adb.state="等待本机桥接器与设备出站连接";
  u.adb.port="待桥接器分配";
  u.adb.cmd="adb connect 127.0.0.1:<端口>";
  renderOps();
}
function adbStop(){
  var u=uiOf(); if(!u) return;
  u.adb.state="未连接";
  u.adb.port="—";
  u.adb.cmd="adb connect 127.0.0.1:<端口>";
  renderOps();
}
function adbAuth(){
  var u=uiOf(); if(!u) return;
  var pub=$("adbPub")?$("adbPub").value.trim():"";
  if(!pub){ alert("请粘贴本机 adbkey.pub"); return; }
  u.adb.state="公钥已提交，等待设备写入信任列表";
  renderOps();
}
function pushUpdate(src, name){
  var u=uiOf(); if(!u) return;
  u.updates.unshift({ at: nowIso(), src: src, name: name, result: "已下发，等待安装结果" });
  renderOps();
}
function updateFromGithub(){
  var url=$("ghRel")?$("ghRel").value.trim():"";
  if(!url){ alert("请填写 GitHub Releases 地址"); return; }
  pushUpdate("GitHub", url);
}
function updateFromFile(){
  var f=$("apkFile") && $("apkFile").files && $("apkFile").files[0];
  if(!f){ alert("请选择本地 APK"); return; }
  pushUpdate("本地文件", f.name);
}
function wifiScan(){
  var u=uiOf(); if(!u) return;
  renderOps();
}
function wifiPick(ssid){
  var u=uiOf(); if(!u) return;
  u.wifiSel=ssid;
  renderOps();
}
function wifiConnect(){
  var u=uiOf(); if(!u) return;
  var ssid=$("wifiSsid")?$("wifiSsid").value.trim():"";
  var pw=$("wifiPw")?$("wifiPw").value:"";
  if(!ssid){ alert("请选择或填写 SSID"); return; }
  if(!pw){ alert("请输入密码"); return; }
  u.wifiSel=ssid;
  renderOps();
}
function contactRefresh(){ renderOps(); }
function contactAdd(){
  var u=uiOf(); if(!u) return;
  var name=$("cName")?$("cName").value.trim():"";
  var phone=$("cPhone")?$("cPhone").value.trim():"";
  if(!name||!phone){ alert("请填写姓名和号码"); return; }
  u.contacts.push({ name:name, phone:phone });
  renderOps();
}
function contactEdit(i){
  var u=uiOf(); if(!u||!u.contacts[i]) return;
  var name=prompt("姓名", u.contacts[i].name); if(name==null) return;
  var phone=prompt("号码", u.contacts[i].phone); if(phone==null) return;
  name=name.trim(); phone=phone.trim();
  if(!name||!phone) return;
  u.contacts[i]={ name:name, phone:phone };
  renderOps();
}
function contactDel(i){
  var u=uiOf(); if(!u) return;
  u.contacts.splice(i,1);
  renderOps();
}
function locNow(){
  var u=uiOf(); if(!u) return;
  var d=currentDev();
  var lat="—", lng="—";
  if(d && d.loc && isFinite(d.loc.lat) && isFinite(d.loc.lng)){
    lat=Number(d.loc.lat).toFixed(6);
    lng=Number(d.loc.lng).toFixed(6);
  }
  u.loc.unshift({ at: nowIso(), lat: lat, lng: lng });
  renderOps();
}
function alarmPlay(){
  var u=uiOf(); if(!u) return;
  u.alarm.unshift({ at: nowIso(), dur: "等待设备回报" });
  renderOps();
}
function lostRec(){
  var u=uiOf(); if(!u) return;
  u.live="录音中（实时播放待设备接入）";
  u.recs.unshift({ at: nowIso(), kind: "录音", state: "进行中" });
  renderOps();
}
function lostVideo(cam){
  var u=uiOf(); if(!u) return;
  var lab = cam==="front" ? "前置录像" : "后置录像";
  u.live=lab+"中（实时画面待设备接入）";
  u.recs.unshift({ at: nowIso(), kind: lab, state: "进行中" });
  renderOps();
}
function lostPhoto(cam){
  var u=uiOf(); if(!u) return;
  var lab = cam==="front" ? "前置" : "后置";
  u.photos.unshift({ at: nowIso(), cam: lab, state: "等待回传" });
  renderOps();
}
function lostTalk(){
  var u=uiOf(); if(!u) return;
  u.talk=!u.talk;
  u.live=u.talk ? "对讲中：外置扬声器 + 麦克风" : "对讲已停止";
  renderOps();
}
function lostLock(){
  var u=uiOf(); if(!u) return;
  var pw=$("lockPw")?$("lockPw").value:"";
  if(!pw){ alert("请设置解锁密码"); return; }
  u.live="已下发锁机";
  renderOps();
}
function lostUnlock(){
  var u=uiOf(); if(!u) return;
  u.live="已下发解锁";
  renderOps();
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
