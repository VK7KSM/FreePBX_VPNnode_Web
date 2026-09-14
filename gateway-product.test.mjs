import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import vm from 'node:vm';
import worker from './worker.js';
import {fixture,request,login} from './test-support.mjs';
import {GATEWAY_PRODUCT as P} from './gateway-product.js';
import {RELEASE_CHANNELS,validateReleaseManifest,deviceReleaseChannel} from './release-channels.js';
import {mediaAllowed} from './media-capabilities.js';
import source from './devices-client-source.js';
const hash=b=>createHash('sha256').update(b).digest('hex');
const fields={product_id:P.product_id,app_package:P.app_package,app_cert_sha256:P.certSha256,app_abi:P.abi,model_id:P.model_id};
const identity={variant:'pixel3',kind:'wifi_factory_mac',source:'android_wifi_factory',value:'00:11:22:aa:bb:cc'};
const enroll=(f,token,extra={})=>worker.fetch(request('/api/devices/enroll','POST',{token,token_sha256:hash(token),model_hint:'Pixel 3',hardware_identity:identity,...fields,...extra}),f.env);
const report=(f,id,token,extra={})=>worker.fetch(request('/api/devices/report','POST',{device_id:id,token,status_only:true,report_id:crypto.randomUUID(),reported_at:new Date().toISOString(),network:'wifi',...fields,managed_media:false,managed_media_modes:[],...extra}),f.env);

test('网关产品注册、报告和刷后恢复保留身份，错误产品签名不能替换凭据',async()=>{
 const f=fixture(),cookie=await login(f);
 for(const extra of [{app_package:'net.elfradio.elfremote'},{app_cert_sha256:'a'.repeat(64)},{app_abi:'armeabi-v7a'},{model_id:'mdl_d22'},{hardware_identity:{...identity,variant:'d31'}}]){
  assert.equal((await enroll(f,'bad',extra)).status,400);
 }
 const first=await(await enroll(f,'one')).json();assert.ok(first.device_id);
 assert.equal((await report(f,first.device_id,'one',{managed_update:true,managed_update_v2:true})).status,200);
 const visible=(await(await worker.fetch(request('/api/devices','GET',undefined,cookie),f.env)).json()).devices[0];
 assert.equal(visible.product_id,P.product_id);assert.equal(visible.app_package,P.app_package);assert.equal(visible.update_channel,'gateway');assert.equal(visible.can_update,true);
 assert.equal(visible.managed_alarm_tasks,false);assert.equal(visible.managed_adb_session,false);
 assert.equal((await worker.fetch(request('/api/devices/update','POST',{id:first.device_id,model_id:'mdl_d22'},cookie),f.env)).status,400);
 assert.equal((await report(f,first.device_id,'one',{managed_media:true,managed_media_modes:['ptt']})).status,400);
 assert.equal((await report(f,first.device_id,'one',{managed_wipe_v1:true})).status,400);
 const snapshot=structuredClone(f.data.get('remote_devices'));
 assert.equal((await worker.fetch(request('/api/devices/enroll','POST',{token:'imposter',token_sha256:hash('imposter'),hardware_identity:identity}),f.env)).status,400);
 assert.deepEqual(f.data.get('remote_devices'),snapshot);
 const recovered=await(await enroll(f,'two')).json();assert.equal(recovered.device_id,first.device_id);
 assert.equal((await report(f,first.device_id,'one')).status,401);
 assert.equal((await report(f,first.device_id,'two')).status,200);
 assert.throws(()=>deviceReleaseChannel({model_id:'mdl_pixel3',hardware_identity:identity},[{id:'mdl_pixel3',registration_key:'pixel3'}]));
});

