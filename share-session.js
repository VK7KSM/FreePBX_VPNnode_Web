// 单设备管理页（/m/<token>）的浏览器登录流程：显式提交登录、密码提示、被踢/退出后停在原状态不自动抢回。
export const shareSessionSource = String.raw`(function installShareSession(){
  var meta=document.querySelector('meta[name="elf-share"]');if(!meta||!window.adminSession)return;
  var token=meta.content,state=window.adminSession,nativeFetch=window.fetch;
  document.documentElement.classList.add('share-mode');
  function setName(name){document.title=(name||'设备')+' · elfRemote Manager';var el=document.getElementById('shareDeviceName');if(el)el.textContent=name||'设备';}
  var kickedKey='elf-share-stop:'+token;
  function stopped(){try{return sessionStorage.getItem(kickedKey)||'';}catch(e){return '';}}
  function setStopped(reason){try{if(reason)sessionStorage.setItem(kickedKey,reason);else sessionStorage.removeItem(kickedKey);}catch(e){}}
  function ended(reason,withToken){location.replace('/m/ended?r='+encodeURIComponent(reason)+(withToken?'&t='+encodeURIComponent(token):''));}
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
      if(x.data.ok){setStopped('');try{sessionStorage.setItem(seenKey,'1');}catch(e){}state.accept();hideLogin();setName(x.data.device_name);if(window.panelEvents&&window.panelEvents.reset)setTimeout(function(){window.panelEvents.reset();},50);if(typeof window.loadDevices==='function')window.loadDevices();return true;}
      if(x.status===404||/失效|不存在/.test(x.data.msg||'')){ended('invalid');return false;}
      showLogin(x.data.msg||'登录失败',!!x.data.needs_password);return false;
    }).catch(function(){showLogin('服务器暂不可用，请稍后重试',false);return false;});
  };
  var seenKey='elf-share-seen:'+token;
  function seen(){try{return !!sessionStorage.getItem(seenKey);}catch(e){return false;}}
  state.check=function(ready){
    var reason=stopped();
    if(reason){ended(reason==='logout'?'logout':'kicked',reason!=='logout');return Promise.resolve();}
    return nativeFetch('/api/share/session',{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){
      if(d&&d.kind==='share'){try{sessionStorage.setItem(seenKey,'1');}catch(e){}state.accept();hideLogin();setName(d.device_name);if(typeof ready==='function')ready();return;}
      // 本标签页曾登录成功而服务器已无会话：是被踢或到期，不自动抢回，等用户点“重新登录”。
      if(seen()){setStopped('kicked');ended('kicked',true);return;}
      return window.shareLogin('').then(function(ok){if(ok&&typeof ready==='function')ready();});
    }).catch(function(){showLogin('服务器暂不可用，请稍后重试',false);});
  };
  state.expire=function(){if(!stopped())setStopped('kicked');ended(stopped()==='revoked'?'revoked':'kicked',stopped()!=='revoked');};
  state.logout=function(){
    if(!confirm('确定退出本设备管理页？退出后需要重新打开链接才能进入。'))return Promise.resolve();
    return nativeFetch('/api/share/logout',{method:'POST'}).then(function(){setStopped('logout');try{sessionStorage.removeItem(seenKey);}catch(e){}ended('logout');}).catch(function(){alert('退出未完成，请重试');});
  };
  // 登录表单：复用原页面的 doLogin 入口，改为提交链接密码。
  window.shareSubmitLogin=function(){var pass=document.getElementById('lp');return window.shareLogin(pass?pass.value:'');};
  window.addEventListener('elf-share-revoked',function(e){var r=e&&e.detail&&e.detail.reason;if(r==='revoked'){setStopped('revoked');ended('revoked');return;}if(r==='logout'){setStopped('logout');ended('logout');return;}setStopped('kicked');ended('kicked',true);});
  document.addEventListener('DOMContentLoaded',function(){window.doLogin=window.shareSubmitLogin;});
  // 偶发 401（例如部署瞬间）不应把独立页打回管理员登录框：先向服务器确认会话，仍有效就恢复，确实失效才按被踢处理。
  var rechecking=null;
  function recheck(){
    if(rechecking)return rechecking;
    rechecking=nativeFetch('/api/share/session',{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){
      if(d&&d.kind==='share'){state.accept();hideLogin();return true;}
      setStopped('kicked');ended('kicked',true);return false;
    }).catch(function(){return false;}).finally(function(){rechecking=null;});
    return rechecking;
  }
  var wrapped=window.fetch;
  window.fetch=function(input,options){
    return wrapped(input,options).catch(function(e){
      if(e&&e.message==='登录已失效'){recheck();}
      throw e;
    });
  };
})();`;
