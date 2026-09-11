// 浏览器源码保持为字符串，避免 Worker 打包器向函数注入外部辅助调用。
export const adminSessionSource = String.raw`(function installAdminSession() {
  var nativeFetch = window.fetch.bind(window);
  var state = { authenticated: false };
  var checkTimer=null,checkFailures=0,checkPromise=null,checkCallbacks=[];
  function retryDelay(value){
    var seconds=Number(value);if(value&&Number.isFinite(seconds))return Math.max(0,seconds*1000);
    var date=Date.parse(value);return Number.isFinite(date)?Math.max(0,date-Date.now()):0;
  }
  function cloudflareQuota(response){
    if(response.status!==429||!/^text\/html(?:\s*;|$)/i.test(response.headers.get('Content-Type')||''))return response;
    return response.clone().text().then(function(html){
      var text=html.slice(0,131072).replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/gi,' ');
      if(!/\bcloudflare\b/i.test(text)||! /\berror\s*(?:code\s*)?:?\s*1027\b/i.test(text))return response;
      var now=Date.now(),reset=(Math.floor(now/86400000)+1)*86400000,provided=retryDelay(response.headers.get('Retry-After'));
      var retry=provided>0?now+provided:Math.min(reset,now+900000),headers=new Headers(response.headers);
      headers.set('Content-Type','application/json; charset=utf-8');headers.set('Cache-Control','no-store');
      if(!(provided>0))headers.set('Retry-After',String(Math.max(1,Math.ceil((retry-now)/1000))));
      headers.delete('Content-Length');headers.delete('Content-Encoding');
      return new Response(JSON.stringify({ok:false,code:'workers_quota_exceeded',msg:'CF Workers 日请求额度已用尽，等待恢复',retry_at:new Date(retry).toISOString(),reset_at:new Date(reset).toISOString()}),{status:429,headers:headers});
    }).catch(function(){return response;});
  }
  function expire() {
    state.authenticated = false;
    var form = document.getElementById("loginWrap");
    if (form) form.style.display = "flex";
  }
  try { localStorage.removeItem("_pt"); } catch (_) {}
  window.fetch = function(input, options) {
    return nativeFetch(input, options).then(function(response) {
      var url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, location.href);
      var localApi=url.origin===location.origin&&url.pathname.indexOf('/api/')===0;
      if (localApi && response.status === 401) {
        expire();
        if (url.pathname !== "/api/login" && url.pathname !== "/api/session") throw new Error("登录已失效");
      }
      if(localApi)return cloudflareQuota(response);
      return response;
    });
  };
  state.check = function(ready) {
    if(typeof ready==='function'&&checkCallbacks.indexOf(ready)<0)checkCallbacks.push(ready);
    if(checkPromise)return checkPromise;
    if(checkTimer!==null){clearTimeout(checkTimer);checkTimer=null;}
    var wait=0;
    function later(){
      checkTimer=setTimeout(function(){checkTimer=null;if(document.hidden){later();return;}state.check(ready);},wait);
    }
    checkPromise=window.fetch("/api/session", { cache: "no-store" }).then(function(r) {
      if(r.status===401){expire();checkCallbacks=[];return null;}
      if(!r.ok){wait=retryDelay(r.headers.get('Retry-After'));throw Error('service unavailable');}
      return r.json();
    }).then(function(d) {
      if(!d)return;
      if(d.ok!==true)throw Error('invalid session response');
      state.authenticated=true;checkFailures=0;
      document.getElementById("loginWrap").style.display="none";
      var hint=document.getElementById('lerr');if(hint)hint.style.display='none';
      var callbacks=checkCallbacks;checkCallbacks=[];callbacks.forEach(function(callback){callback();});
    }).catch(function(){
      var hint=document.getElementById('lerr');if(hint){hint.style.display='block';hint.textContent='服务器暂不可用，恢复后自动重试。';}
      wait=Math.min(2147483647,Math.max(wait,Math.min(900000,60000*Math.pow(2,Math.min(checkFailures++,4)))));
      later();
    }).finally(function(){checkPromise=null;});
    return checkPromise;
  };
  state.accept = function() { state.authenticated = true; };
  state.expire = expire;
  state.logout = function() {
    return window.fetch("/api/logout", { method: "POST" }).then(function(r) {
      if (!r.ok) throw new Error("退出失败");
      if(checkTimer!==null){clearTimeout(checkTimer);checkTimer=null;}expire(); location.href = "/";
    }).catch(function() { alert("退出未完成，请重试"); });
  };
  window.adminSession = state;
})();`;
