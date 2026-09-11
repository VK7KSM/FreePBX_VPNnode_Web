// 浏览器控制器无设备命令；断线时由原页面继续HTTP查询。
export const panelEventsSource=String.raw`(function(){
  window.createPanelEvents=function(options){
    var socket=null,ready=false,retryAt=0,failures=0,lastMessage=0,lastPing=0;
    var dirty=false,refreshing=false,timer=null,startedAt=0;
    function stop(){
      var old=socket;socket=null;ready=false;dirty=false;
      if(timer!==null){clearTimeout(timer);timer=null;}
      if(old){old.onclose=old.onerror=old.onmessage=old.onopen=null;try{old.close();}catch(e){}}
    }
    function broken(){
      stop();failures=Math.min(failures+1,7);
      retryAt=Date.now()+Math.min(300000,5000*Math.pow(2,failures-1))*(1+Math.random()*.2);
    }
    function refresh(){
      if(!dirty||refreshing||!options.active())return;
      if(options.allowed && !options.allowed())return;
      dirty=false;refreshing=true;
      Promise.resolve().then(options.refresh).catch(function(){}).finally(function(){
        refreshing=false;if(dirty&&options.active())queue();
      });
    }
    function queue(){
      if(options.allowed&&!options.allowed())return;
      if(timer===null)timer=setTimeout(function(){timer=null;refresh();},200);
    }
    function changed(){dirty=true;queue();}
    function tick(){
      if(!options.active()){stop();return;}
      var now=Date.now();
      if(socket){
        if((ready&&now-lastMessage>90000)||(!ready&&now-startedAt>15000)){broken();return;}
        if(ready&&now-lastPing>=45000){try{socket.send('panel:ping');lastPing=now;}catch(e){broken();return;}}
        if(dirty)queue();return;
      }
      if(now<retryAt||(options.allowed&&!options.allowed())||typeof WebSocket==='undefined')return;
      try{
        var current=new WebSocket(location.origin.replace(/^http/,'ws')+'/api/devices/events');
        socket=current;startedAt=now;
        current.onmessage=function(event){
          if(socket!==current)return;
          lastMessage=Date.now();
          if(event.data==='panel:pong')return;
          var data;try{data=JSON.parse(event.data);}catch(e){broken();return;}
          if(data.type==='ready'){ready=true;failures=0;lastPing=lastMessage;changed();}
          else if(data.type==='changed')changed();
        };
        current.onclose=current.onerror=function(){if(socket===current)broken();};
      }catch(e){broken();}
    }
    return {tick:tick,stop:stop,connected:function(){return ready&&!!socket&&socket.readyState===1;}};
  };
})();`;
