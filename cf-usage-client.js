// Cloudflare 官方白色标识云形部分：https://www.cloudflare.com/trademark/
const cloudflareIcon = '<svg viewBox="0 0 69 33" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M46.7823 31.6279L47.1295 30.4071C47.551 28.962 47.3939 27.6165 46.6914 26.6365C46.0467 25.7312 44.9722 25.1997 43.6662 25.1333L18.9526 24.8177C18.7873 24.8094 18.6468 24.7346 18.5641 24.61C18.4815 24.4854 18.4567 24.3193 18.5146 24.1615C18.5972 23.9207 18.8369 23.7297 19.0849 23.7214L44.0216 23.4058C46.9807 23.2729 50.1794 20.8561 51.3035 17.916L52.7251 14.1787C52.7665 14.079 52.783 13.9711 52.783 13.8631C52.783 13.805 52.7747 13.7468 52.7665 13.6887C51.163 6.38841 44.6746 0.931885 36.9299 0.931885C29.7886 0.931885 23.7218 5.56619 21.548 12.0027C20.1428 10.948 18.3492 10.3832 16.4151 10.5742C12.985 10.9147 10.2326 13.6887 9.89371 17.1353C9.80279 18.0323 9.87718 18.8877 10.0838 19.7016C4.48813 19.8678 0 24.4771 0 30.133C0 30.6479 0.0413271 31.1462 0.107451 31.6445C0.140512 31.8854 0.347148 32.0598 0.586845 32.0598L46.2037 32.0681C46.212 32.0681 46.212 32.0681 46.2203 32.0681C46.4765 32.0598 46.7079 31.8854 46.7823 31.6279Z" fill="white"/><path d="M55.0145 14.4528C54.7831 14.4528 54.5599 14.4611 54.3285 14.4694C54.2872 14.4694 54.2541 14.4777 54.221 14.4943C54.1053 14.5358 54.0061 14.6355 53.9731 14.7601L52.9978 18.132C52.5762 19.5771 52.7333 20.9225 53.4358 21.9025C54.0805 22.8078 55.155 23.3393 56.461 23.4058L61.7261 23.7214C61.8831 23.7297 62.0154 23.8044 62.098 23.929C62.1889 24.0536 62.2055 24.2197 62.1559 24.3775C62.0732 24.6183 61.8335 24.8093 61.5856 24.8177L56.1138 25.1333C53.1465 25.2744 49.9395 27.6829 48.8154 30.623L48.4187 31.6611C48.3443 31.8522 48.4848 32.0515 48.6749 32.0598C48.6832 32.0598 48.6832 32.0598 48.6915 32.0598H67.5284C67.7516 32.0598 67.9499 31.9103 68.0161 31.6944C68.3467 30.5233 68.5203 29.2942 68.5203 28.0152C68.5203 20.5322 62.47 14.4528 55.0145 14.4528Z" fill="white"/></svg>';
export const cfUsageMarkup = '<details class="cf-usage" data-cf-usage><summary aria-label="Cloudflare 服务用量"><span class="cf-usage-mark" title="Cloudflare">' + cloudflareIcon + '</span><span class="cf-usage-mini" data-cf-summary><span>Workers<b>—</b></span><span>KV<b>—</b></span><span>DO<b>—</b></span><span>R2<b>—</b></span></span><span class="cf-usage-chevron">⌄</span></summary><section class="cf-usage-pop" aria-label="Cloudflare 用量详情"><div class="cf-usage-heading"><strong>Cloudflare 用量</strong><span data-cf-time>等待更新</span></div><div data-cf-rows></div><p class="cf-usage-note" data-cf-note>账号全部项目 · 统计有延迟</p></section></details>';
export const cfUsageStyle = String.raw`
.cf-usage{position:relative;flex:none;width:232px;font-size:12px;color:#cbd5e1;align-self:center;font-family:inherit;line-height:1.4}
.cf-usage summary{display:flex;align-items:center;gap:8px;list-style:none;cursor:pointer;user-select:none;border:1px solid #263449;border-radius:8px;padding:5px 8px;background:rgba(30,41,59,.44)}
.cf-usage summary::-webkit-details-marker{display:none}.cf-usage summary:hover,.cf-usage[open] summary{border-color:#47617f;background:#1b2a3d}.cf-usage summary:focus-visible{outline:2px solid #93c5fd;outline-offset:3px}
.cf-usage-mark{display:flex;align-items:center;flex:none;width:26px}.cf-usage-mark svg{display:block;width:26px;height:16px}.cf-usage-mini{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;flex:1;min-width:0;text-align:center;font-size:10px;color:#8798af}
.cf-usage[data-warning="true"] summary{background:#462830;border-color:#75414b}.cf-usage[data-warning="true"] summary:hover,.cf-usage[data-warning="true"][open] summary{background:#542e38;border-color:#915360}.cf-usage[data-warning="true"] .cf-usage-mini{color:#c6abb1}
.cf-usage-mini b{display:block;color:#d8e4f1;font-size:11px;font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap}.cf-usage-mini b.cf-usage-warn{color:#facc15}.cf-usage-mini b.cf-usage-error{color:#fb9292}
.cf-usage-chevron{font-size:13px;color:#8394ad}.cf-usage-pop{position:absolute;right:0;top:calc(100% + 10px);width:382px;box-sizing:border-box;border:1px solid #334155;border-radius:12px;background:#101c2e;padding:18px;box-shadow:0 16px 48px #0007;z-index:80}
.cf-usage-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px}.cf-usage-heading strong{font-size:14px;font-weight:600;color:#e2e8f0}.cf-usage-heading span{font-size:10px;color:#94a3b8}
.cf-usage-group{font-size:11px;color:#8193aa;letter-spacing:.03em;margin:13px 0 5px;display:flex;justify-content:space-between}.cf-usage-row{display:grid;grid-template-columns:minmax(0,1fr) auto 48px;align-items:center;gap:10px;padding:4px 0;font-size:12px;line-height:1.5}.cf-usage-row span:first-child{color:#cbd5e1}.cf-usage-value{color:#dce7f6;white-space:nowrap;font-variant-numeric:tabular-nums}.cf-usage-percent{text-align:right;font-weight:500}.cf-usage-value.cf-usage-error{color:#fb9292}.cf-usage-value.cf-usage-warn{color:#facc15}
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
  function allowance(m){return m&&finite(m.limit)&&m.limit>0?m.limit:m&&m.id==='r2_storage'&&finite(m.freeMonthlyAverageBytes)&&m.freeMonthlyAverageBytes>0?m.freeMonthlyAverageBytes:null;}
  function ratio(m){var limit=allowance(m);return m&&finite(m.used)&&limit?m.used/limit*100:null;}
  function percent(m){var value=ratio(m);return value===null?'—':value>0&&value<.1?'<0.1%':value.toFixed(1).replace(/\.0$/,'')+'%';}
  function el(tag,text,className){var x=document.createElement(tag);if(text!=null)x.textContent=text;if(className)x.className=className;return x;}
  function stamp(value){if(!value)return '等待更新';try{return new Date(value).toLocaleTimeString('zh-CN',{timeZone:'Australia/Sydney',hour:'2-digit',minute:'2-digit',hour12:false});}catch(_){return '等待更新';}}
  function old(metric){return metric.stale||metric.period==='day'&&metric.periodKey!==new Date().toISOString().slice(0,10)||metric.period==='month'&&metric.periodKey!==new Date().toISOString().slice(0,7);}
  function color(m){var value=ratio(m);return value===null?'':value>=100?'cf-usage-error':value>70?'cf-usage-warn':'';}
  function render(data){
    current=data;mini.replaceChildren();rows.replaceChildren();
    var metrics=Array.isArray(data.metrics)?data.metrics:[],map={};metrics.forEach(function(m){map[m.id]=m;});
    box.dataset.warning=String(metrics.some(function(m){return ratio(m)>70;}));
    [['Workers','workers_requests'],['KV','kv_reads'],['DO','do_requests'],['R2','r2_storage']].forEach(function(item){
      var m=map[item[1]],holder=el('span',item[0]),value='—';
      if(item[0]==='KV'||item[0]==='DO'){var candidates=metrics.filter(function(row){return row.service===item[0]&&ratio(row)!==null;});if(candidates.length)m=candidates.reduce(function(a,b){return ratio(a)>=ratio(b)?a:b;});}
      if(m&&finite(m.used))value=percent(m);
      holder.title=m?m.label+' · '+value+(m.periodKey?' · '+m.periodKey+' UTC':' · 当前容量 / 免费月均容量参考'):item[0];
      holder.appendChild(el('b',value,color(m)));mini.appendChild(holder);
    });
    ['Workers','KV','DO','R2'].forEach(function(service){
      var group=el('div',null,'cf-usage-group'),periods=Array.from(new Set(metrics.filter(function(m){return m.service===service&&m.periodKey;}).map(function(m){return m.periodKey;})));
      group.appendChild(el('span',service));group.appendChild(el('span',service==='R2'?'UTC 月 '+periods.join(' / ')+' · 当前存储':'UTC 日 '+periods.join(' / ')));rows.appendChild(group);
      metrics.filter(function(m){return m.service===service;}).forEach(function(m){
        var row=el('div',null,'cf-usage-row'),text=m.unit==='bytes'?bytes(m.used):count(m.used);
        var limit=allowance(m);if(limit!==null)text+=' / '+(m.unit==='bytes'?bytes(limit):count(limit));
        row.title=(m.periodKey?m.periodKey+' UTC':'当前存储容量')+(old(m)?' · 上次统计':'');
        row.appendChild(el('span',m.label));row.appendChild(el('span',text,'cf-usage-value'));row.appendChild(el('span',percent(m),'cf-usage-value cf-usage-percent '+color(m)));rows.appendChild(row);
      });
    });
    var stale=data.stale||metrics.some(old)||data.generatedAt&&Date.now()-Date.parse(data.generatedAt)>1800000;
    time.textContent=(stale?'上次 ':'更新 ')+stamp(data.generatedAt);
    var message=data.status==='unconfigured'?'统计尚未配置':data.status==='pending'?'等待首次统计':data.status==='unavailable'?'统计暂不可用，保留上次数据':data.status==='partial'?'部分统计暂不可用':'';
    note.textContent=(message?message+'。':'')+(stale?'显示上次统计，所属日期见各组。':'')+'账号全部项目 · KV / DO 顶部显示最高使用比例。R2 存储按免费月均 10 GB 显示容量参考比例，不代表月均用量或费用。';
  }
  function active(){return !!(window.adminSession&&window.adminSession.authenticated);}
  function plan(delay){if(timer!==null)clearTimeout(timer);if(!disposed)timer=setTimeout(tick,delay);}
  async function tick(){
    if(disposed)return;box.hidden=!active();
    if(!active()){box.open=false;plan(5000);return;}
    if(document.hidden||pending){plan(60000);return;}
    if(Date.now()<nextAt){plan(Math.min(60000,nextAt-Date.now()));return;}
    pending=true;var retry=0,dailyQuota=false,controller=new AbortController();
    var requestTimer=setTimeout(function(){controller.abort();},20000);
    try{
      var response=await fetch('/api/cf-usage',{credentials:'same-origin',cache:'default',signal:controller.signal});
      if(!response.ok){var h=response.headers.get('Retry-After');retry=/^\d+$/.test(h||'')?Number(h)*1000:Math.max(0,Date.parse(h)-Date.now())||0;try{var failure=await response.json();dailyQuota=failure.code==='workers_quota_exceeded';}catch(_){}throw Error('统计暂不可用');}
      var data=await response.json();if(data.ok!==true||!Array.isArray(data.metrics))throw Error('统计响应无效');
      failures=0;nextAt=Date.now()+INTERVAL;render(data);
      try{sessionStorage.setItem(KEY,JSON.stringify({savedAt:Date.now(),data:data}));}catch(_){}
    }catch(_){
      failures=Math.min(failures+1,4);nextAt=Date.now()+Math.max(retry,dailyQuota?INTERVAL:INTERVAL*Math.pow(2,failures-1));
      if(current)render(Object.assign({},current,{stale:true,status:'unavailable'}));else note.textContent='统计暂不可用，稍后自动重试。';
    }finally{clearTimeout(requestTimer);pending=false;plan(60000);}
  }
  try{var saved=JSON.parse(sessionStorage.getItem(KEY)||'null');if(saved&&Array.isArray(saved.data.metrics)){render(saved.data);nextAt=saved.data.metrics.some(old)?0:Math.min(Date.now()+INTERVAL,saved.savedAt+INTERVAL);}}catch(_){}
  box.hidden=!active();
  document.addEventListener('click',function(event){if(!box.contains(event.target))box.open=false;});
  document.addEventListener('keydown',function(event){if(event.key==='Escape')box.open=false;});
  document.addEventListener('visibilitychange',function(){if(!document.hidden)tick();});
  window.addEventListener('pagehide',function(){disposed=true;if(timer!==null)clearTimeout(timer);});
  window.addEventListener('pageshow',function(event){if(event.persisted){disposed=false;tick();}});
  plan(1000);
})();`;
