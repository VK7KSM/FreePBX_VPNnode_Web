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
    // 代理能力不再是网关专有：D31 也要上报 managed_proxy_tasks 与 proxy_runtime，
    // 它们的合法性由 proxyRuntimeStatus 按能力位单独裁决，不在这里按型号一刀切。
    // 这条守卫拒的是**整份上报**——2026-09-20 D31 升到 218 后每一轮 report 都被 400，
    // 设备的全部遥测（位置、电量、任务领取）一起死，比拒掉代理字段严重得多。
    // 其余几项仍是网关专有：移动网络、丢失信息、Pixel 伴随组件，D31 不该带。
    if(Object.hasOwn(data,'managed_mobile_status')||Object.hasOwn(data,'mobile_network')
      ||Object.hasOwn(data,'managed_lost_message_v1')||Object.hasOwn(data,'managed_pixel_companion_v1'))
      throw Error('网关专用状态仅限网关产品');
    return;
  }
  if(data.status_only!==true)throw Error('网关必须采用显式管理能力协议');
  for(const field of ['managed_wifi_scan_tasks','managed_wifi_config_tasks'])
    if(Object.hasOwn(data,field)&&typeof data[field]!=='boolean')throw Error('网关 Wi-Fi 能力必须为布尔值');
  if(Object.hasOwn(data,'managed_mobile_status')&&typeof data.managed_mobile_status!=='boolean')
    throw Error('网关移动网络状态能力必须为布尔值');
  if(Object.hasOwn(data,'managed_proxy_tasks')&&typeof data.managed_proxy_tasks!=='boolean')
    throw Error('网关代理任务能力必须为布尔值');
  if(Object.hasOwn(data,'managed_lost_message_v1')&&typeof data.managed_lost_message_v1!=='boolean')
    throw Error('网关丢失信息能力必须为布尔值');
  if(Object.hasOwn(data,'managed_pixel_companion_v1')&&typeof data.managed_pixel_companion_v1!=='boolean')
    throw Error('Pixel伴随组件能力必须为布尔值');
  if(data.managed_proxy_tasks===true&&!Object.hasOwn(data,'proxy_runtime'))
    throw Error('网关代理任务能力缺少运行状态');
  if(data.managed_config_tasks===true)throw Error('网关不得声明整套安卓配置能力');
  if(data.network!=null&&!['wifi','cellular','ethernet','unknown'].includes(data.network))throw Error('网关网络类型无效');
  if(data.battery!=null&&(typeof data.battery!=='number'||!Number.isFinite(data.battery)||data.battery<0||data.battery>100))throw Error('网关电量无效');
  if(data.charging!=null&&typeof data.charging!=='boolean')throw Error('网关充电状态无效');
  if(data.managed_media===true||data.managed_media_prepare_v1===true
    ||(Object.hasOwn(data,'managed_media_modes')&&(!Array.isArray(data.managed_media_modes)||data.managed_media_modes.length)))
    throw Error('网关不提供媒体会话，请使用普通警报任务');
  if(data.managed_lost_tasks===true||data.managed_wipe_v1===true||data.managed_lost_v2===true||data.managed_lost_safety_v1===true)
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

