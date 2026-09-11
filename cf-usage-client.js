export const cfUsageMarkup = '<details class="cf-usage" data-cf-usage><summary aria-label="Cloudflare 服务用量"><span class="cf-usage-mark">CF</span><span class="cf-usage-mini" data-cf-summary><span>Workers<b>—</b></span><span>KV<b>—</b></span><span>DO<b>—</b></span><span>R2<b>—</b></span></span><span class="cf-usage-chevron">⌄</span></summary><section class="cf-usage-pop" aria-label="Cloudflare 用量详情"><div class="cf-usage-heading"><strong>Cloudflare 用量</strong><span data-cf-time>等待更新</span></div><div data-cf-rows></div><p class="cf-usage-note" data-cf-note>账号全部项目 · 统计有延迟</p></section></details>';
export const cfUsageStyle = String.raw`
.cf-usage{position:relative;flex:none;width:232px;font-size:12px;color:#cbd5e1;align-self:center;font-family:inherit;line-height:1.4}
.cf-usage summary{display:flex;align-items:center;gap:8px;list-style:none;cursor:pointer;user-select:none;border:1px solid #263449;border-radius:8px;padding:5px 8px;background:rgba(30,41,59,.44)}
.cf-usage summary::-webkit-details-marker{display:none}.cf-usage summary:hover,.cf-usage[open] summary{border-color:#47617f;background:#1b2a3d}.cf-usage summary:focus-visible{outline:2px solid #93c5fd;outline-offset:3px}
.cf-usage-mark{font-size:11px;font-weight:600;color:#94a3b8}.cf-usage-mini{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;flex:1;text-align:center;font-size:10px;color:#8798af}
.cf-usage-mini b{display:block;color:#d8e4f1;font-size:11px;font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap}.cf-usage-mini b.cf-usage-warn{color:#facc15}.cf-usage-mini b.cf-usage-error{color:#fb9292}
.cf-usage-chevron{font-size:13px;color:#8394ad}.cf-usage-pop{position:absolute;right:0;top:calc(100% + 10px);width:382px;box-sizing:border-box;border:1px solid #334155;border-radius:12px;background:#101c2e;padding:18px;box-shadow:0 16px 48px #0007;z-index:80}
.cf-usage-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px}.cf-usage-heading strong{font-size:14px;font-weight:600;color:#e2e8f0}.cf-usage-heading span{font-size:10px;color:#94a3b8}
.cf-usage-group{font-size:11px;color:#8193aa;letter-spacing:.03em;margin:13px 0 5px;display:flex;justify-content:space-between}.cf-usage-row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:4px 0;font-size:12px;line-height:1.5}.cf-usage-row span:first-child{color:#cbd5e1}.cf-usage-value{color:#dce7f6;white-space:nowrap;font-variant-numeric:tabular-nums}.cf-usage-value.cf-usage-error{color:#fb9292}.cf-usage-value.cf-usage-warn{color:#facc15}
.cf-usage-note{margin:13px 0 0;padding-top:11px;border-top:1px solid #263449;color:#8fa0b7;font-size:10px;line-height:1.6}.cf-usage[hidden]{display:none}
`;
export const cfUsageClientSource = String.raw`(function(){
  'use strict';
  var box=document.querySelector('[data-cf-usage]');if(!box)return;
  var current=null,pending=false,failures=0,nextAt=0,timer=null,disposed=false;
  var KEY='cf-usage-snapshot-v1',INTERVAL=900000;
  var mini=box.querySelector('[data-cf-summary]'),rows=box.querySelector('[data-cf-rows]'),time=box.querySelector('[data-cf-time]'),note=box.querySelector('[data-cf-note]');
  function finite(v){return typeof v==='number'&&Number.isFinite(v)&&v>=0;}
  function count(v){return finite(v)?v.toLocaleString('zh-CN'):'—';}
  function bytes(v){if(!finite(v))return '—';if(v>=1e9)return (v/1e9).toFixed(1)+' GB';if(v>=1e6)return (v/1e6).toFixed(1)+' MB';if(v>=1e3)return (v/1e3).toFixed(1)+' KB';return v+' B';}
  function shortBytes(v){return finite(v)?v>=1e9?(v/1e9).toFixed(1)+'G':v>=1e6?(v/1e6).toFixed(0)+'M':bytes(v):'—';}
  function el(tag,text,className){var x=document.createElement(tag);if(text!=null)x.textContent=text;if(className)x.className=className;return x;}
  function stamp(value){if(!value)return '等待更新';try{return new Date(value).toLocaleTimeString('zh-CN',{timeZone:'Australia/Sydney',hour:'2-digit',minute:'2-digit',hour12:false});}catch(_){return '等待更新';}}
  function old(metric){return metric.stale||metric.period==='day'&&metric.periodKey!==new Date().toISOString().slice(0,10)||metric.period==='month'&&metric.periodKey!==new Date().toISOString().slice(0,7);}
  function color(m){if(!m||old(m)||!finite(m.used)||!finite(m.limit)||!m.limit)return '';return m.used>=m.limit?'cf-usage-error':m.used>=m.limit*.8?'cf-usage-warn':'';}
  function render(data){
    current=data;mini.replaceChildren();rows.replaceChildren();
    var metrics=Array.isArray(data.metrics)?data.metrics:[],map={};metrics.forEach(function(m){map[m.id]=m;});
    [['Workers','workers_requests'],['KV','kv_reads'],['DO','do_requests'],['R2','r2_storage']].forEach(function(item){
      var m=map[item[1]],holder=el('span',item[0]),value='—';
      if(m&&finite(m.used)){value=old(m)?'旧数据':m.unit==='bytes'?shortBytes(m.used):finite(m.limit)&&m.limit>0?(m.used/m.limit*100).toFixed(0)+'%':count(m.used);}
      holder.appendChild(el('b',value,color(m)));mini.appendChild(holder);
    });
    ['Workers','KV','DO','R2'].forEach(function(service){
      var group=el('div',null,'cf-usage-group');group.appendChild(el('span',service));group.appendChild(el('span',service==='R2'?'操作按 UTC 月 · 存储为当前容量':'按 UTC 日'));rows.appendChild(group);
      metrics.filter(function(m){return m.service===service;}).forEach(function(m){
        var row=el('div',null,'cf-usage-row'),text=m.unit==='bytes'?bytes(m.used):count(m.used);
        if(finite(m.limit))text+=' / '+count(m.limit);
        if(old(m))text+=' · '+(m.periodKey||'旧数据');
        row.appendChild(el('span',m.label));row.appendChild(el('span',text,'cf-usage-value '+color(m)));rows.appendChild(row);
      });
    });
    var stale=data.stale||data.generatedAt&&Date.now()-Date.parse(data.generatedAt)>1800000;
    time.textContent=(stale?'上次 ':'更新 ')+stamp(data.generatedAt);
    var message=data.status==='unconfigured'?'统计尚未配置':data.status==='pending'?'等待首次统计':data.status==='unavailable'?'统计暂不可用，保留上次数据':data.status==='partial'?'部分统计暂不可用':'';
    note.textContent=(message?message+'。':'')+'账号全部项目 · 免费方案参考额度。每日额度在悉尼 '+new Date(new Date().toISOString().slice(0,10)+'T00:00:00Z').toLocaleTimeString('zh-CN',{timeZone:'Australia/Sydney',hour:'2-digit',minute:'2-digit',hour12:false})+' 重置；R2 免费存储为月均 10 GB，当前容量不等于月账单。统计有延迟。';
  }
  function active(){return !!(window.adminSession&&window.adminSession.authenticated);}
  function plan(delay){if(timer!==null)clearTimeout(timer);if(!disposed)timer=setTimeout(tick,delay);}
  async function tick(){
    if(disposed)return;box.hidden=!active();
    if(!active()){box.open=false;plan(5000);return;}
    if(document.hidden||pending){plan(60000);return;}
    if(Date.now()<nextAt){plan(Math.min(60000,nextAt-Date.now()));return;}
    pending=true;var retry=0,dailyQuota=false;
    try{
      var response=await fetch('/api/cf-usage',{credentials:'same-origin',cache:'default'});
      if(!response.ok){var h=response.headers.get('Retry-After');retry=/^\d+$/.test(h||'')?Number(h)*1000:Math.max(0,Date.parse(h)-Date.now())||0;try{var failure=await response.json();dailyQuota=failure.code==='workers_quota_exceeded';}catch(_){}throw Error('统计暂不可用');}
      var data=await response.json();if(data.ok!==true||!Array.isArray(data.metrics))throw Error('统计响应无效');
      failures=0;nextAt=Date.now()+INTERVAL;render(data);
      try{sessionStorage.setItem(KEY,JSON.stringify({savedAt:Date.now(),data:data}));}catch(_){}
    }catch(_){
      failures=Math.min(failures+1,4);nextAt=Date.now()+Math.max(retry,dailyQuota?INTERVAL:INTERVAL*Math.pow(2,failures-1));
      if(current)render(Object.assign({},current,{stale:true,status:'unavailable'}));else note.textContent='统计暂不可用，稍后自动重试。';
    }finally{pending=false;plan(60000);}
  }
  try{var saved=JSON.parse(sessionStorage.getItem(KEY)||'null');if(saved&&Array.isArray(saved.data.metrics)){render(saved.data);nextAt=Math.min(Date.now()+INTERVAL,saved.savedAt+INTERVAL);}}catch(_){}
  box.hidden=!active();
  document.addEventListener('click',function(event){if(!box.contains(event.target))box.open=false;});
  document.addEventListener('keydown',function(event){if(event.key==='Escape')box.open=false;});
  document.addEventListener('visibilitychange',function(){if(!document.hidden)tick();});
  window.addEventListener('pagehide',function(){disposed=true;if(timer!==null)clearTimeout(timer);});
  window.addEventListener('pageshow',function(event){if(event.persisted){disposed=false;tick();}});
  plan(1000);
})();`;
