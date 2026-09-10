import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import worker from './worker.js';
import {fixture,request,login} from './test-support.mjs';
import {normalizeDeviceIdentity} from './device-identity.js';

const identity={variant:'d22',kind:'wifi_factory_mac',source:'nvdata_wifi',value:'00:11:22:aa:bb:cc'};
const d31Identity={variant:'d31',kind:'ethernet_factory_mac',source:'sysfs_eth0_permanent',value:identity.value};
const h13Identity={...identity,variant:'h13',source:'wlan_factory'};
const pixelIdentity={...identity,variant:'pixel3',source:'android_wifi_factory'};
const sha=token=>createHash('sha256').update(token).digest('hex');
test('出厂地址仅接受实读来源及全局单播地址',()=>{
  assert.deepEqual(normalizeDeviceIdentity({...identity,value:'001122AABBCC'}),identity);
  for(const value of ['02:00:00:00:00:00','02:11:22:aa:bb:cc','01:11:22:aa:bb:cc','00:00:00:00:00:00','ff:ff:ff:ff:ff:ff','bad'])
    assert.throws(()=>normalizeDeviceIdentity({...identity,value}));
  assert.throws(()=>normalizeDeviceIdentity({...identity,source:'ssid'}));
});

for (const candidate of [identity,d31Identity,h13Identity,pixelIdentity]) test(candidate.variant+'刷后关联原设备，保留配对配置历史，旧动作与凭证不复活',async()=>{
  const identity=candidate;
  const oldToken='old-install',newToken='new-install',f=fixture(),cookie=await login(f);
  const enroll=(token,extra={})=>worker.fetch(request('/api/devices/enroll','POST',{token,token_sha256:sha(token),device_name:'系统名称',hardware_identity:identity,...extra}),f.env);
  const first=await (await enroll(oldToken)).json();
  const devices=f.data.get('remote_devices');const d=devices[0];
  assert.equal(d.model_id,'mdl_'+identity.variant);
  d.paired=true;d.name='管理员名称';d.desired_config={wifi:{enabled:true}};
  d.task={id:'before-wipe',type:'reboot',state:'pending',expires_at:Date.now()+10000};
  d.traffic={available:false};d.last_reported_at='2099-01-01T00:00:00Z';
  f.data.set('remote_devices',devices);f.data.set('history/'+d.id+'/fixture',{saved:true});
  const next=await (await enroll(newToken)).json();
  assert.equal(next.device_id,first.device_id);assert.equal(next.paired,true);
  const current=f.data.get('remote_devices')[0];
  assert.equal(current.name,'管理员名称');assert.deepEqual(current.desired_config,{wifi:{enabled:true}});
  assert.equal(current.model_id,'mdl_'+identity.variant);
  assert.equal(current.task,undefined);assert.equal(current.traffic,undefined);assert.ok(current.installation_id);
  assert.equal(f.data.get('remote_devices').length,1);
  assert.equal(f.data.get('history/'+d.id+'/fixture').saved,true);
  assert.equal((await (await enroll(newToken)).json()).device_id,d.id);
  assert.notEqual((await enroll(oldToken)).status,200);
  const oldReport=await worker.fetch(request('/api/devices/report','POST',{device_id:d.id,token:oldToken}),f.env);
  assert.equal(oldReport.status,401);
  const oldPair=await worker.fetch(request('/api/devices/pair','POST',{code:first.code},cookie),f.env);
  assert.notEqual(oldPair.status,200);
  const history=await (await worker.fetch(request('/api/elfremote/tasks?device_id='+d.id,'GET',undefined,cookie),f.env)).json();
  assert.equal(history.tasks[0].state,'expired');
  const report=await worker.fetch(request('/api/devices/report','POST',{device_id:d.id,token:newToken,status_only:true,report_id:'new-report',reported_at:new Date().toISOString(),battery:77,network:'wifi'}),f.env);
  assert.equal(report.status,200);assert.equal((await report.json()).managed_task,undefined);
  const rows=await (await worker.fetch(request('/api/devices','GET',undefined,cookie),f.env)).json();
  assert.equal(rows.devices[0].name,'管理员名称');assert.equal(rows.devices[0].mac,identity.value);
  assert.equal(JSON.stringify(rows).includes(newToken),false);
  // 原注册未切换MQTT用户名；只有新安装使用独立身份，避免旧连接抢占新连接。
  const {pushState}=await import('./push-control.js');
  const readPush=token=>pushState(f.storage,new Request('https://store/__push/config',{method:'POST',body:JSON.stringify({device_id:d.id,token})}),async()=>f.data.get('remote_devices'));
  assert.equal((await readPush(oldToken)).status,401);
  const username=(await (await readPush(newToken)).json()).username;
  assert.notEqual(username,'d_'+sha(d.id));
});