const PIXEL_RUNTIME_FIELDS=['schema_version','assets_verified','mode','recognized','enabled','write_locked','charge_bypass','sip_audio_access','companion'];
const PIXEL_RUNTIME_REQUIRED=['schema_version','assets_verified','mode','recognized','enabled','write_locked','charge_bypass','sip_audio_access'];
const PIXEL_RUNTIME_MODES=new Set(['legacy_managed','companion_staged','companion_active','unavailable','asset_verification_failed','invalid_snapshot']);
const PIXEL_MODULE_FIELDS=['installed','disabled','recognized','version','files_verified'];
const PIXEL_COMPANION_FIELDS=['installed','disabled','recognized','active','rollback_available','units','version'];
const PIXEL_COMPANION_REQUIRED=['installed','disabled','recognized','active','rollback_available','units'];
const PIXEL_COMPANION_UNIT_FIELDS=['charge','audio','adb_tcp'];
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
function pixelCompanionStatus(value){
  if(!record(value))throw Error('Pixel伴随组件状态格式无效');
  exactFields(value,PIXEL_COMPANION_FIELDS,PIXEL_COMPANION_REQUIRED,'Pixel伴随组件状态字段无效');
  if(!record(value.units))throw Error('Pixel伴随组件单元状态格式无效');
  exactFields(value.units,PIXEL_COMPANION_UNIT_FIELDS,PIXEL_COMPANION_UNIT_FIELDS,'Pixel伴随组件单元状态字段无效');
  const result={};
  for(const key of ['installed','disabled','recognized','active','rollback_available'])
    result[key]=requiredBoolean(value,key,'Pixel伴随组件状态必须为布尔值');
  result.units={};
  for(const key of PIXEL_COMPANION_UNIT_FIELDS)
    result.units[key]=requiredBoolean(value.units,key,'Pixel伴随组件单元状态必须为布尔值');
  if(Object.hasOwn(value,'version'))result.version=boundedString(value.version,64,'Pixel伴随组件版本无效');
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
  exactFields(value,PIXEL_RUNTIME_FIELDS,PIXEL_RUNTIME_REQUIRED,'Pixel运行状态字段无效');
  if(value.schema_version!==1)throw Error('Pixel运行状态版本无效');
  if(!PIXEL_RUNTIME_MODES.has(value.mode))throw Error('Pixel运行模式无效');
  const result={
    schema_version:1,
    assets_verified:requiredBoolean(value,'assets_verified','Pixel运行状态必须为布尔值'),
    mode:value.mode,
    recognized:requiredBoolean(value,'recognized','Pixel运行状态必须为布尔值'),
    enabled:requiredBoolean(value,'enabled','Pixel运行状态必须为布尔值'),
    write_locked:requiredBoolean(value,'write_locked','Pixel运行状态必须为布尔值'),
    charge_bypass:pixelModuleStatus(value.charge_bypass),
    sip_audio_access:pixelModuleStatus(value.sip_audio_access)
  };
  if(Object.hasOwn(value,'companion'))result.companion=pixelCompanionStatus(value.companion);
  return result;
}

const PROXY_RUNTIME_FIELDS=['schema_version','bundled','version','abi','asset_verified','core_verified','configured',
  'running','http_ready','socks_ready','proxy_reachable','management_via','write_locked','checked_at_ms','error',
  'config_version','config_sha256','management_https_via_proxy','management_mqtt_via_proxy',
  'adb_wss_via_proxy_ready','file_download_via_proxy_ready','error_category'];
const PROXY_RUNTIME_REQUIRED=['schema_version','bundled','version','abi','asset_verified','core_verified','configured',
  'running','http_ready','socks_ready','proxy_reachable','management_via','write_locked'];
// v2 原来是「恰好这 16 个键」的精确集合，于是设备无法上报配置身份与错误类别——
// 而回执校验只认 schema_version===2，退回 v1 也不行。核心改为按需下载之后，
// 「装了哪一版配置」「为什么失败」恰恰是最需要看的两件事，所以把 v1 那几个可选键在 v2 里也放开。
const PROXY_RUNTIME_V2_REQUIRED=[...PROXY_RUNTIME_REQUIRED,'http_port','socks_port','checked_at_ms'];
const PROXY_RUNTIME_V2_FIELDS=[...PROXY_RUNTIME_V2_REQUIRED,'error','config_version','config_sha256',
  'management_https_via_proxy','management_mqtt_via_proxy','adb_wss_via_proxy_ready','file_download_via_proxy_ready','error_category'];
export const PROXY_ERROR_CATEGORIES=Object.freeze(['none','not_configured','core_missing','core_verification_failed',
  'config_invalid','config_read_failed','config_hash_mismatch','process_start_failed','process_stop_failed','process_not_running','listener_unavailable',
  'proxy_unreachable','https_test_failed','mqtt_test_failed','adb_wss_test_failed','file_download_test_failed',
  'rollback_failed','unknown']);
const proxyErrorCategories=new Set(PROXY_ERROR_CATEGORIES);

// 核心按需下载之后「未安装」是正常态，这时没有版本可报，允许 null。
// 但只在确实没装的时候允许：已验证装好了却报不出版本，那是设备侧的 bug，不能放过去。
function coreVersion(value){
  if(value.version===null||value.version===''){
    if(value.asset_verified===true||value.core_verified===true)throw Error('核心已就绪却未报版本');
    return null;
  }
  const version=boundedString(value.version,32,'代理核心版本无效');
  if(!/^v?[0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9._-]{1,16})?$/.test(version))throw Error('代理核心版本无效');
  return version;
}

