// 产品身份独立于硬件型号，普通Pixel登记不会自动取得网关更新通道。
export const GATEWAY_PRODUCT = Object.freeze({
  product_id:'elfremote_gateway',app_package:'org.onetwoone.gateway',model_id:'mdl_pixel3',variant:'pixel3',
  certSha256:'9b31f89fa50b672ecfe02d73a534cc03f6cf893739aec268f9fe0b71e72da72e',abi:'arm64-v8a'
});
export function isGateway(device){return device?.product_id===GATEWAY_PRODUCT.product_id;}
export function gatewayProductFields(data,existing=null,identity=null){
  const product=data.product_id??existing?.product_id;
  const packageName=data.app_package??existing?.app_package;
  if(product===undefined&&packageName===undefined)return {};
  if(product!==GATEWAY_PRODUCT.product_id||packageName!==GATEWAY_PRODUCT.app_package)
    throw Error('产品标识与应用包名不匹配');
  if(existing?.product_id&&existing.product_id!==product)throw Error('已有设备不能更换产品身份');
  if((data.model_id&&data.model_id!==GATEWAY_PRODUCT.model_id)
    ||(existing?.model_id&&existing.model_id!==GATEWAY_PRODUCT.model_id)
    ||(identity&&identity.variant!==GATEWAY_PRODUCT.variant))throw Error('网关产品与硬件型号不匹配');
  const cert=data.app_cert_sha256??existing?.app_cert_sha256,abi=data.app_abi??existing?.app_abi;
  if(cert!==GATEWAY_PRODUCT.certSha256||abi!==GATEWAY_PRODUCT.abi)throw Error('网关应用签名或架构不匹配');
  return {product_id:product,app_package:packageName,app_cert_sha256:cert,app_abi:abi};
}
export function gatewayReportGuard(device,data){
  if(!isGateway(device))return;
  if(data.status_only!==true)throw Error('网关必须采用显式管理能力协议');
  if(data.network!=null&&!['wifi','cellular','ethernet','unknown'].includes(data.network))throw Error('网关网络类型无效');
  if(data.battery!=null&&(typeof data.battery!=='number'||!Number.isFinite(data.battery)||data.battery<0||data.battery>100))throw Error('网关电量无效');
  if(data.charging!=null&&typeof data.charging!=='boolean')throw Error('网关充电状态无效');
  if(data.managed_media===true||data.managed_media_prepare_v1===true
    ||(Object.hasOwn(data,'managed_media_modes')&&(!Array.isArray(data.managed_media_modes)||data.managed_media_modes.length)))
    throw Error('网关不提供媒体会话，请使用普通警报任务');
  if(data.managed_wipe_v1===true||data.managed_lost_v2===true||data.managed_lost_safety_v1===true)
    throw Error('网关尚未接入该丢失模式协议');
}
export function gatewayStatus(value){
  if(value==null)return null;
  if(typeof value!=='object'||Array.isArray(value))throw Error('网关状态格式无效');
  const result={};
  for(const key of ['running','sip_registered','busy']){
    if(value[key]!=null&&typeof value[key]!=='boolean')throw Error('网关状态必须为布尔值或未知');
    result[key]=value[key]??null;
  }
  return result;
}
