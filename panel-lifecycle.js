// 版本文件由静态资源服务直接返回，不消耗 Worker 请求。保留表单和正在进行的会话。
export const panelLifecycleSource=String.raw`(function(){
  var pending=false,next=0,failures=0,changed=false,disposed=false;
  async function check(){
    if(disposed||changed||pending||document.hidden||!window.adminSession||!adminSession.authenticated||Date.now()<next)return;
    var meta=document.querySelector('meta[name="elf-panel-version"]');
    if(!meta||!meta.content||meta.content==='__ELF_PANEL_VERSION__')return;
    pending=true;next=Date.now()+300000;
    try{
      var r=await fetch('/panel-version.json',{cache:'no-cache'});if(!r.ok)throw Error('version');
      var x=await r.json();if(typeof x.version!=='string'||!x.version)throw Error('version');
      failures=0;if(x.version===meta.content)return;changed=true;
      var exit=document.querySelector('header button[onclick="logout()"]');if(!exit)return;
      var button=document.createElement('button');button.type='button';button.className='btn-gray';button.textContent='新版页面 · 刷新';
      button.style.cssText='font-size:11px;white-space:nowrap;color:#f5c451';
      button.title='完成当前操作后刷新，载入最新页面';button.onclick=function(){location.reload();};exit.before(button);
    }catch(e){failures++;next=Date.now()+Math.min(1800000,300000*Math.pow(2,Math.min(3,failures-1)));}
    finally{pending=false;}
  }
  setInterval(check,30000);document.addEventListener('visibilitychange',check);window.addEventListener('pagehide',function(){disposed=true;});window.addEventListener('pageshow',function(event){if(event.persisted){disposed=false;check();}});
})();`;