export function proxyRuntimeStatus(value,device,managed){
  // 原来只认网关产品（isGateway）。D31 同样要上报这一段，判据改成设备自己声明的能力位：
  // 声明了就按同一套字段收，没声明还上报才是越界。按型号划线会逼着为一台设备改公共合同。
  // 明确声明 false 是允许的（基础版固件），此时只是不收运行状态，不算错误。
  if(managed!==undefined&&typeof managed!=='boolean')throw Error('代理任务能力必须为布尔值');
  const declared=managed===true||(managed===undefined&&device?.managed_proxy_tasks===true);
  if(!declared){
    if(value!==undefined)throw Error('设备未声明代理管理能力，不能上报代理运行状态');
    return null;
  }
  if(value===undefined)return null;
  if(!record(value))throw Error('代理运行状态格式无效');
  if(new TextEncoder().encode(JSON.stringify(value)).length>4096)throw Error('代理运行状态内容过长');
  if(value.schema_version===2){
    exactFields(value,PROXY_RUNTIME_V2_FIELDS,PROXY_RUNTIME_V2_REQUIRED,'代理运行状态字段无效');
    // bundled 不再硬判 true：代理核心改为按需下载，不随 APK 打包，D31 会报 false。
    // asset_verified 的语义相应变为「核心已下载且用内置公钥验签通过」，不再是「随包自带且哈希相符」。
    if(typeof value.bundled!=='boolean'||value.abi!=='arm64-v8a'||value.write_locked!==true)throw Error('代理运行状态版本或只读标记无效');
    const version=coreVersion(value);
    const result={schema_version:2,bundled:value.bundled,version,abi:'arm64-v8a'};
    for(const key of ['asset_verified','core_verified','configured','running','http_ready','socks_ready','proxy_reachable'])
      result[key]=requiredBoolean(value,key,'代理运行状态必须为布尔值');
    if(!['direct','proxy'].includes(value.management_via)||value.http_port!==17890||value.socks_port!==17891
        ||!Number.isSafeInteger(value.checked_at_ms)||value.checked_at_ms<=0)throw Error('代理运行状态边界无效');
    Object.assign(result,{management_via:value.management_via,write_locked:true,
      http_port:17890,socks_port:17891,checked_at_ms:value.checked_at_ms});
    return proxyOptionalFields(value,result);
  }
  exactFields(value,PROXY_RUNTIME_FIELDS,PROXY_RUNTIME_REQUIRED,'代理运行状态字段无效');
  if(value.schema_version!==1||typeof value.bundled!=='boolean'||value.abi!=='arm64-v8a'||value.write_locked!==true)
    throw Error('代理运行状态版本或只读标记无效');
  const version=coreVersion(value);
  const result={schema_version:1,bundled:value.bundled,version,abi:'arm64-v8a'};
  for(const key of ['asset_verified','core_verified','configured','running','http_ready','socks_ready','proxy_reachable'])
    result[key]=requiredBoolean(value,key,'代理运行状态必须为布尔值');
  if(!['direct','proxy'].includes(value.management_via))throw Error('代理管理通道无效');
  result.management_via=value.management_via;result.write_locked=true;
  if(Object.hasOwn(value,'checked_at_ms')){
    if(!Number.isSafeInteger(value.checked_at_ms)||value.checked_at_ms<=0)throw Error('代理检查时间无效');
    result.checked_at_ms=value.checked_at_ms;
  }
  return proxyOptionalFields(value,result);
}

