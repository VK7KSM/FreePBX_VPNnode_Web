/* 浏览器通信控制；设备列表刷新时保留同一个媒体元素与PeerConnection。 */
window.ElfMedia=(function(){
  var active=null,lastMessage='',lastDevice='',cameraChoice={};
  function render(){if(typeof renderRemoteConsole==='function')renderRemoteConsole();}
  async function json(url,body,method){var r=await fetch(url,{method:method||'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!(r.headers.get('Content-Type')||'').includes('json'))throw Error('通信服务暂时不可用');var x=await r.json();if(!r.ok||x.ok===false)throw Error(x.msg||'通信请求失败');return x;}
  function send(s,p){if(s.ws&&s.ws.readyState===1)s.ws.send(JSON.stringify(p));}
  function rpc(s,action,body){return new Promise(function(resolve,reject){var id=++s.seq,timer=setTimeout(function(){delete s.pending[id];reject(Error('实时媒体协商超时'));},20000);s.pending[id]={resolve:resolve,reject:reject,timer:timer};send(s,{type:'rpc',id:id,action:action,body:body||{}});});}
  function ice(pc){return new Promise(function(resolve){if(pc.iceGatheringState==='complete'){resolve();return;}var done=function(){if(pc.iceGatheringState==='complete'){clearTimeout(timer);pc.removeEventListener('icegatheringstatechange',done);resolve();}},timer=setTimeout(function(){pc.removeEventListener('icegatheringstatechange',done);resolve();},7000);pc.addEventListener('icegatheringstatechange',done);});}
  async function publish(s){
    s.pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.cloudflare.com:3478'}]});
    s.remote=new MediaStream();s.pc.ontrack=function(e){if(!s.remote.getTracks().some(function(t){return t.id===e.track.id;}))s.remote.addTrack(e.track);mount(s.device);if((s.mode==='microphone'||s.mode==='video')&&!s.recorder&&s.remote.getAudioTracks().length&&(s.mode!=='video'||s.remote.getVideoTracks().length))startRecording(s).catch(function(e){stop(e.message);});};
    s.pc.onconnectionstatechange=function(){if(s.pc.connectionState==='failed')stop('媒体连接失败');if(s.pc.connectionState==='connected'){s.message='';s.started=s.started||Date.now();render();}};
    if(s.local)s.local.getTracks().forEach(function(t){s.pc.addTransceiver(t,{direction:'sendonly',streams:[s.local]});});
    await rpc(s,'new');
    if(s.local){await s.pc.setLocalDescription(await s.pc.createOffer());await ice(s.pc);var tracks=s.pc.getTransceivers().filter(function(t){return t.sender.track;}).map(function(t){return {mid:t.mid,trackName:t.sender.track.kind};});var result=await rpc(s,'publish',{sessionDescription:s.pc.localDescription.toJSON(),tracks:tracks});await s.pc.setRemoteDescription(result.sessionDescription);await rpc(s,'published');}
  }
  async function message(s,p){
    if(active!==s)return;
    if(p.type==='hello'&&s.mode!=='photo'&&s.mode!=='alarm')await publish(s);
    else if(p.type==='tracks'&&!s.subscribed){s.subscribed=true;var result=await rpc(s,'subscribe');if(result.sessionDescription){await s.pc.setRemoteDescription(result.sessionDescription);if(result.sessionDescription.type==='offer'){await s.pc.setLocalDescription(await s.pc.createAnswer());await ice(s.pc);await rpc(s,'answer',{sessionDescription:s.pc.localDescription.toJSON()});}}}
    else if(p.type==='ready'){s.started=p.started_at||Date.now();s.message='';render();}
    else if(p.type==='status'){if(p.cameras)s.cameras=p.cameras;if(p.camera){s.camera=p.camera;cameraChoice[s.device.id]=p.camera;}if(p.message)s.message=p.message;render();}
    else if(p.type==='result'&&s.mode==='photo'){
      var state=photoHistory(s.device);if(state.pending)await state.promise;state.loaded=0;state.retry=0;
      await loadReportPhotos(s.device);state.selected=p.report_id;await stop(p.message||'照片已保存');
    }
  }
  async function start(mode){
    var d=currentDev();if(!d||!d.managed_media||d.enabled===false)return;
    if(active){if(active.mode===mode)await stop();return;}
    var s={device:d,mode:mode,camera:cameraChoice[d.id]||'front',seq:0,pending:{},chain:Promise.resolve(),message:'正在连接…',started:0,parts:0,upload:Promise.resolve(),closed:false};active=s;lastMessage='';render();
    try{
      if(mode==='ptt'||mode==='call'){
        if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia)throw Error('浏览器不支持麦克风');
        s.local=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
        if(active!==s){s.local.getTracks().forEach(function(t){t.stop();});return;}
      }
      var result=await json('/api/elfremote/media/session',{device_id:d.id,mode:mode,camera:s.camera});
      if(active!==s)return;s.id=result.session_id;s.ws=new WebSocket(location.origin.replace(/^http/,'ws')+'/api/elfremote/media/browser?session_id='+s.id);
      s.ws.onmessage=function(e){var p;try{p=JSON.parse(e.data);}catch{return;}
        if(p.type==='rpc'){var wait=s.pending[p.id];if(wait){delete s.pending[p.id];clearTimeout(wait.timer);if(p.error)wait.reject(Error(p.error));else wait.resolve(p.result);}return;}
        if(p.type==='closed'){stop(p.message);return;}
        s.chain=s.chain.then(function(){return message(s,p);}).catch(function(e){stop(e.message);});
      };
      s.ws.onerror=function(){stop('通信连接失败');};s.ws.onclose=function(){if(active===s)stop('通信已结束');};
      s.timer=setInterval(function(){if(active!==s)return;var elapsed=s.started?Date.now()-s.started:0;if(mode!=='alarm'&&elapsed>=(mode==='ptt'?60000:mode==='photo'?60000:1800000)){stop();return;}send(s,{type:'ping'});updateTime(s);},1000);
    }catch(e){if(active===s)await stop(e.name==='NotAllowedError'?'未获得浏览器麦克风权限':e.message);}
  }
  async function stop(messageText){
    var s=active;if(!s)return;active=null;s.closed=true;lastDevice=s.device.id;lastMessage=messageText||'已结束';
    clearInterval(s.timer);send(s,{type:'stop'});if(s.ws)s.ws.close();Object.values(s.pending).forEach(function(p){clearTimeout(p.timer);p.reject(Error('通信已结束'));});s.pending={};
    if(s.recorder&&s.recorder.state!=='inactive'){
      s.recorder.stop();
      // 先等最后一个分段入队，再关闭远端音轨。
      await s.recordStopped;
    }
    if(s.local)s.local.getTracks().forEach(function(t){t.stop();});if(s.pc)s.pc.close();if(s.remote)s.remote.getTracks().forEach(function(t){t.stop();});
    if(s.animation)cancelAnimationFrame(s.animation);if(s.audioContext)s.audioContext.close();
    if(s.node){var el=s.node.querySelector('video,audio');if(el){el.pause();el.srcObject=null;}s.node.remove();}
    render();
    if(s.recording){try{await s.upload;if(s.uploadError)throw s.uploadError;if(!s.parts)throw Error('未收到可保存的录制数据');await json(recordUrl(s)+'&action=finish',{parts:s.parts,duration_ms:Date.now()-s.recordStarted});lastMessage='录制已保存';}catch(e){lastMessage='录制保存失败：'+e.message;}render();}
  }
  function recordUrl(s){return '/api/elfremote/media-recordings?'+new URLSearchParams({device_id:s.device.id,id:s.recording});}
  async function startRecording(s){
    if(active!==s||s.recording)return;
    if(!window.MediaRecorder)throw Error('当前浏览器不支持录制');
    var type=s.mode==='video'?'video':'audio',formats=type==='video'?['video/webm;codecs=vp8,opus','video/webm;codecs=vp9,opus','video/mp4']:['audio/webm;codecs=opus'];
    var mime=formats.find(function(m){return MediaRecorder.isTypeSupported(m);});if(!mime)throw Error('当前浏览器没有可用录制编码');
    s.recording=crypto.randomUUID();s.recordStarted=Date.now();await json(recordUrl(s)+'&action=create',{type:type,mime:mime});
    if(active!==s)return;
    s.recorder=new MediaRecorder(s.remote,{mimeType:mime,audioBitsPerSecond:32000,...(type==='video'?{videoBitsPerSecond:s.device.network==='wifi'?600000:180000}:{})});
    s.recordStopped=new Promise(function(resolve){s.recorder.onstop=resolve;});
    s.recorder.ondataavailable=function(e){if(!e.data.size)return;var blob=e.data,duration=Date.now()-s.recordStarted,index=s.parts++;s.queuedBytes=(s.queuedBytes||0)+blob.size;
      s.upload=s.upload.then(async function(){if(s.uploadError)return;for(var attempt=0;attempt<3;attempt++){
        try{var response=await fetch(recordUrl(s)+'&index='+index+'&duration_ms='+duration,{method:'PUT',body:blob,signal:AbortSignal.timeout(20000)});var result=await response.json();if(!response.ok||!result.ok)throw Error(result.msg||'上传失败');s.queuedBytes-=blob.size;return;}
        catch(error){if(attempt===2){s.uploadError=error;if(active===s)stop('录制上传中断');return;}await new Promise(function(r){setTimeout(r,1000*(attempt+1));});}
      }});
      if(s.queuedBytes>24*1024*1024&&active===s)stop('网络上传过慢，录制已结束');
    };
    s.recorder.onerror=function(){if(active===s)stop('录制失败');};s.recorder.start(5000);
  }
  function elapsed(ms){var seconds=Math.max(0,Math.floor(ms/1000));return Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');}
  function updateTime(s){if(!s.node)return;var time=s.node.querySelector('time');if(time)time.textContent=s.mode==='video'?sydney(Date.now()):s.started?elapsed(Date.now()-s.started):'';}
  function mount(d){
    var s=active;if(!s||!d||s.device.id!==d.id)return;var placeholder=document.querySelector('#remoteConsole .media-live');if(!placeholder)return;
    if(s.node&&s.node!==placeholder)placeholder.replaceWith(s.node);else if(!s.node){s.node=placeholder;
      if(s.mode==='alarm')s.node.innerHTML='<svg class="media-alarm-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 3 2 21h20L12 3Z"/><path d="M12 9v5m0 3v1"/></svg><time></time>';
      else if(s.mode==='photo')s.node.innerHTML='<span class="media-message">正在拍照…</span>';
      else{s.node.innerHTML=(s.mode==='video'?'<video autoplay playsinline></video>':'<audio autoplay></audio><canvas aria-label="音频波形"></canvas>')+'<div class="media-volume"><label>音量 <input aria-label="播放音量" type="range" min="0" max="1" step="0.01" value="1"></label><button type="button" class="traffic-link media-play" hidden>播放声音</button></div><time></time>';var input=s.node.querySelector('input');if(s.mode==='ptt')s.node.querySelector('.media-volume').hidden=true;input.oninput=function(){var el=s.node.querySelector('video,audio');el.volume=Number(input.value);};s.node.querySelector('.media-play').onclick=function(){s.node.querySelector('video,audio').play().then(function(){s.node.querySelector('.media-play').hidden=true;});};}
      if(s.mode==='video'){var button=document.createElement('button');button.className='media-camera-switch';button.type='button';button.title='切换摄像头';button.setAttribute('aria-label','切换摄像头');button.textContent='⇄';button.onclick=function(){send(s,{type:'switch'});};s.node.appendChild(button);}
    }
    var switcher=s.node.querySelector('.media-camera-switch');if(switcher)switcher.hidden=!(s.cameras>1);
    var element=s.node.querySelector('video,audio');if(element&&s.remote&&(element.srcObject!==s.remote||element.paused)){element.srcObject=s.remote;element.play().catch(function(){var button=s.node.querySelector('.media-play');if(button)button.hidden=false;});}
    if(s.node.querySelector('canvas')&&!s.audioContext&&(s.remote&&s.remote.getAudioTracks().length||s.local)){
      s.audioContext=new AudioContext();s.audioContext.resume().catch(function(){});var analyser=s.audioContext.createAnalyser();analyser.fftSize=512;s.audioContext.createMediaStreamSource(s.remote&&s.remote.getAudioTracks().length?s.remote:s.local).connect(analyser);var samples=new Uint8Array(analyser.frequencyBinCount),canvas=s.node.querySelector('canvas');canvas.width=640;canvas.height=180;var ctx=canvas.getContext('2d');
      function draw(){if(active!==s)return;analyser.getByteTimeDomainData(samples);ctx.clearRect(0,0,640,180);ctx.strokeStyle='#60a5fa';ctx.lineWidth=2;ctx.beginPath();samples.forEach(function(v,i){var x=i/samples.length*640,y=v/128*90;if(i)ctx.lineTo(x,y);else ctx.moveTo(x,y);});ctx.stroke();s.animation=requestAnimationFrame(draw);}draw();
    }
    updateTime(s);
  }
  function preview(d,fallback){if(active&&(!d||active.device.id!==d.id)){stop('已切换设备，通信结束');return fallback;}if(active)return '<div class="remote-preview media-live"></div>';if(d&&d.managed_media&&d.media_cameras>1){var at=fallback.lastIndexOf('</div>');fallback=fallback.slice(0,at)+'<button type="button" class="media-camera-switch" aria-label="切换摄像头并拍照" onclick="ElfMedia.switchPhoto()">⇄</button>'+fallback.slice(at);}return fallback;}
  function controls(d){var rows=[['ptt','PTT'],['call','电话'],['microphone','麦克风'],['photo','拍照'],['video','录像'],['alarm','响铃']];return rows.map(function(row){var selected=active&&active.mode===row[0],disabled=!d||!d.managed_media||d.enabled===false||active&&!selected;return '<button type="button" class="'+(selected?'active':'')+'" aria-pressed="'+!!selected+'" onclick="ElfMedia.start(\''+row[0]+'\')"'+(disabled?' disabled':'')+'>'+row[1]+'</button>';}).join('');}
  function feedback(d){var text=active?active.message:d&&lastDevice===d.id?lastMessage:'';return text?'<span class="media-feedback" role="status">'+esc(text)+'</span>':'';}
  window.addEventListener('pagehide',function(){stop();});
  return {switchPhoto:function(){var d=currentDev();if(!d||active)return;cameraChoice[d.id]=cameraChoice[d.id]==='back'?'front':'back';start('photo');},start:start,stop:stop,mount:mount,preview:preview,controls:controls,feedback:feedback,cameraChoice:cameraChoice};
})();
