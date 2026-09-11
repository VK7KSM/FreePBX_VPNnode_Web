import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {MediaRelay} from './media-relay.js';
import {MEDIA_MODES,mediaModes,mediaAllowed,mediaCapabilityFields,applyMediaCapabilities,mediaCapabilitiesSource} from './media-capabilities.js';
test('旧D22严格布尔兼容，显式能力按模式开放且不依赖旧总开关',()=>{
  assert.deepEqual(mediaModes({managed_media:true}),MEDIA_MODES);
  for(const value of [1,'true',false,null])assert.deepEqual(mediaModes({managed_media:value}),[]);
  assert.deepEqual(mediaModes({managed_media:false,managed_media_modes:['microphone']}),['microphone']);
  assert.equal(mediaAllowed({managed_media:true,managed_media_modes:['photo']},'call'),false);
});
test('空集合、未知模式、重复、非法集合及停用设备均失败关闭',()=>{
  for(const modes of [[],null,false,'microphone',{},['photo','unknown'],['photo','photo'],[1]])assert.deepEqual(mediaModes({managed_media:true,managed_media_modes:modes}),[]);
  assert.deepEqual(mediaModes({enabled:false,managed_media_modes:['photo']}),[]);
});
test('报告序列化保留显式空集合，旧报告清掉旧集合，界面和服务端相同',()=>{
  const d={managed_media_modes:['call']};applyMediaCapabilities(d,{managed_media_modes:null});assert.deepEqual(d.managed_media_modes,[]);
  assert.deepEqual(mediaCapabilityFields(d),{managed_media_modes:[]});applyMediaCapabilities(d,{managed_media:true});assert.equal(Object.hasOwn(d,'managed_media_modes'),false);
  const context=vm.createContext({});vm.runInContext(mediaCapabilitiesSource,context);
  for(const modes of [undefined,[],['photo'],['unknown'],null]){
    const d={managed_media:true};if(modes!==undefined)d.managed_media_modes=modes;
    assert.equal(JSON.stringify(context.ElfMediaCapabilities.modes(d)),JSON.stringify(mediaModes(d)));
  }
});
test('服务端会话入口不能绕过按模式能力，显式空集合拒绝旧总开关',()=>{
  const relay=new MediaRelay({}, {schedule:()=>0,cancel(){}});
  assert.throws(()=>relay.create({id:'d31',managed_media:true,managed_media_modes:[]},'photo'),/不支持/);
  assert.throws(()=>relay.create({id:'d31',managed_media:true,managed_media_modes:['photo']},'alarm'),/不支持/);
  assert.ok(relay.create({id:'d31',managed_media:false,managed_media_modes:['photo']},'photo').session_id);
});
test('页面逐按钮门控，禁止模式不会申请浏览器麦克风或创建会话',async()=>{
  const d={id:'synthetic',managed_media:true,managed_media_modes:['photo'],media_cameras:2};let calls=0;
  const context=vm.createContext({window:{addEventListener(){}},currentDev:()=>d,navigator:{mediaDevices:{getUserMedia:()=>{calls++;}}},fetch:()=>{calls++;},setTimeout,clearTimeout});
  vm.runInContext(mediaCapabilitiesSource+'\n'+fs.readFileSync(new URL('./media-client.js',import.meta.url),'utf8'),context);
  const media=context.window.ElfMedia,html=media.controls(d);assert.match(html,/start\('photo'\)"[^>]*>拍照/);assert.match(html,/start\('call'\)" disabled/);
  await media.start('call');assert.equal(calls,0);d.managed_media_modes=[];assert.doesNotMatch(media.preview(d,'<div></div>'),/media-camera-switch/);
});