// 配置身份、代理路径与错误类别。v1 与 v2 共用同一套语义——v2 原先根本不收这几项，
// 于是设备报不出「装的是哪一版配置」和「为什么失败」，而这两件正是按需下载之后最该看的。
function proxyOptionalFields(value,result){
  if(Object.hasOwn(value,'config_version')){
    if(value.config_version!==null)result.config_version=boundedString(value.config_version,64,'代理配置版本无效');
    else result.config_version=null;
  }
  if(Object.hasOwn(value,'config_sha256')){
    if(value.config_sha256!==null&&(!/^[a-f0-9]{64}$/.test(value.config_sha256)))throw Error('代理配置校验值无效');
    result.config_sha256=value.config_sha256;
  }
  for(const key of ['management_https_via_proxy','management_mqtt_via_proxy','adb_wss_via_proxy_ready','file_download_via_proxy_ready'])
    if(Object.hasOwn(value,key))result[key]=requiredBoolean(value,key,'代理路径状态必须为布尔值');
  let category=value.error_category;
  if(Object.hasOwn(value,'error')){
    if(typeof value.error!=='string'||value.error.length<1||value.error.length>64||!/^[A-Za-z][A-Za-z0-9_$]*$/.test(value.error))
      throw Error('代理错误类别无效');
    category=value.error==='unavailable'?'unknown':category??'unknown';
  }
  if(category!==undefined){if(!proxyErrorCategories.has(category))throw Error('代理错误类别无效');result.error_category=category;}
  if(result.configured&&Object.hasOwn(result,'config_sha256')&&result.config_sha256===null)throw Error('代理配置身份缺失');
  if(!result.configured&&(result.config_version!=null||result.config_sha256!=null))throw Error('未配置状态不能携带配置身份');
  return result;
}

// ——— 第 3 步：节点列表、分应用、流量与出口地区 ———
// 这四个字段都走「缺席 ≠ 清空」：设备为省流量只在首轮和内容变化时带，
// 其余轮次不带。返回 undefined 表示「这轮没报」，调用方保留既有值；
// 返回 [] 表示设备确实报了一份空清单。两者混为一谈会让面板在设备正常运行时突然空掉。

// 不能走代理的只有**管理程序本身**，不是整个 net.elfradio 命名空间。
// 2026-09-21 D31-dev 指出这条划错了：D31 上有四个 net.elfradio 包，只有 d31bootstrap 是管理程序，
// 另外三个（Zello 守护、自研 SIP 客户端、d31system）都是普通应用，走不走代理是使用者的选择，
// 与管理连接的安全毫无关系。按命名空间拒的话，使用者勾一下「Zello 守护」就会触发拒绝——
// 而 Zello 守护本就在设备默认名单里，等于开箱即炸。
// 理由回到根上：要守的是「设备不能把自己的管理连接送进隧道」，那只与管理程序这一个包有关。
const MANAGEMENT_PACKAGES = Object.freeze([
  'net.elfradio.elfremote',      // D22 管理程序
  'net.elfradio.d31bootstrap',   // D31 管理程序
  'org.onetwoone.gateway'        // Pixel 网关管理程序
]);
/** 精确匹配，或其子变体（.debug / .preview）。d31phone.debug 这类不同包名不会被误伤。 */
export function isManagementPackage(value) {
  const pkg = String(value || '');
  return MANAGEMENT_PACKAGES.some(name => pkg === name || pkg.startsWith(name + '.'));
}
export { MANAGEMENT_PACKAGES };

const PROXY_NODE_KINDS=Object.freeze(['node','auto','direct']);
const MAX_PROXY_NODES=64;
const MAX_INSTALLED_APPS=64;
const PACKAGE_PATTERN=/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;

function proxyCapabilityDeclared(device,managed,what){
  if(managed!==undefined&&typeof managed!=='boolean')throw Error('代理任务能力必须为布尔值');
  return managed===true||(managed===undefined&&device?.managed_proxy_tasks===true);
}
// 超限一律拒整条上报，不静默截断：截成半截的清单在面板上看不出是截断还是设备真没有，
// 操作者会照着一份缺项的名单做判断。
function sizeGuard(value,limit,message){
  if(new TextEncoder().encode(JSON.stringify(value)).length>limit)throw Error(message);
}

