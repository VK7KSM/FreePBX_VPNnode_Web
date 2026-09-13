import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import worker from './worker.js';
import source from './devices-client-source.js';
import {deviceUpdateAvailable} from './release-channels.js';
import {fixture,login,request} from './test-support.mjs';

const release=(versionCode,extra={})=>({versionCode,versionName:'0.1.'+versionCode,expires_at:0,...extra});
test('更新灯只采用适用的可安装版本，不将未知版本或更高版本判为过期',()=>{
  const d={id:'fixture',app_version:'0.1.9-production'};
  assert.equal(deviceUpdateAvailable(d,[release(10)]),true);
  assert.equal(deviceUpdateAvailable({...d,app_version:'0.1.10-production'},[release(10)]),false);
  assert.equal(deviceUpdateAvailable({...d,app_version:'0.1.11'},[release(10)]),false);
  for(const app_version of ['', 'unknown'])assert.equal(deviceUpdateAvailable({...d,app_version},[release(10)]),false);
  for(const extra of [{retired_at:1},{expires_at:1},{manifest_raw:JSON.stringify({device_id:'other'})},{manifest_raw:'invalid'}])
    assert.equal(deviceUpdateAvailable(d,[release(10,extra)]),false);
  assert.equal(deviceUpdateAvailable({...d,app_version:'stable-old'},[release(9,{versionName:'stable-old'}),release(10,{versionName:'stable-new'})]),true);
});

test('设备列表合并不同通道更新结果，共享通道只读取一次发布记录',async()=>{
  const devices=[['first','d22','0.1.9'],['second','d22','0.1.10'],['third','d31','0.1.9']]
    .map(([id,variant,app_version])=>({id,name:id,hardware_identity:{variant},app_version,enabled:true,last_seen:new Date().toISOString()}));
  const f=fixture({admin_pass:'fixture-password',remote_devices:devices,
    elfremote_releases:[10],elfremote_rel_10:release(10),
    elfremote_releases_d31:[9],elfremote_rel_d31_9:release(9)});
  const cookie=await login(f),reads=[];
  const get=f.storage.get;f.storage.get=async key=>{reads.push(key);return get(key);};
  let body=await (await worker.fetch(request('/api/devices','GET',undefined,cookie),f.env)).json();
  assert.equal(body.ok,true);
  assert.deepEqual(body.devices.map(d=>[d.id,d.update_available]),[['first',true],['second',false],['third',false]]);
  assert.equal(reads.filter(k=>k==='elfremote_rel_10').length,1);
  devices[0].app_version='0.1.10';f.data.set('remote_devices',devices);
  body=await (await worker.fetch(request('/api/devices','GET',undefined,cookie),f.env)).json();
  assert.equal(body.devices[0].update_available,false);
  f.storage.get=async key=>{if(key==='elfremote_releases')throw Error('fixture unavailable');return get(key);};
  body=await (await worker.fetch(request('/api/devices','GET',undefined,cookie),f.env)).json();
  assert.equal(body.ok,true);assert.equal(body.devices.length,3);
});

test('在线旧版黄灯，在线最新版绿灯，离线与停用仍为灰灯，并复用等待上报黄色',async()=>{
  const box={innerHTML:''};
  const context=vm.createContext({document:{getElementById:()=>box},adminSession:{check(){}},setTimeout(){},setInterval(){}});
  vm.runInContext(source,context);
  for(const [online,enabled,update_available,expected] of [[true,true,true,'dot-update'],[true,true,false,'dot-on'],[false,true,true,'dot-off'],[true,false,true,'dot-off']]){
    context.DEV=[{id:'fixture',name:'测试机',online,enabled,update_available}];context.renderList();
    assert.match(box.innerHTML,new RegExp('class="dot '+expected+'"'));
    if(expected==='dot-update')assert.match(box.innerHTML,/在线，客户端需要更新/);
  }
  const html=await (await worker.fetch(request('/devices'),{})).text();
  const yellow=html.match(/\.dot-update\{background:(#[a-f0-9]+)/)[1];
  assert.match(html,new RegExp('\\.report-status\\{[^}]*color:'+yellow));
});