test('D31只接受已对接的有线出厂地址组合，不接受D22来源混用或随机地址',()=>{
  assert.deepEqual(normalizeDeviceIdentity({...d31Identity,value:'00-11-22-AA-BB-CC'}),d31Identity);
  for(const change of [{kind:identity.kind},{source:identity.source},{variant:''},
    {value:'02:11:22:aa:bb:cc'},{value:'01:11:22:aa:bb:cc'},{value:'00:00:00:00:00:00'},{value:'invalid'}])
    assert.throws(()=>normalizeDeviceIdentity({...d31Identity,...change}));
});

test('同地址不同机型分别注册，错误来源的旧记录不被接管',async()=>{
  const f=fixture();
  const enroll=async(token,hardware_identity)=>{
    const r=await worker.fetch(request('/api/devices/enroll','POST',{token,token_sha256:sha(token),hardware_identity}),f.env);
    assert.equal(r.status,200);return r.json();
  };
  const d22=await enroll('d22-install',identity),d31=await enroll('d31-install',d31Identity);
  assert.notEqual(d22.device_id,d31.device_id);
  assert.equal((await enroll('d31-reinstall',d31Identity)).device_id,d31.device_id);
  assert.equal(f.data.get('remote_devices').find(d=>d.id===d22.device_id).token_sha256,sha('d22-install'));
  f.data.get('remote_devices').find(d=>d.id===d31.device_id).hardware_identity.source='other_source';
  const fresh=await enroll('d31-different-source',d31Identity);
  assert.notEqual(fresh.device_id,d31.device_id);
});

test('型号目录控制注册，新增型号无需服务器白名单，改名后上报与重装仍关联',async()=>{
  const f=fixture({admin_pass:'fixture-password',remote_device_models:[]}),cookie=await login(f);
  const call=(path,body,auth)=>worker.fetch(request(path,body?'POST':'GET',body ?? undefined,auth),f.env);
  const enroll=(token,extra={})=>call('/api/devices/enroll',{token,token_sha256:sha(token),model_hint:'新型号 A-7',...extra});
  assert.equal((await enroll('missing')).status,400);
  assert.equal((f.data.get('remote_devices')||[]).length,0);
  assert.equal((await call('/api/device-models',{name:'新型号 A-7'})).status,401);
  const saved=await (await call('/api/device-models',{name:'新型号 A-7'},cookie)).json();
  assert.equal(saved.ok,true);const model=saved.model;
  assert.equal((await call('/api/device-models',{name:'新型号a7'},cookie)).status,409);
  const hw={...h13Identity,variant:'新型号 a7'};
  const first=await (await enroll('new-model',{hardware_identity:hw})).json();
  assert.ok(first.device_id);
  assert.equal(f.data.get('remote_devices')[0].model_id,model.id);
  const paired=await call('/api/devices/pair',{code:first.code},cookie);
  assert.equal(paired.status,200);assert.equal((await paired.json()).device.model_id,model.id);
  assert.equal((await call('/api/device-models',{action:'delete',id:model.id},cookie)).status,400);
  const rename=await (await call('/api/device-models',{id:model.id,name:'新名称 B8'},cookie)).json();
  assert.equal(rename.model.registration_key,model.registration_key);
  assert.equal((await call('/api/devices/report',{device_id:first.device_id,token:'new-model',status_only:true,hardware_identity:{...hw,variant:'新名称b8'}})).status,200);
  assert.equal(f.data.get('remote_devices')[0].hardware_identity.variant,model.registration_key);
  const again=await (await enroll('new-install',{hardware_identity:{...hw,variant:'新名称b8'}})).json();
  assert.equal(again.device_id,first.device_id);
  const oldName=await (await enroll('new-other',{hardware_identity:{...hw,value:'00:11:22:aa:bb:dd'}})).json();
  assert.ok(oldName.device_id);
  assert.equal((await enroll('explicit',{model_id:model.id,model_hint:'Android OEM name'})).status,200);
  assert.equal((await enroll('mismatch',{model_id:model.id,hardware_identity:identity})).status,400);
});

