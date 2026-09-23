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
  // 「全局设置」：电话管理与设备管理页共用，只含改密码。代理面板自己的全局设置另含 CF 优选 IP 与订阅令牌。
  state.openSettings = function() {
    var old = document.getElementById("elfGlobalSettings"); if (old) old.remove();
    var wrap = document.createElement("div");
    wrap.id = "elfGlobalSettings";
    wrap.style.cssText = "position:fixed;inset:0;background:rgba(2,6,23,.72);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px";
    var box = document.createElement("div");
    box.style.cssText = "background:#0f172a;border:1px solid #1e293b;border-radius:12px;padding:20px;width:100%;max-width:400px;color:#e2e8f0;font-size:13px";
    function el(tag, css, text) { var n = document.createElement(tag); if (css) n.style.cssText = css; if (text) n.textContent = text; return n; }
    box.appendChild(el("h3", "font-weight:700;font-size:15px;margin:0 0 12px", "全局设置"));
    box.appendChild(el("div", "color:#cbd5e1;margin-bottom:6px", "修改管理密码（代理、电话、设备三个面板共用这一个账号）"));
    function input(ph, ac) { var i = el("input", "display:block;width:100%;box-sizing:border-box;margin-bottom:8px;padding:8px 10px;border-radius:6px;border:1px solid #334155;background:#0b1220;color:#e2e8f0"); i.type = "password"; i.placeholder = ph; i.autocomplete = ac; box.appendChild(i); return i; }
    var cur = input("当前密码", "current-password"), np = input("新密码（至少 12 位）", "new-password"), np2 = input("再输一次新密码", "new-password");
    var msg = el("div", "min-height:18px;color:#f87171;margin:2px 0 10px");
    box.appendChild(msg);
    var row = el("div", "display:flex;justify-content:flex-end;gap:8px");
    var cancel = el("button", "", "取消"); cancel.className = "btn-gray";
    var ok = el("button", "", "保存"); ok.className = "btn-green";
    row.appendChild(cancel); row.appendChild(ok); box.appendChild(row);
    wrap.appendChild(box); document.body.appendChild(wrap);
    cancel.addEventListener("click", function() { wrap.remove(); });
    wrap.addEventListener("click", function(e) { if (e.target === wrap) wrap.remove(); });
    ok.addEventListener("click", function() {
      msg.textContent = "";
      if (!cur.value) { msg.textContent = "请输入当前密码"; return; }
      if (np.value.length < 12) { msg.textContent = "新密码至少 12 位"; return; }
      if (np.value !== np2.value) { msg.textContent = "两次输入的新密码不一致"; return; }
      ok.disabled = true;
      window.fetch("/api/admin/password", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_password: cur.value, new_password: np.value }) })
        .then(function(r) { return r.json().catch(function() { return { ok: false, msg: "保存失败（HTTP " + r.status + "）" }; }); })
        .then(function(d) {
          if (!d.ok) throw new Error(d.msg || "保存失败");
          wrap.remove(); alert("密码已修改，三个面板都要用新密码重新登录"); expire(); location.reload();
        }).catch(function(e) { msg.textContent = e.message; ok.disabled = false; });
    });
    cur.focus();
  };
  window.adminSession = state;
})();`;