test('网关独立制品发布与轻量同步领取，拒绝跨通道和错误签名包',async t=>{
 const keys=generateKeyPairSync('rsa',{modulusLength:2048}),original=crypto.subtle.importKey.bind(crypto.subtle);
 t.mock.method(crypto.subtle,'importKey',(format,data,algorithm,...rest)=>original(format,algorithm.name==='RSASSA-PKCS1-v1_5'?keys.publicKey.export({type:'spki',format:'der'}):data,algorithm,...rest));
 const f=fixture(),cookie=await login(f),first=await(await enroll(f,'one')).json(),id=first.device_id;
 f.env.ELF_ARTIFACTS={async put(){}};
 await report(f,id,'one',{managed_update:true,managed_update_v2:true});
 const bytes=Buffer.from('gateway-test-apk'),m={...RELEASE_CHANNELS.gateway,channel:'gateway',versionCode:7,versionName:'1.4.2',size:bytes.length,sha256:hash(bytes),job_id:'gateway-test-job',expires_at:Date.now()+3600000,url:'https://v.elfradio.net/api/elfremote/apk/gateway-test-job'};
 for(const extra of [{versionCode:6},{channel:'d22'},{channel:'d31'},{package:'net.elfradio.elfremote'},{product_id:'other'},{model_id:'mdl_d31'},{abi:'armeabi-v7a'},{certSha256:'a'.repeat(64)}])assert.throws(()=>validateReleaseManifest({...m,...extra}));
 const raw=JSON.stringify(m),publish={manifest_raw:raw,signature:sign('sha256',Buffer.from(raw),keys.privateKey).toString('hex'),apk_b64:bytes.toString('base64'),publish_only:true};
 const published=await worker.fetch(request('/api/elfremote/releases','POST',publish,cookie),f.env);assert.equal(published.status,200,await published.text());
 assert.equal(f.data.get('remote_devices')[0].update,undefined);
 const listed=await(await worker.fetch(request('/api/elfremote/releases?device_id='+id,'GET',undefined,cookie),f.env)).json();assert.equal(listed.channel,'gateway');assert.equal(listed.releases[0].package,P.app_package);
 assert.equal((await worker.fetch(request('/api/elfremote/releases?device_id='+id+'&channel=d22','GET',undefined,cookie),f.env)).status,400);
 f.data.get('remote_devices').push({id:'d22',hardware_identity:{variant:'d22'},status_only:true,managed_update:true,managed_update_v2:true});
 assert.equal((await worker.fetch(request('/api/elfremote/assign','POST',{device_id:'d22',channel:'gateway',versionCode:7},cookie),f.env)).status,400);
 const assigned=await worker.fetch(request('/api/elfremote/assign','POST',{device_id:id,channel:'gateway',versionCode:7},cookie),f.env);assert.equal(assigned.status,200,await assigned.text());
 const sync=await(await worker.fetch(request('/api/devices/push-sync','POST',{device_id:id,token:'one'}),f.env)).json();
 assert.equal(sync.managed_update.manifest_raw,raw);assert.equal(sync.managed_update.task_device_id,id);assert.match(sync.managed_update.task_id,/^update-/);
 assert.equal(sync.media_session,null);assert.equal(sync.adb_session,null);
 const denied=await worker.fetch(request('/api/devices/push-sync','POST',{device_id:id,token:'wrong'}),f.env);assert.equal(denied.status,401);assert.doesNotMatch(await denied.text(),/manifest_raw/);
});

test('网关普通警报不建立媒体会话，未实现能力拒绝入队',async()=>{
 const f=fixture(),cookie=await login(f),first=await(await enroll(f,'one')).json(),id=first.device_id;
 const task=type=>worker.fetch(request('/api/elfremote/task','POST',{device_id:id,type},cookie),f.env);
 await report(f,id,'one');assert.equal((await task('play_alarm')).status,409);
 await report(f,id,'one',{managed_alarm_tasks:true});const response=await task('play_alarm');assert.equal(response.status,200,await response.text());
 const sync=await(await worker.fetch(request('/api/devices/push-sync','POST',{device_id:id,token:'one'}),f.env)).json();
 assert.equal(sync.managed_task.type,'play_alarm');assert.equal(sync.managed_task.managed_alarm_v1,true);assert.equal(f.store.media.sessions.size,0);
 for(const mode of ['prepare','ptt','call','microphone','photo','video','alarm']){
  assert.equal(mediaAllowed({...fields,managed_media:true,managed_media_modes:['alarm'],managed_media_prepare_v1:true},mode),false);
  assert.equal((await worker.fetch(request('/api/elfremote/media/session','POST',{device_id:id,mode},cookie),f.env)).status,400);
 }
});

test('网关保留统一通信终端布局，五项媒体始终禁用且警报仅走普通任务',()=>{
 const box={innerHTML:'',querySelector:()=>null},context=vm.createContext({adminSession:{check(){}},setTimeout(){},setInterval(){},document:{hidden:true,getElementById:()=>box}});
 vm.runInContext(source,context);const d={id:'gateway-ui',name:'测试网关',...fields};
 context.DEV=[d];context.selDev=d.id;context.serviceErrorText=()=>'';context.trajectoryPreview=()=>'';context.trajectoryEvent=()=>null;context.trajectoryMount=()=>{};
 context.loadReportPhotos=()=>{throw Error('网关不得请求照片');};context.ElfMedia={connectionControl(){throw Error('网关不得启动媒体');},mount(){throw Error('网关不得挂载媒体');},preview(){return '';}};
 for(const key of ['adb','update','wifi','files','contacts','lost'])assert.equal(context.gatewayFunctionAvailable(d,key),false);
 context.renderRemoteConsole();
 const buttons=()=>Array.from(box.innerHTML.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g),m=>m[0]);
 for(const label of ['PTT','电话','麦克风','拍照','录像','警报'])assert.ok(buttons().some(b=>b.includes('>'+label+'</button>')&&b.includes('disabled')),label);
 assert.match(box.innerHTML,/remote-preview/);assert.match(box.innerHTML,/openMediaHistory/);assert.doesNotMatch(box.innerHTML,/网关：|SIP：|通话：/);
 d.managed_alarm_tasks=true;d.managed_media=true;d.managed_media_prepare_v1=true;context.renderRemoteConsole();
 const alarm=buttons().find(b=>b.includes('>警报</button>'));assert.match(alarm,/enqueueRepair\('play_alarm'\)/);assert.doesNotMatch(alarm,/disabled|ElfMedia/);
 for(const label of ['PTT','电话','麦克风','拍照','录像'])assert.ok(buttons().some(b=>b.includes('>'+label+'</button>')&&b.includes('disabled')),label);
 d.alarm={state:'playing'};context.renderRemoteConsole();assert.match(box.innerHTML,/enqueueRepair\('stop_alarm'\)/);assert.match(box.innerHTML,/>停止警报<\/button>/);
 d.task={type:'stop_alarm',state:'pending'};context.renderRemoteConsole();assert.ok(buttons().find(b=>b.includes('>停止警报</button>')).includes('disabled'));
 d.can_update=true;assert.equal(context.gatewayFunctionAvailable(d,'update'),true);d.managed_adb_session=true;assert.equal(context.gatewayFunctionAvailable(d,'adb'),true);
 assert.equal(context.gatewayFunctionAvailable({product_id:undefined},'adb'),true);
});