test('未用型号删除后不自动复活，清空目录保持为空',async()=>{
  const f=fixture(),cookie=await login(f);
  const models=await (await worker.fetch(request('/api/device-models','GET',undefined,cookie),f.env)).json();
  for(const m of models.models)assert.equal((await worker.fetch(request('/api/device-models','POST',{action:'delete',id:m.id},cookie),f.env)).status,200);
  assert.deepEqual((await (await worker.fetch(request('/api/device-models','GET',undefined,cookie),f.env)).json()).models,[]);
  const r=await worker.fetch(request('/api/devices/enroll','POST',{token:'deleted',token_sha256:sha('deleted'),hardware_identity:d31Identity}),f.env);
  assert.equal(r.status,400);assert.deepEqual(f.data.get('remote_device_models'),[]);
});

test('无硬件身份时按型号提示选型，缺省兼容D22，Pixel名称格式兼容',async()=>{
  const f=fixture();
  for(const [hint,expected] of [[undefined,'d22'],['D31','d31'],['H13','h13'],['PIXEL-3','pixel3'],['Pixel 3','pixel3']]){
    const token='hint-'+String(hint);
    const r=await worker.fetch(request('/api/devices/enroll','POST',{token,token_sha256:sha(token),model_hint:hint}),f.env);
    assert.equal(r.status,200);const d=await r.json();
    assert.equal(f.data.get('remote_devices').find(row=>row.id===d.device_id).model_id,'mdl_'+expected);
  }
});

test('D31完成注册上报与既有命令协议往返，未声明能力不提前开放',async()=>{
  const f=fixture(),cookie=await login(f),token='d31-roundtrip';
  const call=(path,body,auth)=>worker.fetch(request(path,body?'POST':'GET',body ?? undefined,auth),f.env);
  const first=await (await call('/api/devices/enroll',{token,token_sha256:sha(token),device_name:'D31 elfRemote',model_hint:'D31',hardware_identity:d31Identity})).json();
  const device_id=first.device_id;
  const report=async(id,extra={})=>call('/api/devices/report',{device_id,token,report_id:id,reported_at:new Date().toISOString(),status_only:true,
    app_version:'1.12.0-remote-core-preview',os_version:'6.0',network:'ethernet',hardware_identity:d31Identity,ready:true,...extra});
  assert.equal((await report('before-capability')).status,200);
  const job={device_id,type:'root_exec',id:'d31-readonly',params:{command:'id; getprop ro.build.version.sdk'}};
  assert.equal((await call('/api/elfremote/task',job,cookie)).status,409);
  assert.equal((await report('with-capability',{managed_exec_tasks:true})).status,200);
  assert.equal((await call('/api/elfremote/task',job)).status,401);
  assert.equal((await call('/api/elfremote/task',job,cookie)).status,200);
  const offer=await (await report('receive-task',{managed_exec_tasks:true})).json();
  assert.equal(offer.managed_task.id,job.id);assert.equal(offer.managed_task.type,'root_exec');
  for(const state of ['claimed','running','success']) {
    const result=state==='success'?{exit_code:0,elapsed_ms:122,text:'fixture root\n23\n',action:'completed',stage:'command'}:{};
    assert.equal((await call('/api/elfremote/task-progress',{device_id,token,task_id:job.id,state,result})).status,200);
  }
  const historic=await (await call('/api/elfremote/tasks?device_id='+device_id+'&task_id='+job.id,null,cookie)).json();
  assert.equal(historic.task.state,'success');assert.equal(historic.task.result.text,'fixture root\n23\n');
  const rows=await (await call('/api/devices',null,cookie)).json(),d=rows.devices.find(d=>d.id===device_id);
  assert.equal(d.model_id,'mdl_d31');assert.equal(d.model_name,'D31');assert.equal(d.network,'ethernet');assert.equal(d.mac,d31Identity.value);
  assert.equal(d.managed_exec_tasks,true);assert.notEqual(d.managed_media,true);assert.notEqual(d.managed_adb_session,true);
  const invalid=await report('invalid-identity',{hardware_identity:{...d31Identity,source:'nvdata_wifi'}});
  assert.equal(invalid.status,400);
});

test('缺失或重复地址不猜测关联，已有旧客户端可继续注册',async()=>{
  const f=fixture({admin_pass:'fixture-password',remote_devices:[{id:'a',hardware_identity:identity,token_sha256:sha('a')},{id:'b',hardware_identity:identity,token_sha256:sha('b')}]});
  const enroll=(token,extra={})=>worker.fetch(request('/api/devices/enroll','POST',{token,token_sha256:sha(token),...extra}),f.env);
  const multiple=await (await enroll('third',{hardware_identity:identity})).json();
  assert.ok(multiple.device_id);assert.notEqual(multiple.device_id,'a');assert.notEqual(multiple.device_id,'b');
  assert.equal((await enroll('legacy')).status,200);
});
