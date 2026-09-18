// 单设备管理页（/m/<token>）的浏览器登录流程：显式提交登录、密码提示、被踢/退出后停在原状态不自动抢回。
export const shareSessionSource = String.raw`(function installShareSession(){
  var meta=document.querySelector('meta[name="elf-share"]');if(!meta||!window.adminSession)return;
  var token=meta.content,state=window.adminSession,nativeFetch=window.fetch;
  var kickedKey='elf-share-stop:'+token;
  function stopped(){try{return sessionStorage.getItem(kickedKey)||'';}catch(e){return '';}}
  function setStopped(reason){try{if(reason)sessionStorage.setItem(kickedKey,reason);else sessionStorage.removeItem(kickedKey);}catch(e){}}
  function showLogin(message,needsPassword){
    var wrap=document.getElementById('loginWrap');if(!wrap)return;wrap.style.display='flex';
    var user=document.getElementById('lu'),pass=document.getElementById('lp'),hint=document.getElementById('lerr'),btn=wrap.querySelector('button');
    if(user){user.value='设备管理';user.readOnly=true;user.parentElement&&(user.parentElement.style.display='none');}
    if(pass){pass.placeholder=needsPassword?'请输入此链接的密码':'';pass.parentElement&&(pass.parentElement.style.display=needsPassword?'':'none');}
    if(btn)btn.textContent=needsPassword?'登录':'重新登录';
    if(hint){hint.style.display=message?'block':'none';hint.textContent=message||'';}
  }
  function hideLogin(){var wrap=document.getElementById('loginWrap');if(wrap)wrap.style.display='none';}
  window.shareLogin=function(password){
    return nativeFetch('/api/share/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:token,password:password||''})}).then(function(r){return r.json().then(function(d){return {status:r.status,data:d};});}).then(function(x){
      if(x.data.ok){setStopped('');state.accept();hideLogin();document.title=(x.data.device_name||'设备')+' · elfRemote Manager';if(typeof window.load==='function')window.load();return true;}
      showLogin(x.data.msg||'登录失败',!!x.data.needs_password);return false;
    }).catch(function(){showLogin('服务器暂不可用，请稍后重试',false);return false;});
  };
  state.check=function(ready){
    var reason=stopped();
    if(reason){showLogin(reason==='kicked'?'已在其他页面登录，如需继续请重新登录':'已退出',false);return Promise.resolve();}
    return nativeFetch('/api/share/session',{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){
      if(d&&d.kind==='share'){state.accept();hideLogin();document.title=(d.device_name||'设备')+' · elfRemote Manager';if(typeof ready==='function')ready();return;}
      return window.shareLogin('').then(function(ok){if(ok&&typeof ready==='function')ready();});
    }).catch(function(){showLogin('服务器暂不可用，请稍后重试',false);});
  };
  state.expire=function(){if(!stopped())setStopped('kicked');showLogin('已在其他页面登录，如需继续请重新登录',false);};
  state.logout=function(){
    return nativeFetch('/api/share/logout',{method:'POST'}).then(function(){setStopped('logout');location.reload();}).catch(function(){alert('退出未完成，请重试');});
  };
  // 登录表单：复用原页面的 doLogin 入口，改为提交链接密码。
  window.shareSubmitLogin=function(){var pass=document.getElementById('lp');return window.shareLogin(pass?pass.value:'');};
  window.addEventListener('elf-share-revoked',function(){setStopped('kicked');state.expire();});
  document.addEventListener('DOMContentLoaded',function(){window.doLogin=window.shareSubmitLogin;});
})();`;
