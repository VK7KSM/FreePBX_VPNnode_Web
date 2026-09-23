import {GATEWAY_PRODUCT,isGateway,gatewayProductFields} from './gateway-product.js';
// asset:true 的通道装的不是 APK，而是设备以 root 执行的裸二进制（当前是 D31 的代理核心）。
// 这类资产复用发布通道的离线签名、R2 存储与版本固定，但**绝不能走指派/更新那条路**：
// assignReleaseToDevice 会在设备记录上建 update 记录，设备的更新器会把它当 APK 去安装。
// 它们也没有 APK 签名证书，所以 certSha256 不作要求。
export const RELEASE_CHANNELS = Object.freeze({
  d22: {package:'net.elfradio.elfremote',model_id:'mdl_d22'},
  'd31-proxy-core': {package:'net.elfradio.d31.proxycore',model_id:'mdl_d31',asset:true},
  // D22 的 WebRTC 原生库（12 MB）。全量安装包自带它，精简更新包不带；
  // 装了精简包又没有本地库的机器按这个通道去取。设备拿到字节后是拿**自己 APK 里**
  // 那份 assets/media-native.json 的哈希去比对的，不是拿服务端说的哈希，
  // 所以这条通道即使被换成别的库，设备也只会把它丢掉。
  'd22-media-native': {package:'net.elfradio.elfremote.medianative',model_id:'mdl_d22',asset:true},
  d31: {package:'net.elfradio.d31bootstrap',model_id:'mdl_d31',certSha256:'9b31f89fa50b672ecfe02d73a534cc03f6cf893739aec268f9fe0b71e72da72e'},
  gateway: {package:GATEWAY_PRODUCT.app_package,model_id:GATEWAY_PRODUCT.model_id,product_id:GATEWAY_PRODUCT.product_id,certSha256:GATEWAY_PRODUCT.certSha256,abi:GATEWAY_PRODUCT.abi}
});
export function releaseChannel(value) {
  const channel=value === undefined ? 'd22' : value;
  if(!Object.hasOwn(RELEASE_CHANNELS,channel))throw Error('未配置该客户端发布通道');
  return channel;
}
// 同一个版本会出两个制品：全量包自带 WebRTC 原生库（约 12 MB，供首次装机，不依赖网络），
// 精简包不带库（约 1.5 MB，做日常 OTA）。两者版本码相同、哈希不同。
// 缺省视为 full：203 及之前发布的记录都自带库，语义上就是全量包，
// 这样既有存储键与既有记录一概不用迁移。
export const RELEASE_VARIANTS = Object.freeze(['full','slim']);
export function releaseVariant(value) {
  const variant = value === undefined || value === null || value === '' ? 'full' : value;
  if(!RELEASE_VARIANTS.includes(variant))throw Error('未知的安装包类型');
  return variant;
}
// full 不带后缀，正是为了让 203 及更早的记录在改动后仍能按原键读到。
export function releaseKey(channel,version,variant) {
  return 'elfremote_rel_'+(releaseChannel(channel)==='d22'?'':channel+'_')+version
    +(releaseVariant(variant)==='slim'?'_slim':'');
}
export function releaseListKey(channel) {return 'elfremote_releases'+(releaseChannel(channel)==='d22'?'':'_'+channel);}
export function manifestChannel(m) {
  const channel=releaseChannel(m.channel),profile=RELEASE_CHANNELS[channel];
  if(m.package!==profile.package || (m.model_id!==undefined && m.model_id!==profile.model_id)
      || (channel!=='d22' && m.model_id!==profile.model_id)
      || (profile.certSha256 && m.certSha256!==profile.certSha256)
      || (channel==='gateway'&&(m.product_id!==profile.product_id||m.abi!==profile.abi||m.versionCode<=6)))throw Error('清单通道、型号、包名或APK签名不匹配');
  return channel;
}
export function validateReleaseManifest(m,now=Date.now()) {
  const channel=manifestChannel(m);
  if(!Number.isSafeInteger(m.versionCode)||m.versionCode<=0||m.versionCode>2147483647
    ||typeof m.versionName!=='string'||!m.versionName||m.versionName.length>128
    ||!Number.isSafeInteger(m.size)||m.size<=0||m.size>64*1024*1024
    ||!/^[0-9a-f]{64}$/.test(m.sha256||'')
    ||(!RELEASE_CHANNELS[channel].asset&&!/^[0-9a-f]{64}$/.test(m.certSha256||''))
    ||(RELEASE_CHANNELS[channel].asset&&m.certSha256!==undefined&&!/^[0-9a-f]{64}$/.test(m.certSha256))
    ||!Number.isSafeInteger(m.expires_at)||(!(channel==='d22'&&m.expires_at===0)&&m.expires_at<=now)
    ||!/^[A-Za-z0-9_-]{1,96}$/.test(m.job_id||'')
    ||(m.device_id!==undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(m.device_id))
    ||(m.variant!==undefined && !RELEASE_VARIANTS.includes(m.variant))
    ||m.url!=='https://v.elfradio.net/api/elfremote/apk/'+m.job_id)throw Error('清单字段或有效期无效');
  return channel;
}
/** 资产通道装的是裸二进制，不是 APK；不得进入指派/更新那条路。 */
export function isAssetChannel(channel) {
  return RELEASE_CHANNELS[releaseChannel(channel)]?.asset === true;
}

export function deviceReleaseChannel(device,models) {
  const model=models.find(m=>m.id && m.id===device.model_id);
  if(isGateway(device)){
    gatewayProductFields({},device,device.hardware_identity);
    if(device.model_id!==GATEWAY_PRODUCT.model_id||(model&&model.registration_key!=='pixel3'))throw Error('网关型号不匹配');
    return 'gateway';
  }
  const identity=device.hardware_identity?.variant;
  const channel=identity || model?.registration_key || (!device.model_id ? 'd22' : '');
  if(identity && model && identity!==model.registration_key)throw Error('设备身份与所选型号不一致');
  return releaseChannel(channel);
}

// 只比较设备所属通道、仍可安装且适用于该设备的正式发布记录。
/** 同一版本码有两个变体时，自动更新取精简包——它不含原生库，设备本地已有那份。 */
export function preferredRelease(releases) {
  return releases.find(rel=>releaseVariant(rel.variant)==='slim') || releases[0] || null;
}

export function deviceUpdateAvailable(device,releases,now=Date.now()) {
  const applicable=releases.filter(rel=>{
    if(!rel || rel.retired_at || !Number.isSafeInteger(rel.versionCode) || rel.versionCode<=0)return false;
    try {const m=JSON.parse(rel.manifest_raw||'{}');return !m.device_id || m.device_id===device.id;}catch{return false;}
  });
  const latest=applicable.filter(rel=>!(Number(rel.expires_at)>0 && Number(rel.expires_at)<=now))
    .sort((a,b)=>b.versionCode-a.versionCode)[0];
  if(!latest || !device.app_version)return false;
  const exact=applicable.find(rel=>rel.versionName===device.app_version);
  if(exact)return exact.versionCode<latest.versionCode;
  const current=String(device.app_version).match(/^\d+(?:\.\d+)+/);
  const target=String(latest.versionName||'').match(/^\d+(?:\.\d+)+/);
  if(!current || !target)return false;
  const a=current[0].split('.').map(Number),b=target[0].split('.').map(Number);
  for(let i=0;i<Math.max(a.length,b.length);i++) {
    const diff=(a[i]||0)-(b[i]||0);if(diff)return diff<0;
  }
  return false;
}