/** 配置里的节点及其实测延迟。名字唯一、至多一个选中。 */
export function proxyNodeList(value,device,managed){
  const declared=proxyCapabilityDeclared(device,managed);
  if(!declared){
    if(value!==undefined)throw Error('设备未声明代理管理能力，不能上报代理节点');
    return undefined;
  }
  if(value===undefined)return undefined;
  if(!Array.isArray(value))throw Error('代理节点列表格式无效');
  if(value.length>MAX_PROXY_NODES)throw Error('代理节点数量超出上限');
  sizeGuard(value,8192,'代理节点列表内容过长');
  const names=new Set();let selected=0;
  const nodes=value.map(item=>{
    if(!record(item))throw Error('代理节点格式无效');
    exactFields(item,['name','delay_ms','tested_at_ms','selected','kind'],
      ['name','delay_ms','tested_at_ms','selected','kind'],'代理节点字段无效');
    const name=boundedString(item.name,64,'代理节点名称无效');
    if(names.has(name))throw Error('代理节点名称重复');
    names.add(name);
    if(!PROXY_NODE_KINDS.includes(item.kind))throw Error('代理节点类别无效');
    // 未测过就是 null。延迟上限取 600000ms——超过十分钟的「延迟」只能是设备侧算错了。
    if(item.delay_ms!==null&&(!Number.isSafeInteger(item.delay_ms)||item.delay_ms<0||item.delay_ms>600000))
      throw Error('代理节点延迟无效');
    if(item.tested_at_ms!==null&&(!Number.isSafeInteger(item.tested_at_ms)||item.tested_at_ms<=0))
      throw Error('代理节点测速时间无效');
    if(item.delay_ms!==null&&item.tested_at_ms===null)throw Error('有延迟却无测速时间');
    if(requiredBoolean(item,'selected','代理节点选中态必须为布尔值'))selected++;
    return {name,delay_ms:item.delay_ms,tested_at_ms:item.tested_at_ms,selected:item.selected,kind:item.kind};
  });
  if(selected>1)throw Error('代理节点选中态不唯一');
  return nodes;
}

/** 设备上可启动的应用，供面板渲染「哪些程序走代理」的勾选清单。 */
export function installedAppList(value,device,managed){
  const declared=proxyCapabilityDeclared(device,managed);
  if(!declared){
    if(value!==undefined)throw Error('设备未声明代理管理能力，不能上报应用清单');
    return undefined;
  }
  if(value===undefined)return undefined;
  if(!Array.isArray(value))throw Error('应用清单格式无效');
  if(value.length>MAX_INSTALLED_APPS)throw Error('应用数量超出上限');
  sizeGuard(value,8192,'应用清单内容过长');
  const packages=new Set();
  return value.map(item=>{
    if(!record(item))throw Error('应用条目格式无效');
    exactFields(item,['package','uid','label','system'],['package','label','system'],'应用条目字段无效');
    const pkg=boundedString(item.package,128,'应用包名无效');
    if(!PACKAGE_PATTERN.test(pkg))throw Error('应用包名无效');
    if(packages.has(pkg))throw Error('应用包名重复');
    packages.add(pkg);
    // uid 校验但不落库：它随重装变化，存下来迟早和现场对不上，
    // 而下发名单走的是包名，服务端根本不需要 uid。面板宁可不显示，也不显示一个会过期的值。
    if(Object.hasOwn(item,'uid')&&(!Number.isSafeInteger(item.uid)||item.uid<0))throw Error('应用 uid 无效');
    return {package:pkg,label:boundedString(item.label,64,'应用名称无效'),
      system:requiredBoolean(item,'system','应用系统标记必须为布尔值')};
  });
}



/** 设备当前生效的分流名单。设备本机也能改这份名单，所以它要能从上报回来——
 *  只认面板下发的话，用户在座机上改完，面板会长期显示一份过期名单，那是假状态。
 *  自家包名照样拒：设备侧已经拦一道，这里是第二道，代价是设备失联且无法远程恢复。 */
export function proxyAppList(value,device,managed){
  const declared=proxyCapabilityDeclared(device,managed);
  if(!declared){
    if(value!==undefined)throw Error('设备未声明代理管理能力，不能上报代理应用名单');
    return undefined;
  }
  if(value===undefined)return undefined;
  if(!Array.isArray(value))throw Error('代理应用名单格式无效');
  if(value.length>MAX_INSTALLED_APPS)throw Error('代理应用数量超出上限');
  sizeGuard(value,8192,'代理应用名单内容过长');
  const seen=new Set();
  return value.map(pkg=>{
    const name=boundedString(pkg,128,'代理应用包名无效');
    if(!PACKAGE_PATTERN.test(name))throw Error('代理应用包名无效');
    if(seen.has(name))throw Error('代理应用包名重复');
    seen.add(name);
    return name;
  }).filter(name=>{
    // 上报这条路只丢掉管理程序那一条，其余照收，**绝不拒整份上报**。
    // 拒整份的代价是位置、电量、任务领取一起死，而且设备每轮都带同一份名单，
    // 是持续性失联——与「使用者勾错一个应用」完全不成比例。218 那次已经演过一遍。
    // 设备侧也会过滤，这里是第二道网，正常情况下不会触发。
    return !isManagementPackage(name);
  });
}