test('安装级身份允许无MAC，网关状态只存白名单布尔值且不透传密码',async()=>{
 const f=fixture(),cookie=await login(f);
 const first=await(await enroll(f,'install-only',{hardware_identity:undefined})).json();
 assert.ok(first.device_id);assert.equal((await(await enroll(f,'install-only',{hardware_identity:undefined})).json()).device_id,first.device_id);
 assert.equal((await report(f,first.device_id,'install-only',{gateway:{running:true,sip_registered:false,busy:null,password:'private-test-secret',profile:{password:'private-test-secret'}}})).status,200);
 const stored=f.data.get('remote_devices')[0];assert.deepEqual(stored.gateway,{running:true,sip_registered:false,busy:null});
 const visible=await(await worker.fetch(request('/api/devices','GET',undefined,cookie),f.env)).json();assert.deepEqual(visible.devices[0].gateway,stored.gateway);assert.doesNotMatch(JSON.stringify(visible),/private-test-secret/);
 assert.equal((await report(f,first.device_id,'install-only',{gateway:{busy:'false'}})).status,400);
 assert.deepEqual(f.data.get('remote_devices')[0].gateway,stored.gateway);
 const next=await(await enroll(f,'new-install-only',{hardware_identity:undefined})).json();assert.notEqual(next.device_id,first.device_id);
 await report(f,first.device_id,'install-only',{battery:80});
 await report(f,first.device_id,'install-only',{battery:null});assert.equal(f.data.get('remote_devices')[0].battery,null);
 for(const extra of [{network:'4G'},{battery:'80'},{charging:'false'}])assert.equal((await report(f,first.device_id,'install-only',extra)).status,400);
});

test('网关按一分钟报告检查失联，不沿用D22蜂窝一小时窗口',async()=>{
 const {recoveryContact}=await import('./report-recovery.js'),at=Date.parse('2026-09-14T00:00:00Z');
 const d={...fields,status_only:true,enabled:true,last_seen:new Date(at).toISOString(),network:'cellular'};
 assert.equal(recoveryContact(d,at+120000).state,'recent_contact');
 assert.equal(recoveryContact(d,at+151000).state,'report_overdue');
 assert.equal(recoveryContact({...d,product_id:undefined},at+151000).state,'awaiting_report');
});


test('所有型号保留八个功能入口，切到网关不重置当前页且未支持操作禁用',()=>{
 const box={innerHTML:'',querySelector:()=>null};
 const context=vm.createContext({adminSession:{check(){}},setTimeout(){},setInterval(){},document:{hidden:true,getElementById:()=>box}});
 vm.runInContext(source,context);
 context.renderRemoteConsole=()=>{};context.disposeAdbView=()=>{};context.terminalBind=()=>{};context.bindAdbView=()=>{};
 const renderPage=context.fnPageHtml;context.fnPageHtml=()=>'<p>测试页面</p>';
 for(const product of [undefined,'elfremote_gateway']){
  const d={id:'menu-fixture',name:'测试设备',product_id:product,status_only:true};context.DEV=[d];context.selDev=d.id;
  for(const key of ['adb','update','wifi','contacts','locate','files','lost','model']){
   context.selFn=key;context.renderOps();
   assert.equal((box.innerHTML.match(/data-fn=/g)||[]).length,8);assert.equal(context.selFn,key);
  }
 }
 context.pageContacts=dis=>'<button'+dis+'>添加</button>';context.selFn='contacts';
 assert.match(renderPage(),/<button disabled>添加/);
});
