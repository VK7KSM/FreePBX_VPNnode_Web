// 浏览器源码保持为字符串，避免 Worker 打包器向函数注入外部辅助调用。
export const adminSessionSource = String.raw`(function installAdminSession() {
  var nativeFetch = window.fetch.bind(window);
  var state = { authenticated: false };
  var checkTimer=null,checkFailures=0;
  function expire() {
    state.authenticated = false;
    var form = document.getElementById("loginWrap");
    if (form) form.style.display = "flex";
  }
  try { localStorage.removeItem("_pt"); } catch (_) {}
  window.fetch = function(input, options) {
    return nativeFetch(input, options).then(function(response) {
      var url = new URL(typeof input === "string" ? input : input.url, location.href);
      if (url.origin === location.origin && url.pathname.indexOf("/api/") === 0 && response.status === 401) {
        expire();
        if (url.pathname !== "/api/login" && url.pathname !== "/api/session") throw new Error("登录已失效");
      }
      return response;
    });
  };
  state.check = function(ready) {
    if(checkTimer!==null){clearTimeout(checkTimer);checkTimer=null;}
    var wait=0;
    function later(){
      checkTimer=setTimeout(function(){checkTimer=null;if(document.hidden){later();return;}state.check(ready);},wait);
    }
    return window.fetch("/api/session", { cache: "no-store" }).then(function(r) {
      if(r.status===401){expire();return null;}
      if(!r.ok){wait=Math.min(900000,Math.max(60000,(Number(r.headers.get('Retry-After'))||0)*1000));throw Error('service unavailable');}
      return r.json();
    }).then(function(d) {
      if(!d)return;
      if(d.ok!==true)throw Error('invalid session response');
      state.authenticated=true;checkFailures=0;
      document.getElementById("loginWrap").style.display="none";
      var hint=document.getElementById('lerr');if(hint)hint.style.display='none';
      ready();
    }).catch(function(){
      var hint=document.getElementById('lerr');if(hint){hint.style.display='block';hint.textContent='服务器暂不可用，恢复后自动重试。';}
      wait=wait||Math.min(900000,60000*Math.pow(2,Math.min(checkFailures++,4)));
      later();
    });
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
