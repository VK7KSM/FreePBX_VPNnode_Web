import test from 'node:test';
import assert from 'node:assert/strict';
import { requestDeviceId, shareVerdict, observerVerdict, sanitizeDeviceUpdate, sameOwner, ownerOf } from './share-scope.js';

const u=(path,q='')=>new URL('https://v.example'+path+q);
const share={kind:'share',device_id:'dev1',session_id:'s1',generation:2};

test('requestDeviceId 覆盖 query、body.device_id 与 update/delete 的 id', () => {
  assert.equal(requestDeviceId('/api/elfremote/tasks','GET',u('/api/elfremote/tasks','?device_id=dev1'),''),'dev1');
  assert.equal(requestDeviceId('/api/elfremote/task','POST',u('/api/elfremote/task'),JSON.stringify({device_id:'dev2',type:'root_exec'})),'dev2');
  assert.equal(requestDeviceId('/api/devices/update','POST',u('/api/devices/update'),JSON.stringify({id:'dev3',name:'x'})),'dev3');
  assert.equal(requestDeviceId('/api/elfremote/files/abc','GET',u('/api/elfremote/files/abc','?device_id=dev1'),''),'dev1');
  assert.equal(requestDeviceId('/api/devices','GET',u('/api/devices'),''),null);
});

test('独立页：本设备放行、他设备与全局操作拒绝、只读白名单放行', () => {
  assert.equal(shareVerdict(share,'/api/elfremote/task','POST',u('/api/elfremote/task'),JSON.stringify({device_id:'dev1',type:'root_exec'})),null);
  assert.equal(shareVerdict(share,'/api/elfremote/task','POST',u('/api/elfremote/task'),JSON.stringify({device_id:'dev2',type:'root_exec'})).status,403);
  assert.equal(shareVerdict(share,'/api/devices','GET',u('/api/devices'),''),null);
  assert.equal(shareVerdict(share,'/api/devices/sip-directory','GET',u('/api/devices/sip-directory'),'').status,403);
  assert.equal(shareVerdict(share,'/api/elfremote/proxy-config','POST',u('/api/elfremote/proxy-config'),JSON.stringify({device_id:'dev1'})).status,403);
  assert.equal(shareVerdict(share,'/api/devices/delete','POST',u('/api/devices/delete'),JSON.stringify({id:'dev1'})).status,403);
  assert.equal(shareVerdict(share,'/api/devices/update','POST',u('/api/devices/update'),JSON.stringify({id:'dev1',name:'n'})),null);
  assert.equal(shareVerdict(share,'/api/devices/update','POST',u('/api/devices/update'),'{}').status,403);
  assert.equal(shareVerdict(share,'/api/elfremote/desktop/browser','GET',u('/api/elfremote/desktop/browser','?session_id=x'),''),null);
  assert.equal(shareVerdict(share,'/api/elfremote/releases','POST',u('/api/elfremote/releases'),'{}').status,403);
  assert.equal(shareVerdict({kind:'admin'},'/api/devices/sip-directory','GET',u('/api/devices/sip-directory'),''),null);
  assert.equal(shareVerdict(share,'/api/share/links/update','POST',u('/api/share/links/update'),JSON.stringify({token:'ABC'})),null);
  assert.equal(shareVerdict(share,'/api/share/links','POST',u('/api/share/links'),JSON.stringify({device_id:'dev2'})).status,403);
});

test('后台旁观：读放行、例外动作放行、丢失模式任务放行、其余拒绝', () => {
  assert.equal(observerVerdict('/api/elfremote/tasks','GET',''),null);
  assert.equal(observerVerdict('/api/devices/update','POST','{}'),null);
  assert.equal(observerVerdict('/api/elfremote/task','POST',JSON.stringify({type:'lost_lock'})),null);
  assert.equal(observerVerdict('/api/elfremote/task','POST',JSON.stringify({type:'root_exec'})).status,403);
  assert.equal(observerVerdict('/api/elfremote/media/session','POST','{}').status,403);
  assert.equal(observerVerdict('/api/devices/request-status','POST','{}').status,403);
  assert.equal(observerVerdict('/api/elfremote/adb/observer','GET',''),null);
});

test('编辑字段白名单与会话归属', () => {
  assert.deepEqual(sanitizeDeviceUpdate({id:'d',name:'n',enabled:true}),{ok:true});
  assert.match(sanitizeDeviceUpdate({id:'d',task:{}}).error,/task/);
  assert.equal(sameOwner(undefined,{kind:'admin'}),true);
  assert.equal(sameOwner({kind:'share',session_id:'s1'},share),true);
  assert.equal(sameOwner({kind:'share',session_id:'s0'},share),false);
  assert.equal(sameOwner({kind:'admin'},share),false);
  assert.deepEqual(ownerOf(share),{kind:'share',session_id:'s1',generation:2});
});
