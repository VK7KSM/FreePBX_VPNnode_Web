var E = [];
var G = [];
var W = [];
var ST = null;
var GEO = {};
var STALE = true;
var SYNC = null;
var cdrPage = 1;
var cdrExt = "";
var PAGE = 25;
var PAGE_G = 10;
var HOLD = {};
var selExt = "";
var selGw = "";
var selGrp = "";
var GP = {};
var editingExt = "";
var editingGw = "";
var editingGrp = "";

function $(id){ return document.getElementById(id); }
function show(id){ $(id).style.display = "flex"; }
function hide(id){ $(id).style.display = "none"; }
function checkAuth(){ if(localStorage.getItem("_pt")){ hide("loginWrap"); loadSip(); } else show("loginWrap"); }
function doLogin(){
  fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:$("lu").value,password:$("lp").value})})
  .then(function(r){return r.json();}).then(function(d){
    if(d.ok){ localStorage.setItem("_pt","1"); hide("loginWrap"); loadSip(); }
    else { $("lerr").innerText=d.msg||"失败"; $("lerr").style.display="block"; }
  });
}
function logout(){ localStorage.removeItem("_pt"); location.href="/"; }
function loadSip(){
  fetch("/api/sip").then(function(r){return r.json();}).then(function(d){
    if(d.extensions) E = d.extensions;
    if(d.groups) G = d.groups;
    if(d.gateways) W = d.gateways;
    if(d.status){ ST = d.status; if(d.geo) GEO = d.geo; }
    STALE = !!d.stale || !d.status;
    SYNC = d.sync||null;
    renderStatus();
    renderAll();
    renderSync();
  }).catch(function(){ STALE=true; renderStatus(); });
}
function saveAll(done){
  window._sipSaved = true;
  fetch("/api/sip/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({extensions:E,groups:G,gateways:W})})
  .then(function(r){return r.json();}).then(function(d){
    if(!d.ok){ alert(d.msg||"保存失败"); window._sipSaved=false; return; }
    if(done) done();
    loadSip();
  }).catch(function(){ alert("保存失败"); window._sipSaved=false; });
}
function gwName(ext){
  for(var i=0;i<W.length;i++) if(String(W[i].ext)===String(ext)) return W[i].name || ext;
  return ext;
}
function grpName(id){
  for(var i=0;i<G.length;i++) if(G[i].id===id) return G[i].name || id;
  return id;
}
function grpOf(id){
  for(var i=0;i<G.length;i++) if(G[i].id===id) return G[i];
  return null;
}
function membersOf(gid){
  var out=[];
  for(var i=0;i<E.length;i++){
    var id = E[i].group_id || "";
    if(gid==="__none" && !id) out.push(E[i]);
    else if(id===gid) out.push(E[i]);
  }
  return out;
}
function groupsUsingGw(ext){
  var names=[];
  for(var i=0;i<G.length;i++) if(String(G[i].gateway)===String(ext)) names.push(G[i].name||G[i].id);
  return names;
}
function peerLabel(g){
  if(g.internal==="all") return "全部内网";
  if(g.internal==="peers"){
    var names=[];
    for(var i=0;i<(g.peers||[]).length;i++) names.push(grpName(g.peers[i]));
    return names.length ? ("互打："+names.join("、")) : "指定组（未选）";
  }
  return "仅组内";
}
function liveMap(){
  var m = {}; var cs = (ST && ST.contacts) || []; var now = Date.now();
  for(var i=0;i<cs.length;i++){
    if(!cs[i].ext) continue;
    var id=String(cs[i].ext);
    m[id]=cs[i];
    if(contactLive(cs[i])) HOLD[id]={c:cs[i], until:now+30000};
  }
  for(var k in HOLD){ if(!m[k] && HOLD[k] && now<HOLD[k].until) m[k]=HOLD[k].c; }
  return m;
}
function isGwExt(ext){
  for(var i=0;i<W.length;i++) if(String(W[i].ext)===String(ext)) return true;
  return false;
}
function isAvailStatus(status){
  return String(status||"").toLowerCase() === "avail";
}
function contactLive(c){
  if(!c) return false;
  if(isGwExt(c.ext)) return !!(c.uri || c.ip || c.status);
  return isAvailStatus(c.status);
}
function isOnline(ext, live){
  return contactLive(live[String(ext)]);
}
function fmtRtt(L){
  if(!L || L.rtt==null || !isFinite(Number(L.rtt))) return "-";
  return Number(L.rtt)+" ms";
}
function twoLine(a,b){
  return "<div class=\"cell2\"><div class=\"cell2a\">"+(a||"-")+"</div><div class=\"cell2b\">"+(b||"\u00a0")+"</div></div>";
}
function fmtDur(sec){
  sec = parseInt(sec,10)||0;
  var h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60), s=sec%60;
  function z(n){return n<10?"0"+n:""+n;}
  return h>0 ? h+":"+z(m)+":"+z(s) : z(m)+":"+z(s);
}
function parseTime(t){
  if(!t) return null;
  var s=String(t).trim();
  if(/^\d{4}-\d{2}-\d{2} /.test(s) && s.indexOf("Z")<0 && s.indexOf("+")<0) s=s.replace(" ","T")+"Z";
  var d=new Date(s);
  return isNaN(d.getTime())?null:d;
}
function sydneyDay(d){
  if(!d) return "";
  var p=new Intl.DateTimeFormat("en-CA",{timeZone:"Australia/Sydney",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(d);
  function g(tp){ for(var i=0;i<p.length;i++) if(p[i].type===tp) return p[i].value; return ""; }
  return g("year")+"-"+g("month")+"-"+g("day");
}
function fmtSydney(t){
  var d=parseTime(t); if(!d) return "-";
  var p=new Intl.DateTimeFormat("en-CA",{timeZone:"Australia/Sydney",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).formatToParts(d);
  function g(tp){ for(var i=0;i<p.length;i++) if(p[i].type===tp) return p[i].value; return ""; }
  return g("year")+"-"+g("month")+"-"+g("day")+" "+g("hour")+":"+g("minute")+":"+g("second");
}
function fmtTime(t){ return fmtSydney(t); }
function fmtSeen(t){
  var s = fmtSydney(t);
  if(!s || s==="-") return twoLine("-", "\u00a0");
  var p = s.split(" ");
  if(p.length<2) return twoLine(s, "\u00a0");
  return twoLine(p[0], p[1]);
}
function cdrFor(ext){
  var all = (ST && ST.cdr) || []; var out=[];
  for(var i=0;i<all.length;i++){
    var r=all[i];
    if(String(r.src)===String(ext) || String(r.dst)===String(ext)) out.push(r);
  }
  return out.reverse();
}
function statsFor(ext){
  var rows = cdrFor(ext); var n=0, dur=0;
  for(var i=0;i<rows.length;i++){ n++; dur += parseInt(rows[i].billsec||rows[i].duration||0,10)||0; }
  return {count:n, dur:dur};
}
function renderStatus(){
  var box = $("stats"); var hint = $("staleHint"); var s = ST;
  if(!s){ hint.innerText="暂时读不到新数据，图表保持上次。"; return; }
  hint.innerHTML = STALE ? "<span class=\"bad\">心跳超时，机器可能卡住或离线</span> · 上次 "+fmtSydney(s.received_at) : "<span class=\"ok\">心跳正常</span> · "+fmtSydney(s.received_at);
  function kpi(t,v,c){ return "<div class=\"stat\"><div style=\"font-size:.75rem;color:#94a3b8\">"+t+"</div><div style=\"font-size:1.15rem;font-weight:700;margin-top:.25rem\" class=\""+(c||"")+"\">"+v+"</div></div>"; }
  function series(hist,key){ var o=[]; for(var i=0;i<hist.length;i++) o.push(Number(hist[i][key])||0); return o; }
  function svgArea(vals,color,yMax){
    var w=100,h=38,n=vals.length;
    if(!n) return "<div style=\"height:72px\"></div>";
    var mx=yMax||0; for(var i=0;i<n;i++) if(vals[i]>mx) mx=vals[i]; if(mx<=0) mx=1;
    function pt(i,v){ var x=n===1?50:(i/(n-1)*w); var y=h-(v/mx)*h*0.9; return x.toFixed(2)+","+y.toFixed(2); }
    var line=[], fill=["0,"+h];
    for(var j=0;j<n;j++){ var p=pt(j,vals[j]); line.push(p); fill.push(p); }
    fill.push(w+","+h);
    return "<svg viewBox=\"0 0 "+w+" "+h+"\" preserveAspectRatio=\"none\" style=\"width:100%;height:72px;display:block\"><polygon fill=\""+color+"22\" points=\""+fill.join(" ")+"\"/><polyline fill=\"none\" stroke=\""+color+"\" stroke-width=\"1.2\" stroke-linejoin=\"round\" vector-effect=\"non-scaling-stroke\" points=\""+line.join(" ")+"\"/></svg>";
  }
  function svgDual(a,b,ca,cb,yMax){
    var w=100,h=38,n=Math.max(a.length,b.length);
    if(!n) return "<div style=\"height:72px\"></div>";
    var mx=yMax||0; for(var i=0;i<n;i++){ if((a[i]||0)>mx) mx=a[i]; if((b[i]||0)>mx) mx=b[i]; } if(mx<=0) mx=1;
    function poly(vals,col){ var pts=[]; for(var i=0;i<n;i++){ var x=n===1?50:(i/(n-1)*w); var y=h-((vals[i]||0)/mx)*h*0.9; pts.push(x.toFixed(2)+","+y.toFixed(2)); } return "<polyline fill=\"none\" stroke=\""+col+"\" stroke-width=\"1\" stroke-linejoin=\"miter\" stroke-linecap=\"butt\" vector-effect=\"non-scaling-stroke\" points=\""+pts.join(" ")+"\"/>"; }
    return "<svg viewBox=\"0 0 "+w+" "+h+"\" preserveAspectRatio=\"none\" style=\"width:100%;height:72px;display:block\">"+poly(a,ca)+poly(b,cb)+"</svg>";
  }
  function fmtRate(bps){ bps=Number(bps)||0; if(bps<1024) return Math.round(bps)+" B/s"; if(bps<1048576) return (bps/1024).toFixed(1)+" KB/s"; return (bps/1048576).toFixed(2)+" MB/s"; }
  function todayCalls(st){
    var rows=(st&&st.cdr)||[]; var day=sydneyDay(parseTime(st.received_at)); var n=0;
    for(var i=0;i<rows.length;i++){ var d=sydneyDay(parseTime(rows[i].time)); if(!day || d===day) n++; }
    return n;
  }
  var hist=s.history||[];
  var live=liveMap(); var online=0;
  for(var i=0;i<E.length;i++) if(isOnline(E[i].ext, live)) online++;
  var callsNow=s.active_calls!=null?s.active_calls:0;
  var html="<div style=\"display:flex;flex-wrap:wrap;gap:.7rem;width:100%;margin-bottom:.9rem\">";
  html += kpi("主机", s.hostname||"-");
  html += kpi("Asterisk", s.asterisk||"-", s.asterisk==="active"?"ok":"bad");
  html += kpi("运行时长", s.uptime||"-");
  html += kpi("在线分机", online+" / "+(E.length||0), online?"ok":"");
  html += kpi("当前呼叫", String(callsNow), callsNow?"ok":"");
  html += kpi("今日通话", String(todayCalls(s)));
  html += "</div><div class=\"mon-grid\">";
  html += "<div class=\"mon-card\"><div style=\"display:flex;justify-content:space-between;align-items:baseline\"><span style=\"font-size:.8rem;color:#94a3b8\">CPU</span><span style=\"font-size:1.25rem;font-weight:700\" class=\""+((s.cpu_pct||0)>85?"bad":"")+"\">"+(s.cpu_pct!=null?s.cpu_pct+"%":"-")+"</span></div><div style=\"font-size:.75rem;color:#64748b;margin:.2rem 0 .35rem\">负载 "+(s.load||"-")+"</div>"+svgArea(series(hist,"cpu"),"#4ade80",100)+"</div>";
  html += "<div class=\"mon-card\"><div style=\"display:flex;justify-content:space-between;align-items:baseline\"><span style=\"font-size:.8rem;color:#94a3b8\">内存</span><span style=\"font-size:1.25rem;font-weight:700\" class=\""+((s.mem_pct||0)>90?"bad":"")+"\">"+(s.mem_pct!=null?s.mem_pct+"%":"-")+"</span></div><div style=\"font-size:.75rem;color:#64748b;margin:.2rem 0 .35rem\">"+(s.mem_used||"-")+" / "+(s.mem_total||"-")+"</div>"+svgArea(series(hist,"mem"),"#a78bfa",100)+"</div>";
  html += "<div class=\"mon-card\"><div style=\"display:flex;justify-content:space-between;align-items:baseline\"><span style=\"font-size:.8rem;color:#94a3b8\">磁盘</span><span style=\"font-size:1.25rem;font-weight:700\" class=\""+((s.disk_pct||0)>90?"bad":"")+"\">"+(s.disk_pct!=null?s.disk_pct+"%":"-")+"</span></div><div style=\"font-size:.75rem;color:#64748b;margin:.2rem 0 .35rem\">"+(s.disk_used||"-")+" / "+(s.disk_total||"-")+"</div>"+svgArea(series(hist,"disk"),"#fbbf24",100)+"</div>";
  html += "<div class=\"mon-card\"><div style=\"display:flex;justify-content:space-between;align-items:baseline\"><span style=\"font-size:.8rem;color:#94a3b8\">网卡</span><span style=\"font-size:1.05rem;font-weight:700\">↓ "+fmtRate(s.rx_bps)+" · ↑ "+fmtRate(s.tx_bps)+"</span></div><div style=\"font-size:.75rem;color:#64748b;margin:.2rem 0 .35rem\"><span style=\"color:#38bdf8\">接收</span> / <span style=\"color:#fb7185\">发送</span> · 累计 "+(s.net||"-")+"</div>"+svgDual(series(hist,"rx"),series(hist,"tx"),"#38bdf8","#fb7185")+"</div>";
  html += "</div>";
  box.innerHTML = html;
}
function renderSync(){
  var el=$("syncHint"); if(!el) return;
  el.style.display="block";
  if(SYNC && SYNC.error){ el.innerHTML="<span class=\"bad\">保存到交换机失败：</span>"+SYNC.error; return; }
  if(SYNC && SYNC.pending && window._sipSaved){ el.innerHTML="<span class=\"warn\">正在保存到 SIP 服务器…</span>"; return; }
  window._sipSaved=false;
  el.innerHTML="<span class=\"ok\">已同步到 SIP 服务器</span>";
}
function extRowHtml(x, live){
  var L=live[String(x.ext)];
  var online = isOnline(x.ext, live);
  var dot = online ? "<span class=\"dot dot-on\" title=\"在线\"></span>" : "<span class=\"dot dot-off\" title=\"离线\"></span>";
  var tr = online && L && L.transport ? String(L.transport).toUpperCase() : "-";
  var ipCell = (online && L && L.ip) ? twoLine(L.ip, GEO[L.ip] || "查询中") : twoLine("-", "\u00a0");
  var rtt = (online && L) ? fmtRtt(L) : "-";
  var last=(ST && ST.last_seen)||{};
  var seen = last[x.ext] ? fmtSeen(last[x.ext]) : twoLine("-", "\u00a0");
  var st = statsFor(x.ext);
  var html = "<tr"+(selExt===String(x.ext)?" class=\"sel\"":"")+">";
  html += "<td><input class=\"rowchk\" type=\"checkbox\" "+(selExt===String(x.ext)?"checked":"")+" onchange=\"pickExt('"+x.ext+"',this.checked)\"></td>";
  html += "<td style=\"text-align:center\">"+dot+"</td>";
  html += "<td><a class=\"extlink\" href=\"#\" onclick=\"openCdr('"+x.ext+"');return false;\">"+x.ext+"</a></td>";
  html += "<td><a class=\"namelink\" href=\"#\" onclick=\"openCdr('"+x.ext+"');return false;\">"+(x.name||"-")+"</a></td>";
  html += "<td>"+tr+"</td><td>"+ipCell+"</td>";
  html += "<td style=\"white-space:nowrap\">"+rtt+"</td>";
  html += "<td>"+seen+"</td>";
  html += "<td>"+st.count+"</td><td style=\"white-space:nowrap\">"+fmtDur(st.dur)+"</td>";
  html += "</tr>";
  return html;
}
function renderAll(){
  renderGroupsTable();
  renderGatewaysTable();
  renderGroupBoxes();
}
function renderGroupsTable(){
  var tb=$("gtb"); if(!tb) return;
  var html="";
  for(var i=0;i<G.length;i++){
    var g=G[i];
    var n=membersOf(g.id).length;
    var out = g.gateway ? (g.gateway+" "+gwName(g.gateway)) : "无";
    html += "<tr"+(selGrp===g.id?" class=\"sel\"":"")+">";
    html += "<td><input class=\"rowchk\" type=\"checkbox\" "+(selGrp===g.id?"checked":"")+" onchange=\"pickGrp('"+g.id+"',this.checked)\"></td>";
    html += "<td></td><td>"+g.name+"</td><td>"+n+"</td><td>"+out+"</td><td>"+peerLabel(g)+"</td></tr>";
  }
  tb.innerHTML = html || "<tr><td colspan=\"5\" style=\"text-align:center;color:#475569;padding:1.2rem\">暂无通话组，请先添加</td></tr>";
}
function renderGatewaysTable(){
  var tb=$("wtb"); if(!tb) return;
  var live=liveMap(); var html="";
  for(var i=0;i<W.length;i++){
    var x=W[i]; var L=live[String(x.ext)];
    var online=isOnline(x.ext, live);
    var dot = online ? "<span class=\"dot dot-on\"></span>" : "<span class=\"dot dot-off\"></span>";
    var tr = online && L && L.transport ? String(L.transport).toUpperCase() : "-";
    var rtt = (online && L) ? fmtRtt(L) : "-";
    var used = groupsUsingGw(x.ext);
    var fwd = "-";
    if(x.inbound_fwd && x.sms_fwd && x.inbound_fwd!==x.sms_fwd) fwd = x.inbound_fwd+" / "+x.sms_fwd;
    else if(x.inbound_fwd || x.sms_fwd) fwd = x.inbound_fwd || x.sms_fwd;
    html += "<tr"+(selGw===String(x.ext)?" class=\"sel\"":"")+">";
    html += "<td><input class=\"rowchk\" type=\"checkbox\" "+(selGw===String(x.ext)?"checked":"")+" onchange=\"pickGw('"+x.ext+"',this.checked)\"></td>";
    html += "<td style=\"text-align:center\">"+dot+"</td>";
    html += "<td>"+x.ext+"</td><td>"+x.name+"</td>";
    html += "<td>"+(x.public_number||"-")+"</td>";
    html += "<td>"+fwd+"</td>";
    html += "<td>"+(used.length?used.join("、"):"无")+"</td>";
    html += "<td>"+tr+"</td><td style=\"white-space:nowrap\">"+rtt+"</td></tr>";
  }
  tb.innerHTML = html || "<tr><td colspan=\"9\" style=\"text-align:center;color:#475569;padding:1.2rem\">暂无网关账户</td></tr>";
}
function renderGroupBoxes(){
  var box=$("groupBoxes"); if(!box) return;
  var live=liveMap();
  var html="";
  function oneBox(gid, title, meta, moveBtns){
    moveBtns = moveBtns || "";
    var rows=membersOf(gid);
    var page=GP[gid]||1;
    var pages=Math.max(1, Math.ceil(rows.length/PAGE_G));
    if(page>pages) page=pages;
    GP[gid]=page;
    var start=(page-1)*PAGE_G;
    var slice=rows.slice(start, start+PAGE_G);
    var pager="";
    if(rows.length>PAGE_G){
      pager="<div style=\"display:flex;justify-content:space-between;align-items:center;margin-top:.8rem;font-size:.8rem;color:#94a3b8\"><span>第 "+page+" / "+pages+" 页，共 "+rows.length+" 个分机</span><span><button class=\"btn-gray\" onclick=\"setGPage('"+gid+"',"+(page-1)+")\">上一页</button> <button class=\"btn-gray\" onclick=\"setGPage('"+gid+"',"+(page+1)+")\">下一页</button></span></div>";
    }
    var cols="<colgroup><col class=\"c-chk\"><col class=\"c-on\"><col class=\"c-ext\"><col style=\"width:16%\"><col style=\"width:56px\"><col style=\"width:22%\"><col style=\"width:90px\"><col style=\"width:110px\"><col style=\"width:72px\"><col style=\"width:90px\"></colgroup>";
    var body="<table class=\"dir-table\">"+cols+"<thead><tr><th></th><th>在线</th><th>分机号</th><th>名称</th><th>传输</th><th>IP</th><th>延时</th><th>最近上线</th><th>拨打次数</th><th>总通话时长</th></tr></thead><tbody>";
    if(!slice.length) body += "<tr><td colspan=\"10\" style=\"text-align:center;color:#475569;padding:1.2rem\">暂无分机</td></tr>";
    else for(var i=0;i<slice.length;i++) body += extRowHtml(slice[i], live);
    body += "</tbody></table>";
    html += "<div style=\"border-radius:.8rem;background:rgba(15,23,42,.6);border:1px solid #1e293b\">";
    html += "<div style=\"display:flex;justify-content:space-between;align-items:center;padding:1rem .7rem .8rem;gap:1rem;flex-wrap:wrap\">";
    html += "<div><h3 style=\"font-weight:700;margin:0;font-size:1rem\">"+title+"</h3><p style=\"font-size:.8rem;color:#94a3b8;margin:.35rem 0 0\">"+meta+"</p></div>";
    html += moveBtns;
    html += "</div><div style=\"overflow-x:auto\">"+body+"</div>"+pager+"</div>";
  }
  for(var i=0;i<G.length;i++){
    var g=G[i];
    var mem=membersOf(g.id);
    var on=0; for(var j=0;j<mem.length;j++) if(isOnline(mem[j].ext, live)) on++;
    var out = g.gateway ? g.gateway : "无";
    var upDis = i===0 ? " disabled" : "";
    var downDis = i===G.length-1 ? " disabled" : "";
    var moveBtns = "<div style=\"display:flex;gap:.4rem\">"+
      "<button class=\"btn-icon\" title=\"上移\" onclick=\"moveGrp('"+g.id+"',-1)\""+upDis+"><svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><polyline points=\"18 15 12 9 6 15\"></polyline></svg></button>"+
      "<button class=\"btn-icon\" title=\"下移\" onclick=\"moveGrp('"+g.id+"',1)\""+downDis+"><svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><polyline points=\"6 9 12 15 18 9\"></polyline></svg></button>"+
      "</div>";
    oneBox(g.id, g.name, mem.length+" 人 · "+on+" 在线 · 外呼："+out+" · "+peerLabel(g), moveBtns);
  }
  var none=membersOf("__none");
  var onn=0; for(var k=0;k<none.length;k++) if(isOnline(none[k].ext, live)) onn++;
  oneBox("__none", "未分组", none.length+" 人 · "+onn+" 在线 · 外呼：无 · 仅未分组互打", "");
  box.innerHTML = html;
}
function moveGrp(id, dir){
  var i=-1;
  for(var k=0;k<G.length;k++) if(G[k].id===id) i=k;
  var j=i+dir;
  if(i<0 || j<0 || j>=G.length) return;
  var t=G[i]; G[i]=G[j]; G[j]=t;
  saveAll();
}
function setGPage(gid, page){ if(page<1) page=1; GP[gid]=page; renderGroupBoxes(); }
function pickExt(ext,on){ selExt = on ? String(ext) : (selExt===String(ext)?"":selExt); renderGroupBoxes(); }
function pickGw(ext,on){ selGw = on ? String(ext) : (selGw===String(ext)?"":selGw); renderGatewaysTable(); }
function pickGrp(id,on){ selGrp = on ? id : (selGrp===id?"":selGrp); renderGroupsTable(); }
function fillGroupSelect(sel, cur, includeNone){
  var html = includeNone ? "<option value=\"\">未分组</option>" : "<option value=\"\">无</option>";
  for(var i=0;i<G.length;i++) html += "<option value=\""+G[i].id+"\">"+G[i].name+"</option>";
  sel.innerHTML = html;
  sel.value = cur || "";
}
function fillExtSelect(sel, cur){
  var html = "<option value=\"\">（不转发）</option>";
  for(var i=0;i<E.length;i++) html += "<option value=\""+E[i].ext+"\">"+E[i].ext+" "+(E[i].name||"")+"</option>";
  sel.innerHTML = html;
  sel.value = cur || "";
}
function fillGwSelect(sel, cur){
  var html = "<option value=\"\">无</option>";
  for(var i=0;i<W.length;i++) html += "<option value=\""+W[i].ext+"\">"+W[i].ext+" "+(W[i].name||"")+"</option>";
  sel.innerHTML = html;
  sel.value = cur || "";
}
function fillExtForm(x){
  $("eExt").value=x.ext||""; $("eName").value=x.name||""; $("ePw").value="";
  fillGroupSelect($("eGroup"), x.group_id||"", true);
  $("eOut").value=x.outbound===false?"0":"1";
  $("eSms").value=x.sms?"1":"0"; $("eCf").value=x.cf||""; $("eCfb").value=x.cf_busy||""; $("eCfu").value=x.cf_noreply||"";
  $("eRing").value=x.ringtimer||60;
}
function openExt(gid){
  editingExt=""; $("extTitle").innerText="添加分机"; $("eExt").readOnly=false;
  var pre = (gid && gid!=="__none") ? gid : "";
  fillExtForm({outbound:true,sms:false,ringtimer:60,group_id:pre});
  $("ePw").placeholder="新分机必须填写密码"; show("extWrap");
}
function editSelExt(){
  if(!selExt){ alert("请先勾选一个分机"); return; }
  var x=null; for(var i=0;i<E.length;i++) if(String(E[i].ext)===selExt) x=E[i];
  if(!x){ alert("未找到该分机"); return; }
  editingExt=selExt; $("extTitle").innerText="编辑分机 "+x.ext; $("eExt").readOnly=true;
  fillExtForm(x); $("ePw").placeholder=x.has_password?"已有密码，留空则不修改":"请设置密码"; show("extWrap");
}
function saveExt(){
  var n={ ext:$("eExt").value.trim(), name:$("eName").value.trim(), group_id:$("eGroup").value, outbound:$("eOut").value==="1", sms:$("eSms").value==="1", cf:$("eCf").value.trim(), cf_busy:$("eCfb").value.trim(), cf_noreply:$("eCfu").value.trim(), ringtimer:parseInt($("eRing").value,10)||60 };
  var pw=$("ePw").value;
  if(!n.ext){ alert("分机号不能为空"); return; }
  if(!/^[0-9]{3,6}$/.test(n.ext)){ alert("分机号必须是 3 到 6 位数字"); return; }
  for(var i=0;i<W.length;i++) if(String(W[i].ext)===n.ext){ alert("该号码已是网关账户"); return; }
  if(!editingExt && !pw){ alert("新分机必须设置密码"); return; }
  if(pw) n.password=pw;
  if(editingExt){
    for(var j=0;j<E.length;j++) if(String(E[j].ext)===editingExt){ n.has_password=!!(pw||E[j].has_password); E[j]=n; }
  } else {
    for(var k=0;k<E.length;k++) if(String(E[k].ext)===n.ext){ alert("分机号已存在"); return; }
    n.has_password=!!pw; E.push(n); selExt=n.ext;
  }
  hide("extWrap"); saveAll();
}
function delSelExt(){
  if(!selExt){ alert("请先勾选一个分机"); return; }
  var x=null; for(var i=0;i<E.length;i++) if(String(E[i].ext)===selExt) x=E[i];
  if(!x) return;
  if(!confirm("确定删除分机 "+x.ext+"（"+(x.name||"")+"）？\n将同步删除 SIP 机上的 Asterisk 分机账号。")) return;
  E = E.filter(function(e){ return String(e.ext)!==selExt; });
  selExt=""; saveAll();
}
function togglePeers(){
  $("gPeerBox").style.display = $("gInt").value==="peers" ? "block" : "none";
}
function openGrp(){
  editingGrp=""; $("grpTitle").innerText="添加通话组"; $("gName").value="";
  fillGwSelect($("gGw"), ""); $("gInt").value="self";
  renderPeerChecks([]); togglePeers(); show("grpWrap");
}
function editSelGrp(){
  if(!selGrp){ alert("请先勾选一个通话组"); return; }
  var g=grpOf(selGrp); if(!g) return;
  editingGrp=g.id; $("grpTitle").innerText="编辑通话组"; $("gName").value=g.name||"";
  fillGwSelect($("gGw"), g.gateway||""); $("gInt").value=g.internal||"self";
  renderPeerChecks(g.peers||[]); togglePeers(); show("grpWrap");
}
function renderPeerChecks(selected){
  var html="";
  for(var i=0;i<G.length;i++){
    if(editingGrp && G[i].id===editingGrp) continue;
    var on = selected.indexOf(G[i].id)>=0;
    html += "<label style=\"display:flex;gap:.5rem;align-items:center;font-size:.85rem\"><input type=\"checkbox\" class=\"peerchk\" value=\""+G[i].id+"\" "+(on?"checked":"")+"> "+G[i].name+"</label>";
  }
  if(!html) html = "<span style=\"color:#64748b;font-size:.8rem\">还没有其他通话组</span>";
  $("gPeers").innerHTML = html;
}
function saveGrp(){
  var name=$("gName").value.trim();
  if(!name){ alert("请填写组名"); return; }
  var peers=[];
  var boxes=$("gPeers").querySelectorAll(".peerchk");
  for(var i=0;i<boxes.length;i++) if(boxes[i].checked) peers.push(boxes[i].value);
  var g={ id: editingGrp || ("g"+Date.now()), name:name, gateway:$("gGw").value, internal:$("gInt").value, peers: $("gInt").value==="peers"?peers:[] };
  if(editingGrp){
    for(var j=0;j<G.length;j++) if(G[j].id===editingGrp) G[j]=g;
  } else { G.push(g); selGrp=g.id; }
  hide("grpWrap"); saveAll();
}
function delSelGrp(){
  if(!selGrp){ alert("请先勾选一个通话组"); return; }
  var g=grpOf(selGrp); if(!g) return;
  if(!confirm("确定删除通话组「"+g.name+"」？组内分机将变为未分组。")) return;
  for(var i=0;i<E.length;i++) if(E[i].group_id===selGrp) E[i].group_id="";
  G = G.filter(function(x){ return x.id!==selGrp; });
  selGrp=""; saveAll();
}
function openGw(){
  editingGw=""; $("gwTitle").innerText="添加网关"; $("wExt").readOnly=false;
  $("wExt").value=""; $("wName").value=""; $("wPw").value=""; $("wNum").value="";
  fillExtSelect($("wIn"), ""); fillExtSelect($("wSms"), "");
  $("wUsed").innerText="无"; $("wPw").placeholder="新网关必须填写密码"; show("gwWrap");
}
function editSelGw(){
  if(!selGw){ alert("请先勾选一个网关"); return; }
  var x=null; for(var i=0;i<W.length;i++) if(String(W[i].ext)===selGw) x=W[i];
  if(!x) return;
  editingGw=selGw; $("gwTitle").innerText="编辑网关 "+x.ext; $("wExt").readOnly=true;
  $("wExt").value=x.ext; $("wName").value=x.name||""; $("wPw").value=""; $("wNum").value=x.public_number||"";
  fillExtSelect($("wIn"), x.inbound_fwd||""); fillExtSelect($("wSms"), x.sms_fwd||"");
  var used=groupsUsingGw(x.ext); $("wUsed").innerText=used.length?used.join("、"):"无";
  $("wPw").placeholder=x.has_password?"已有密码，留空则不修改":"请设置密码"; show("gwWrap");
}
function saveGw(){
  var n={ ext:$("wExt").value.trim(), name:$("wName").value.trim(), public_number:$("wNum").value.trim(), inbound_fwd:$("wIn").value, sms_fwd:$("wSms").value };
  var pw=$("wPw").value;
  if(!n.ext){ alert("分机号不能为空"); return; }
  if(!/^[0-9]{3,6}$/.test(n.ext)){ alert("分机号必须是 3 到 6 位数字"); return; }
  for(var i=0;i<E.length;i++) if(String(E[i].ext)===n.ext){ alert("该号码已是内网分机"); return; }
  if(!editingGw && !pw){ alert("新网关必须设置密码"); return; }
  if(pw) n.password=pw;
  if(editingGw){
    for(var j=0;j<W.length;j++) if(String(W[j].ext)===editingGw){ n.has_password=!!(pw||W[j].has_password); W[j]=n; }
  } else {
    for(var k=0;k<W.length;k++) if(String(W[k].ext)===n.ext){ alert("网关分机号已存在"); return; }
    n.has_password=!!pw; W.push(n); selGw=n.ext;
  }
  hide("gwWrap"); saveAll();
}
function delSelGw(){
  if(!selGw){ alert("请先勾选一个网关"); return; }
  if(W.length<=1){ alert("至少保留一个网关账户"); return; }
  var x=null; for(var i=0;i<W.length;i++) if(String(W[i].ext)===selGw) x=W[i];
  if(!x) return;
  if(!confirm("确定删除网关 "+x.ext+"（"+(x.name||"")+"）？")) return;
  for(var j=0;j<G.length;j++) if(String(G[j].gateway)===selGw) G[j].gateway="";
  W = W.filter(function(e){ return String(e.ext)!==selGw; });
  selGw=""; saveAll();
}
function openCdr(ext){ cdrExt=String(ext); cdrPage=1; $("cdrTitle").innerText="分机 "+ext+" 通话记录"; show("cdrWrap"); drawCdr(); }
function drawCdr(){
  var rows = cdrFor(cdrExt);
  var total = rows.length; var pages = Math.max(1, Math.ceil(total/PAGE));
  if(cdrPage>pages) cdrPage=pages; if(cdrPage<1) cdrPage=1;
  var start=(cdrPage-1)*PAGE; var slice=rows.slice(start, start+PAGE);
  var html="";
  if(!slice.length){ html="<tr><td colspan=\"9\" style=\"text-align:center;color:#475569;padding:1.5rem\">暂无通话</td></tr>"; }
  else {
    for(var i=0;i<slice.length;i++){
      var r=slice[i];
      var qc = r.quality==="好"?"ok":(r.quality==="差"?"bad":"warn");
      html += "<tr>";
      html += "<td style=\"white-space:nowrap\">"+fmtTime(r.time)+"</td>";
      html += "<td>"+r.src+"</td><td>"+r.dst+"</td>";
      html += "<td>"+(r.disposition||"-")+"</td>";
      html += "<td>"+fmtDur(r.billsec||r.duration)+"</td>";
      html += "<td class=\""+qc+"\">"+(r.quality||"-")+"</td>";
      html += "<td>"+(r.media_rtt||"-")+"</td>";
      html += "<td>"+(r.jitter||"-")+"</td>";
      html += "<td>"+(r.loss||"-")+"</td>";
      html += "</tr>";
    }
  }
  $("cdrBody").innerHTML = html;
  var pg = "第 "+cdrPage+" / "+pages+" 页，共 "+total+" 条";
  pg += " <span><button class=\"btn-gray\" onclick=\"cdrPage--;drawCdr()\">上一页</button> ";
  pg += "<button class=\"btn-gray\" onclick=\"cdrPage++;drawCdr()\">下一页</button></span>";
  $("cdrPager").innerHTML = pg;
}
document.addEventListener("keydown", function(e){ if(e.key==="Enter" && $("loginWrap").style.display!=="none") doLogin(); });
setInterval(function(){ if(localStorage.getItem("_pt")) loadSip(); }, 2000);
checkAuth();
