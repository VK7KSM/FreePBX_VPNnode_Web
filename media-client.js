/* 浏览器通信控制；设备列表刷新时保留同一个媒体元素与PeerConnection。 */
window.ElfMedia=(function(){
  var active=null,lastMessage='',lastDevice='',cameraChoice={};
  function inputChoice(){try{return localStorage.getItem('elf-media-input')||'';}catch{return '';}}
  function audioConstraints(){var id=inputChoice();return {audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,...(id?{deviceId:{exact:id}}:{})},video:false};}
  async function acquireLocalAudio(){try{return await navigator.mediaDevices.getUserMedia(audioConstraints());}catch(e){if(!inputChoice()||!['NotFoundError','OverconstrainedError'].includes(e.name))throw e;try{localStorage.removeItem('elf-media-input');}catch{}return navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});}}
  async function listInputs(s){if(!navigator.mediaDevices?.enumerateDevices)return;try{s.inputs=(await navigator.mediaDevices.enumerateDevices()).filter(function(d){return d.kind==='audioinput';});if(active===s)mount(s.device);}catch{}}
  async function changeInput(s,id){
    var activation=s.activation,generation=(s.inputGeneration||0)+1;s.inputGeneration=generation;
    try{
      var stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,...(id?{deviceId:{exact:id}}:{})},video:false});
      if(active!==s||s.mode==='stopping'||s.mode==='prepare'||s.activation!==activation||s.inputGeneration!==generation){stream.getTracks().forEach(function(t){t.stop();});return;}
      var sender=s.uplink||s.pc.getSenders().find(function(t){return t.track?.kind==='audio';});
      if(!sender){stream.getTracks().forEach(function(t){t.stop();});throw Error('本机音频通道未就绪');}
      await sender.replaceTrack(stream.getAudioTracks()[0]);
      if(active!==s||s.mode==='stopping'||s.mode==='prepare'||s.activation!==activation||s.inputGeneration!==generation){stream.getTracks().forEach(function(t){t.stop();});return;}
      var old=s.local;s.local=stream;if(old)old.getTracks().forEach(function(t){t.stop();});try{localStorage.setItem('elf-media-input',id);}catch{}mount(s.device);
    }catch(e){if(active===s){s.message='麦克风切换失败：'+e.message;render();}}
  }
  function render(){if(typeof renderRemoteConsole==='function')renderRemoteConsole();}
  async function json(url,body,method){var r;try{r=await fetch(url,{method:method||'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});}catch(e){if(e.name==='TimeoutError')throw Error('通信请求超时，请重试');throw e;}if(!(r.headers.get('Content-Type')||'').includes('json'))throw Error('通信服务暂时不可用');var x=await r.json();if(!r.ok||x.ok===false)throw Error(x.msg||'通信请求失败');return x;}
  function send(s,p){if(s.ws&&s.ws.readyState===1)s.ws.send(JSON.stringify(p));}
  function rpc(s,action,body){return new Promise(function(resolve,reject){var id=++s.seq,timer=setTimeout(function(){delete s.pending[id];reject(Error('实时媒体协商超时'));},20000);s.pending[id]={resolve:resolve,reject:reject,timer:timer};send(s,{type:'rpc',id:id,action:action,body:body||{}});});}
  function updateReady(s){
    if(s.prepared&&s.mode==='stopping')return;
    if(active===s&&s.prepared&&s.mode==='prepare'){
      if(!s.transportReady&&s.transportDeviceReady&&s.published&&s.subscribed&&s.pc?.connectionState==='connected'){
        s.transportReady=true;s.message='';render();
      }return;
    }
    if(active!==s||!s.deviceReady)return;
    if(s.mode!=='photo'&&s.mode!=='alarm'&&s.pc?.connectionState!=='connected')return;
    if(s.mode==='call'&&(!s.published||!s.subscribed||!s.remote?.getAudioTracks().some(function(t){return t.readyState==='live';})))return;
    s.started=s.started||Date.now();s.message='';render();
  }
  async function publish(s){
    s.pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.cloudflare.com:3478'}]});
    s.remote=new MediaStream();s.pc.ontrack=function(e){if(!s.remote.getTracks().some(function(t){return t.id===e.track.id;}))s.remote.addTrack(e.track);mount(s.device);updateReady(s);maybeRecord(s);};
    s.pc.onconnectionstatechange=function(){if(active!==s)return;if(s.pc.connectionState==='failed')stop('媒体连接失败',true);if(s.pc.connectionState==='connected'){updateReady(s);render();maybeRecord(s);}};
    if(s.local)s.local.getTracks().forEach(function(t){s.pc.addTransceiver(t,{direction:'sendonly',streams:[s.local]});});
    if(s.prepared)s.uplink=s.pc.addTransceiver(s.silentTrack,{direction:'sendonly'}).sender;
    await rpc(s,'new');
    if(s.local||s.prepared){await s.pc.setLocalDescription(await s.pc.createOffer());var tracks=s.pc.getTransceivers().filter(function(t){return t.sender.track||s.prepared&&t.sender===s.uplink;}).map(function(t){return {mid:t.mid,trackName:t.sender.track?.kind||'audio'};});var result=await rpc(s,'publish',{sessionDescription:s.pc.localDescription.toJSON(),tracks:tracks});await s.pc.setRemoteDescription(result.sessionDescription);await rpc(s,'published');s.published=true;updateReady(s);}
  }
  async function message(s,p){
    if(active!==s)return;
    if(s.prepared&&['ready','status','result','photo_preview','idle','stopping'].includes(p.type)&&p.operation!==s.operation)return;
    if(s.prepared&&s.mode==='stopping'&&['ready','status','result','photo_preview'].includes(p.type))return;
    if(p.type==='transport_ready'&&s.prepared){s.transportDeviceReady=true;updateReady(s);return;}
    if(p.type==='idle'&&s.prepared){s.idleAcknowledged=true;preparedIdle(s);return;}
    if(p.type==='stopping'&&s.prepared){await stopPrepared(s,p.message);return;}
    if(p.type==='photo_preview'&&s.prepared&&s.mode==='photo'){
      s.previewPhoto=p;s.message='';mount(s.device);render();return;
    }
    if(p.type==='hello'&&s.mode!=='photo'&&s.mode!=='alarm')await publish(s);
    else if(p.type==='tracks'&&!s.subscribing){s.subscribing=true;var result=await rpc(s,'subscribe');if(result.sessionDescription){await s.pc.setRemoteDescription(result.sessionDescription);if(result.sessionDescription.type==='offer'){await s.pc.setLocalDescription(await s.pc.createAnswer());await rpc(s,'answer',{sessionDescription:s.pc.localDescription.toJSON()});}}s.subscribed=true;updateReady(s);}
    else if(p.type==='ready'){s.deviceReady=true;updateReady(s);render();maybeRecord(s);}
    else if(p.type==='status'){if(p.cameras)s.cameras=p.cameras;if(p.camera){s.camera=p.camera;cameraChoice[s.device.id]=p.camera;}if(p.message)s.message=p.message;render();}
    else if(p.type==='result'&&s.mode==='photo'){
      var state=photoHistory(s.device);if(state.pending)await state.promise;state.loaded=0;state.retry=0;
      await loadReportPhotos(s.device);state.selected=p.report_id;await stop(p.message||'照片已保存');
    }
  }
  async function start(mode,requestedCamera){
    var d=currentDev();if(!d||!ElfMediaCapabilities.allows(d,mode))return;
    // 新协议只能由标题栏连接入口建立；旧客户端在升级前保留原协议。
    if(d.managed_media_prepare_v1===true&&mode!=='prepare'&&(!active||active.device.id!==d.id||!active.transportReady))return;
    if(active&&active.prepared&&active.device.id===d.id&&active.mode==='prepare'&&mode!=='prepare'){
      if(!active.transportReady)return;
      await activatePrepared(active,mode,requestedCamera);return;
    }
    if(active){if(active.mode===mode)await stop();return;}
    if(typeof trajectoryReturnLive==='function')trajectoryReturnLive();
    var s={device:d,mode:mode,camera:requestedCamera||'front',seq:0,pending:{},chain:Promise.resolve(),message:'正在连接…',started:0,parts:0,upload:Promise.resolve(),closed:false,prepared:mode==='prepare',operation:0};active=s;lastMessage='';render();
    try{
      if(mode==='prepare'){
        s.transportAudioContext=new AudioContext({latencyHint:'interactive'});await s.transportAudioContext.resume();
        if(active!==s)return;
        var silentDestination=s.transportAudioContext.createMediaStreamDestination();s.silentSource=s.transportAudioContext.createConstantSource();s.silentSource.offset.value=0;s.silentSource.connect(silentDestination);s.silentSource.start();s.silentTrack=silentDestination.stream.getAudioTracks()[0];
      }
      if(mode!=='photo'&&mode!=='alarm'&&mode!=='prepare'){s.audioContext=new AudioContext({latencyHint:'interactive'});await s.audioContext.resume();}
      if(mode==='ptt'||mode==='call'){
        if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia)throw Error('浏览器不支持麦克风');
        s.local=await acquireLocalAudio();
        if(active!==s){s.local.getTracks().forEach(function(t){t.stop();});return;}
        listInputs(s);
      }
      mount(d);
      var result=await json('/api/elfremote/media/session',{device_id:d.id,mode:mode,camera:s.camera});
      if(active!==s){if(result.session_id)await json('/api/elfremote/media/session',{session_id:result.session_id},'DELETE').catch(function(){});return;}s.id=result.session_id;s.ws=new WebSocket(location.origin.replace(/^http/,'ws')+'/api/elfremote/media/browser?session_id='+s.id);
      s.ws.onmessage=function(e){if(active!==s)return;var p;try{p=JSON.parse(e.data);}catch{return;}
        if(p.type==='rpc'){var wait=s.pending[p.id];if(wait){delete s.pending[p.id];clearTimeout(wait.timer);if(p.error)wait.reject(Error(p.error));else wait.resolve(p.result);}return;}
        if(p.type==='closed'){stop(p.message,true);return;}
        if(p.type==='status'&&String(p.message||'').startsWith('通信失败')){stop(p.message,true);return;}
        s.chain=s.chain.then(function(){return message(s,p);}).catch(function(e){if(active===s)stop(e.message,true);});
      };
      s.ws.onerror=function(){if(active===s)stop('通信连接失败',true);};s.ws.onclose=function(){if(active===s)stop('通信已结束',true);};
      s.timer=setInterval(function(){if(active!==s)return;var elapsed=s.started?Date.now()-s.started:0;if(s.mode!=='alarm'&&elapsed>=(s.mode==='ptt'?60000:s.mode==='photo'?60000:1800000)){stop();return;}if(!s.lastPing||Date.now()-s.lastPing>=15000){send(s,{type:'ping'});s.lastPing=Date.now();}updateTime(s);},1000);
    }catch(e){if(active===s)await stop(e.name==='NotAllowedError'?'未获得浏览器麦克风权限':e.message,true);}
  }
  async function activatePrepared(s,mode,camera){
    if(active!==s||s.mode!=='prepare'||!s.transportReady)return;
    var operation=s.operation+1,activation={operation:operation};s.activation=activation;
    s.mode=mode;s.camera=camera||'front';s.started=0;s.deviceReady=false;s.previewPhoto=null;s.message='正在启动…';s.parts=0;s.queuedBytes=0;s.upload=Promise.resolve();s.uploadError=null;s.recording=null;s.recorder=null;s.recordCreating=null;s.finishComplete=false;s.idleAcknowledged=false;s.activationSent=false;s.clickedAt=performance.now();render();
    function cancelled(){return active!==s||s.closed||s.activation!==activation||s.mode!==mode;}
    try{
      if(mode!=='photo'&&mode!=='alarm'){s.audioContext=new AudioContext({latencyHint:'interactive'});await s.audioContext.resume();}
      if(cancelled())return;
      if(mode==='ptt'||mode==='call'){
        var local=await acquireLocalAudio();
        if(cancelled()){local.getTracks().forEach(function(t){t.stop();});return;}
        s.local=local;await s.uplink.replaceTrack(local.getAudioTracks()[0]);listInputs(s);
      }
      if(cancelled())return;
      s.operation=operation;s.activationSent=true;mount(s.device);send(s,{type:'activate',operation:operation,mode:mode,camera:s.camera});
    }catch(e){if(!cancelled())await stop(e.name==='NotAllowedError'?'未获得浏览器麦克风权限':e.message,true);}
  }
  function preparedIdle(s){if(active!==s||!s.idleAcknowledged||!s.finishComplete)return;s.mode='prepare';s.message='';s.started=0;s.deviceReady=false;render();}
  async function stopPrepared(s,messageText){
    if(s.mode==='stopping'||s.mode==='prepare')return;
    s.activation=null;s.mode='stopping';s.message='正在结束…';s.recordEnded=Date.now();
    if(s.activationSent)send(s,{type:'deactivate',operation:s.operation});else s.idleAcknowledged=true;
    if(s.local){s.local.getTracks().forEach(function(t){t.stop();});s.local=null;}await s.uplink.replaceTrack(s.silentTrack);
    if(s.recordCreating)await s.recordCreating;
    if(s.recorder&&s.recorder.state!=='inactive'){s.recorder.stop();await s.recordStopped;}
    if(s.animation)cancelAnimationFrame(s.animation);s.animation=null;
    if(s.audioContext)await s.audioContext.close();s.audioContext=null;s.audioInput=null;s.audioInputTrack=null;s.outputGain=null;
    if(s.node){var el=s.node.querySelector('video,audio');if(el){el.pause();el.srcObject=null;}s.node.remove();s.node=null;}
    lastDevice=s.device.id;lastMessage=messageText||'已结束';
    if(s.recording){try{await s.upload;if(s.uploadError)throw s.uploadError;if(!s.parts)throw Error('未收到可保存的录制数据');await json(recordUrl(s)+'&action=finish',{parts:s.parts,duration_ms:s.recordEnded-s.recordStarted});lastMessage='录制已保存';}catch(e){lastMessage='录制保存失败：'+e.message;}}
    s.recording=null;s.recorder=null;s.recordCreating=null;s.finishComplete=true;preparedIdle(s);render();
  }
  async function stop(messageText,shutdown){
    if(active?.prepared&&!shutdown&&active.mode!=='prepare')return stopPrepared(active,messageText).catch(function(e){return stop(e.message,true);});
    var s=active;if(!s)return;active=null;s.closed=true;s.recordEnded=Date.now();lastDevice=s.device.id;lastMessage=messageText||'已结束';
    clearInterval(s.timer);send(s,{type:'stop'});if(s.ws)s.ws.close();Object.values(s.pending).forEach(function(p){clearTimeout(p.timer);p.reject(Error('通信已结束'));});s.pending={};
    if(s.recordCreating)await s.recordCreating.catch(function(){});
    if(s.recorder&&s.recorder.state!=='inactive'){
      s.recorder.stop();
      // 先等最后一个分段入队，再关闭远端音轨。
      await s.recordStopped;
    }
    if(s.local)s.local.getTracks().forEach(function(t){t.stop();});if(s.pc)s.pc.close();if(s.remote)s.remote.getTracks().forEach(function(t){t.stop();});
    if(s.silentSource)s.silentSource.stop();if(s.silentTrack)s.silentTrack.stop();if(s.transportAudioContext)await s.transportAudioContext.close();
    if(s.animation)cancelAnimationFrame(s.animation);if(s.audioContext)s.audioContext.close();
    if(s.node){var el=s.node.querySelector('video,audio');if(el){el.pause();el.srcObject=null;}s.node.remove();}
    render();
    if(s.recording){try{await s.upload;if(s.uploadError)throw s.uploadError;if(!s.parts)throw Error('未收到可保存的录制数据');await json(recordUrl(s)+'&action=finish',{parts:s.parts,duration_ms:s.recordEnded-s.recordStarted});lastMessage='录制已保存';}catch(e){lastMessage='录制保存失败：'+e.message;}render();}
  }
  function recordUrl(s){return '/api/elfremote/media-recordings?'+new URLSearchParams({device_id:s.device.id,id:s.recording});}
  function maybeRecord(s){if(active===s&&s.deviceReady&&s.pc?.connectionState==='connected'&&(s.mode==='microphone'||s.mode==='video')&&!s.recording&&!s.recordCreating&&s.remote.getAudioTracks().length&&(s.mode!=='video'||s.remote.getVideoTracks().length)){s.recordCreating=startRecording(s);s.recordCreating.catch(function(e){if(active===s)stop(e.message);});}}
  async function startRecording(s){
    if(active!==s||s.recording)return;
    if(!window.MediaRecorder)throw Error('当前浏览器不支持录制');
    var type=s.mode==='video'?'video':'audio',formats=type==='video'?['video/webm;codecs=vp8,opus','video/webm;codecs=vp9,opus','video/mp4']:['audio/webm;codecs=opus'];
    var mime=formats.find(function(m){return MediaRecorder.isTypeSupported(m);});if(!mime)throw Error('当前浏览器没有可用录制编码');
    s.recording=crypto.randomUUID();s.recordStarted=Date.now();await json(recordUrl(s)+'&action=create',{type:type,mime:mime});
    if(active!==s||s.mode==='stopping')return;
    s.recorder=new MediaRecorder(type==='audio'?new MediaStream(s.remote.getAudioTracks()):s.remote,{mimeType:mime,audioBitsPerSecond:32000,...(type==='video'?{videoBitsPerSecond:s.device.network==='wifi'?600000:180000}:{})});
    s.recordStopped=new Promise(function(resolve){s.recorder.onstop=resolve;});
    s.recorder.ondataavailable=function(e){if(!e.data.size)return;var blob=e.data,duration=Date.now()-s.recordStarted,index=s.parts++;s.queuedBytes=(s.queuedBytes||0)+blob.size;
      s.upload=s.upload.then(async function(){if(s.uploadError)return;for(var attempt=0;attempt<3;attempt++){
        try{var response=await fetch(recordUrl(s)+'&index='+index+'&duration_ms='+duration+'&captured_at='+s.recordStarted,{method:'PUT',body:blob,signal:AbortSignal.timeout(20000)});var result=await response.json();if(!response.ok||!result.ok)throw Error(result.msg||'上传失败');s.queuedBytes-=blob.size;return;}
        catch(error){if(attempt===2){s.uploadError=error;if(active===s)stop('录制上传中断');return;}await new Promise(function(r){setTimeout(r,1000*(attempt+1));});}
      }});
      if(s.queuedBytes>24*1024*1024&&active===s)stop('网络上传过慢，录制已结束');
    };
    s.recorder.onstart=function(){s.recordStarted=Date.now();};
    s.recorder.onerror=function(){if(active===s)stop('录制失败');};s.recordStarted=Date.now();s.recorder.start(5000);
  }
  function elapsed(ms){var seconds=Math.max(0,Math.floor(ms/1000));return Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');}
  function updateTime(s){if(!s.node)return;var time=s.node.querySelector('time');if(time)time.textContent=s.mode==='photo'&&s.previewPhoto?sydney(s.previewPhoto.captured_at):s.mode==='video'?sydney(Date.now()):s.started?elapsed(Date.now()-s.started):'';}
  function mount(d){
    var s=active;if(!s||s.mode==='prepare'||s.mode==='stopping'||!d||s.device.id!==d.id)return;var placeholder=document.querySelector('#remoteConsole .media-live');if(!placeholder)return;
    if(s.node&&s.node!==placeholder)placeholder.replaceWith(s.node);else if(!s.node){s.node=placeholder;
      if(s.mode==='alarm')s.node.innerHTML='<svg class="media-alarm-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 3 2 21h20L12 3Z"/><path d="M12 9v5m0 3v1"/></svg><time></time>';
      else if(s.mode==='photo')s.node.innerHTML='<span class="media-message">正在拍照…</span>';
      else{s.node.innerHTML=(s.mode==='video'?'<video autoplay playsinline></video>':'<audio autoplay></audio><canvas aria-label="音频波形"></canvas>')+'<div class="media-volume"><label>音量 <input aria-label="播放音量" type="range" min="0" max="1" step="0.01" value="1"></label><button type="button" class="traffic-link media-play" hidden>播放声音</button></div><time></time>';var input=s.node.querySelector('input');if(s.mode==='ptt')s.node.querySelector('.media-volume').hidden=true;input.oninput=function(){var el=s.node.querySelector('video,audio');if(s.outputGain)s.outputGain.gain.value=Number(input.value);else el.volume=Number(input.value);};s.node.querySelector('.media-play').onclick=function(){Promise.all([s.audioContext?s.audioContext.resume():Promise.resolve(),s.node.querySelector('video,audio').play()]).then(function(){s.node.querySelector('.media-play').hidden=true;});};}
      if(s.mode==='video'){var button=document.createElement('button');button.className='media-camera-switch';button.type='button';button.title='切换摄像头';button.setAttribute('aria-label','切换摄像头');button.textContent='⇄';button.onclick=function(){send(s,{type:'switch',...(s.prepared?{operation:s.operation}:{})});};s.node.appendChild(button);}
    }
    var switcher=s.node.querySelector('.media-camera-switch');if(switcher)switcher.hidden=!(s.cameras>1);
    if((s.mode==='ptt'||s.mode==='call')&&s.inputs?.length){
      var selector=s.node.querySelector('.media-input-select');
      if(!selector){var label=document.createElement('label');label.className='media-input';label.textContent='本机麦克风 ';selector=document.createElement('select');selector.className='media-input-select';selector.setAttribute('aria-label','本机麦克风');label.appendChild(selector);s.node.appendChild(label);selector.onchange=function(){changeInput(s,selector.value);};}
      var selected=s.local?.getAudioTracks()[0]?.getSettings?.().deviceId||inputChoice();
      var choices=s.inputs.map(function(d){return '<option value="'+esc(d.deviceId)+'"'+(d.deviceId===selected?' selected':'')+'>'+esc(d.label||'麦克风')+'</option>';}).join('');
      if(selector.innerHTML!==choices)selector.innerHTML=choices;
    }
    if(s.mode==='photo'&&s.previewPhoto&&!s.node.querySelector('img')){s.node.innerHTML='<img alt="本次拍照" src="data:image/jpeg;base64,'+esc(s.previewPhoto.jpeg)+'"><time>'+esc(sydney(s.previewPhoto.captured_at))+'</time>';return;}
    var element=s.node.querySelector('video,audio');
    if(element&&s.remote&&element.srcObject!==s.remote){element.srcObject=s.remote;element.muted=!!s.audioContext;element.play().catch(function(){var button=s.node.querySelector('.media-play');if(button)button.hidden=false;});}
    var tracks=s.mode==='ptt'?s.local?.getAudioTracks():s.remote?.getAudioTracks();
    if(s.audioContext&&tracks?.length&&s.audioInputTrack!==tracks[0]){
      if(s.audioInput)s.audioInput.disconnect();if(s.outputGain)s.outputGain.disconnect();if(s.animation)cancelAnimationFrame(s.animation);
      s.audioInputTrack=tracks[0];s.audioInput=s.audioContext.createMediaStreamSource(new MediaStream([tracks[0]]));
      var analyser=s.audioContext.createAnalyser();s.analyser=analyser;analyser.fftSize=512;s.audioInput.connect(analyser);
      if(s.mode!=='ptt'){s.outputGain=s.audioContext.createGain();s.outputGain.gain.value=Number(s.node.querySelector('input')?.value||1);s.audioInput.connect(s.outputGain);s.outputGain.connect(s.audioContext.destination);}
      var canvas=s.node.querySelector('canvas');
      if(canvas){var samples=new Uint8Array(analyser.frequencyBinCount);canvas.width=640;canvas.height=180;var ctx=canvas.getContext('2d');
        function draw(){if(active!==s)return;analyser.getByteTimeDomainData(samples);ctx.clearRect(0,0,640,180);ctx.strokeStyle='#60a5fa';ctx.lineWidth=2;ctx.beginPath();samples.forEach(function(v,i){var x=i/samples.length*640,y=v/128*90;if(i)ctx.lineTo(x,y);else ctx.moveTo(x,y);});ctx.stroke();s.animation=requestAnimationFrame(draw);}draw();
      }
      if(s.audioContext.state!=='running'){var resumeButton=s.node.querySelector('.media-play');if(resumeButton)resumeButton.hidden=false;}
    }
    updateTime(s);
  }
  function preview(d,fallback){if(active&&(!d||active.device.id!==d.id)){stop('已切换设备，通信结束',true);return fallback;}if(active&&active.mode!=='prepare')return '<div class="remote-preview media-live"></div>';if(d&&ElfMediaCapabilities.allows(d,'photo')&&d.media_cameras>1){var at=fallback.lastIndexOf('</div>');fallback=fallback.slice(0,at)+'<button type="button" class="media-camera-switch" aria-label="切换摄像头并拍照" onclick="ElfMedia.switchPhoto()">⇄</button>'+fallback.slice(at);}return fallback;}
  function controls(d){var rows=[['ptt','PTT'],['call','电话'],['microphone','麦克风'],['photo','拍照'],['video','录像'],['alarm','警报']];return rows.map(function(row){var selected=active&&active.device.id===d?.id&&active.mode===row[0],disabled=!d||!ElfMediaCapabilities.allows(d,row[0])||d.managed_media_prepare_v1===true&&(!active||active.device.id!==d.id||!active.transportReady)||active&&active.mode!=='prepare'&&!selected;return '<button type="button" class="'+(selected?'active':'')+'" aria-pressed="'+!!selected+'" onclick="ElfMedia.start(\''+row[0]+'\')"'+(disabled?' disabled':'')+'>'+row[1]+'</button>';}).join('');}
  function feedback(d){var text=active?active.message:d&&lastDevice===d.id?lastMessage:'';return text?'<span class="media-feedback" role="status">'+esc(text)+'</span>':'';}
  function connectionControl(d){
    if(!d||!ElfMediaCapabilities.allows(d,'prepare'))return '';
    var connected=active?.device.id===d.id,ready=connected&&active.transportReady;
    return '<button type="button" class="traffic-link media-connect" aria-label="'+(connected?'断开媒体连接':'连接媒体')+'" aria-pressed="'+!!ready+'" onclick="ElfMedia.toggleConnection()">'+(connected?'断开':'连接')+'</button>';
  }
  async function toggleConnection(){var d=currentDev();if(active){await stop('已断开',true);return;}if(d&&ElfMediaCapabilities.allows(d,'prepare'))await start('prepare');}
  window.addEventListener('pagehide',function(){stop('',true);});
  return {isActive:function(){return !!active&&active.mode!=='prepare';},connectionControl:connectionControl,toggleConnection:toggleConnection,switchPhoto:function(){var d=currentDev();if(!d||active&&active.mode!=='prepare')return;cameraChoice[d.id]=cameraChoice[d.id]==='back'?'front':'back';start('photo',cameraChoice[d.id]);},start:start,stop:stop,mount:mount,preview:preview,controls:controls,feedback:feedback,cameraChoice:cameraChoice};
})();
