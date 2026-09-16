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
  if(!isGateway(device)){
    if(Object.hasOwn(data,'managed_mobile_status')||Object.hasOwn(data,'mobile_network'))
      throw Error('移动网络状态仅限网关产品');
    return;
  }
  if(data.status_only!==true)throw Error('网关必须采用显式管理能力协议');
  for(const field of ['managed_wifi_scan_tasks','managed_wifi_config_tasks'])
    if(Object.hasOwn(data,field)&&typeof data[field]!=='boolean')throw Error('网关 Wi-Fi 能力必须为布尔值');
  if(Object.hasOwn(data,'managed_mobile_status')&&typeof data.managed_mobile_status!=='boolean')
    throw Error('网关移动网络状态能力必须为布尔值');
  if(data.managed_config_tasks===true)throw Error('网关不得声明整套安卓配置能力');
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

const MOBILE_NETWORK_FIELDS=['schema_version','write_locked','available','active_subscription_count','sim_ready',
  'default_data_subscription_valid','data_switch_readable','mobile_data_enabled','current_data_network_type',
  'carrier_config_readable','apn_provider_readable'];
const MOBILE_NETWORK_TYPES=new Set(['unknown','gprs','edge','umts','hsdpa','hsupa','hspa','cdma','1xrtt','evdo_0',
  'evdo_a','evdo_b','ehrpd','iden','hspap','lte','td_scdma','iwlan','nr']);
export function mobileNetworkStatus(value,device,managed){
  if(!isGateway(device)){
    if(value!==undefined||managed!==undefined)throw Error('移动网络状态仅限网关产品');
    return null;
  }
  if(managed!==true){
    if(value!==undefined)throw Error('设备未声明移动网络状态能力');
    return null;
  }
  if(!record(value))throw Error('移动网络状态格式无效');
  if(new TextEncoder().encode(JSON.stringify(value)).length>1024)throw Error('移动网络状态内容过长');
  exactFields(value,MOBILE_NETWORK_FIELDS,MOBILE_NETWORK_FIELDS,'移动网络状态字段无效');
  if(value.schema_version!==1||value.write_locked!==true)throw Error('移动网络状态版本或只读标记无效');
  const result={schema_version:1,write_locked:true,
    available:requiredBoolean(value,'available','移动网络可用状态必须为布尔值')};
  if(!Number.isInteger(value.active_subscription_count)||value.active_subscription_count<0||value.active_subscription_count>8)
    throw Error('活动订阅数量无效');
  result.active_subscription_count=value.active_subscription_count;
  for(const key of ['sim_ready','default_data_subscription_valid','data_switch_readable','carrier_config_readable','apn_provider_readable'])
    result[key]=requiredBoolean(value,key,'移动网络状态必须为布尔值');
  if(!MOBILE_NETWORK_TYPES.has(value.current_data_network_type))throw Error('移动网络类型无效');
  result.current_data_network_type=value.current_data_network_type;
  if(result.data_switch_readable){
    if(typeof value.mobile_data_enabled!=='boolean')throw Error('移动数据开关状态无效');
    result.mobile_data_enabled=value.mobile_data_enabled;
  }else{
    if(value.mobile_data_enabled!==null)throw Error('不可读的移动数据开关必须为 null');
    result.mobile_data_enabled=null;
  }
  if(!result.available){
    const unavailable=result.active_subscription_count===0&&!result.sim_ready&&!result.default_data_subscription_valid
      &&!result.data_switch_readable&&result.mobile_data_enabled===null&&result.current_data_network_type==='unknown'
      &&!result.carrier_config_readable&&!result.apn_provider_readable;
    if(!unavailable)throw Error('不可用的移动网络状态必须使用固定值');
  }
  return result;
}

const PIXEL_RUNTIME_FIELDS=['schema_version','assets_verified','mode','recognized','enabled','write_locked','charge_bypass','sip_audio_access'];
const PIXEL_MODULE_FIELDS=['installed','disabled','recognized','version','files_verified'];
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function exactFields(value,allowed,required,message){
  const keys=Object.keys(value);
  if(keys.some(key=>!allowed.includes(key))||required.some(key=>!Object.hasOwn(value,key)))throw Error(message);
}
function requiredBoolean(value,key,message){
  if(typeof value[key]!=='boolean')throw Error(message);
  return value[key];
}
function boundedString(value,max,message){
  if(typeof value!=='string'||value.length<1||value.length>max||/[\u0000-\u001f\u007f]/.test(value))throw Error(message);
  return value;
}
function pixelModuleStatus(value){
  if(!record(value))throw Error('Pixel模块状态格式无效');
  exactFields(value,PIXEL_MODULE_FIELDS,['installed','disabled','recognized','files_verified'],'Pixel模块状态字段无效');
  const result={
    installed:requiredBoolean(value,'installed','Pixel模块状态必须为布尔值'),
    disabled:requiredBoolean(value,'disabled','Pixel模块状态必须为布尔值'),
    recognized:requiredBoolean(value,'recognized','Pixel模块状态必须为布尔值'),
    files_verified:requiredBoolean(value,'files_verified','Pixel模块状态必须为布尔值')
  };
  if(Object.hasOwn(value,'version'))result.version=boundedString(value.version,64,'Pixel模块版本无效');
  return result;
}
export function pixelRuntimeStatus(value,device){
  if(!isGateway(device)){
    if(value!==undefined)throw Error('Pixel运行状态仅限网关产品');
    return null;
  }
  if(value===undefined)return null;
  if(!record(value))throw Error('Pixel运行状态格式无效');
  if(new TextEncoder().encode(JSON.stringify(value)).length>2048)throw Error('Pixel运行状态内容过长');
  exactFields(value,PIXEL_RUNTIME_FIELDS,PIXEL_RUNTIME_FIELDS,'Pixel运行状态字段无效');
  if(value.schema_version!==1)throw Error('Pixel运行状态版本无效');
  return {
    schema_version:1,
    assets_verified:requiredBoolean(value,'assets_verified','Pixel运行状态必须为布尔值'),
    mode:boundedString(value.mode,32,'Pixel运行模式无效'),
    recognized:requiredBoolean(value,'recognized','Pixel运行状态必须为布尔值'),
    enabled:requiredBoolean(value,'enabled','Pixel运行状态必须为布尔值'),
    write_locked:requiredBoolean(value,'write_locked','Pixel运行状态必须为布尔值'),
    charge_bypass:pixelModuleStatus(value.charge_bypass),
    sip_audio_access:pixelModuleStatus(value.sip_audio_access)
  };
}
