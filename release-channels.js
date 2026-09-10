export const RELEASE_CHANNELS = Object.freeze({
  d22: {package:'net.elfradio.elfremote',model_id:'mdl_d22'},
  d31: {package:'net.elfradio.d31bootstrap',model_id:'mdl_d31',certSha256:'9b31f89fa50b672ecfe02d73a534cc03f6cf893739aec268f9fe0b71e72da72e'}
});
export function releaseChannel(value) {
  const channel=value === undefined ? 'd22' : value;
  if(!Object.hasOwn(RELEASE_CHANNELS,channel))throw Error('未配置该客户端发布通道');
  return channel;
}
export function releaseKey(channel,version) {return 'elfremote_rel_'+(releaseChannel(channel)==='d22'?'':channel+'_')+version;}
export function releaseListKey(channel) {return 'elfremote_releases'+(releaseChannel(channel)==='d22'?'':'_'+channel);}
export function manifestChannel(m) {
  const channel=releaseChannel(m.channel),profile=RELEASE_CHANNELS[channel];
  if(m.package!==profile.package || (m.model_id!==undefined && m.model_id!==profile.model_id)
      || (channel!=='d22' && m.model_id!==profile.model_id)
      || (profile.certSha256 && m.certSha256!==profile.certSha256))throw Error('清单通道、型号、包名或APK签名不匹配');
  return channel;
}
export function validateReleaseManifest(m,now=Date.now()) {
  const channel=manifestChannel(m);
  if(!Number.isSafeInteger(m.versionCode)||m.versionCode<=0||m.versionCode>2147483647
    ||typeof m.versionName!=='string'||!m.versionName||m.versionName.length>128
    ||!Number.isSafeInteger(m.size)||m.size<=0||m.size>64*1024*1024
    ||!/^[0-9a-f]{64}$/.test(m.sha256||'')||!/^[0-9a-f]{64}$/.test(m.certSha256||'')
    ||!Number.isSafeInteger(m.expires_at)||(!(channel==='d22'&&m.expires_at===0)&&m.expires_at<=now)
    ||!/^[A-Za-z0-9_-]{1,96}$/.test(m.job_id||'')
    ||(m.device_id!==undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(m.device_id))
    ||m.url!=='https://v.elfradio.net/api/elfremote/apk/'+m.job_id)throw Error('清单字段或有效期无效');
  return channel;
}
export function deviceReleaseChannel(device,models) {
  const model=models.find(m=>m.id && m.id===device.model_id);
  const identity=device.hardware_identity?.variant;
  const channel=identity || model?.registration_key || (!device.model_id ? 'd22' : '');
  if(identity && model && identity!==model.registration_key)throw Error('设备身份与所选型号不一致');
  return releaseChannel(channel);
}
