// MCP 协议层：JSON-RPC 收发、工具清单、资源清单。
//
// 这里**不含任何业务逻辑**。工具的实现由调用方通过 ctx.call 注入，
// 那边直接调现成的任务接口，和网页走同一段代码——总计划里写死的形态是
// 「薄封装，不复制另一份业务流程」。
//
// 设备由令牌决定，所以下面每个工具的参数表里都**没有 device_id**。
// 模型想传错设备都没有地方可传。
export const PROTOCOL_VERSION='2025-06-18';
export const SUPPORTED_PROTOCOLS=Object.freeze(['2025-06-18','2025-03-26']);
export const GUIDE_URI='elfremote://guide';

const str=(description,extra={})=>({type:'string',description,...extra});

/**
 * 工具说明文字就是给模型看的文档：写「执行命令」它只能瞎猜，
 * 写清楚触发条件、超时和失败含义，它才知道什么时候该用、失败了是什么意思。
 */
function catalogue(deviceName){
  const on='（本工具固定作用于 '+deviceName+'，无需也无法指定其他设备）';
  return [
    {scope:'device_info',name:'device_info',
     description:'读取 '+deviceName+' 的当前状态：客户端版本、在线与最后上报时间、电量、网络、定位、以及各项能力位。'
       +'能力位决定哪些操作此刻可用——例如 managed_exec_tasks 为 false 时 run 一定失败。排查任何问题都应先调这个。'+on,
     inputSchema:{type:'object',properties:{},additionalProperties:false}},

    {scope:'run',name:'run',
     description:'在 '+deviceName+' 上以 root 执行一条 shell 命令，等待完成并返回退出码与合并输出。'
       +'命令经推送即时下发，通常数秒返回；默认 30 秒超时，超时返回任务编号可用 task_status 继续查。'
       +'要求设备 managed_exec_tasks 为 true。一次只跑一条命令，需要多条就调多次——'
       +'这样哪一条失败一目了然。'+on,
     inputSchema:{type:'object',required:['command'],additionalProperties:false,properties:{
       command:str('要执行的 shell 命令，例如 ls -l /data/data/net.elfradio.elfremote/files'),
       timeout:{type:'integer',minimum:5,maximum:120,description:'秒，默认 30'}}}},

    {scope:'pull_logs',name:'pull_logs',
     description:'拉取 '+deviceName+' 的运行日志。诊断首选——设备侧发生过什么，这里看得最全。'
       +'结果作为制品保存，返回任务编号与摘要。'+on,
     inputSchema:{type:'object',properties:{},additionalProperties:false}},

    {scope:'task_status',name:'task_status',
     description:'查一个已下发任务的状态与结果，用于 run 超时后继续等、或查看 pull_logs 的产物。'+on,
     inputSchema:{type:'object',required:['task_id'],additionalProperties:false,properties:{
       task_id:str('下发时返回的任务编号')}}},

    {scope:'releases',name:'releases',
     description:'列出 '+deviceName+' 所属发布通道里可安装的版本。'
       +'同一个版本码可能有两个包：完整包（variant=full，自带 12 MB 音视频原生库，供首次装机）'
       +'与更新包（variant=slim，约 0.8 MB，日常 OTA）。选哪个见说明文档里的下发顺序规则。'+on,
     inputSchema:{type:'object',properties:{},additionalProperties:false}},

    {scope:'install',name:'install',
     description:'把某个已发布版本下发给 '+deviceName+'，设备收到后自行下载校验并安装。'
       +'**这会改变设备上实际运行的程序，且安装过程中设备会短暂不可用。**'
       +'下发前务必先用 releases 确认版本码与变体；从未装过完整包的设备不要直接下发更新包，'
       +'理由见说明文档。服务端的清单签名、证书匹配、有效期与通道校验一条不减。'+on,
     inputSchema:{type:'object',required:['versionCode'],additionalProperties:false,properties:{
       versionCode:{type:'integer',minimum:1,description:'releases 里列出的版本码'},
       variant:{type:'string',enum:['full','slim'],description:'完整包或更新包，不传按服务端规则选'}}}},

    {scope:'files',name:'files',
     description:'浏览、取回或发送 '+deviceName+' 上的文件。参数与网页文件管理一致，由设备侧校验。'+on,
     inputSchema:{type:'object',required:['params'],additionalProperties:false,properties:{
       params:{type:'object',description:'文件操作参数，形如 {action,path,...}'}}}},

    {scope:'system_config',name:'system_config',
     description:'读取或修改 '+deviceName+' 的系统设置（Wi-Fi、通信录等）。'
       +'可写范围由设备能力位与服务端白名单决定，越界会被拒。'+on,
     inputSchema:{type:'object',required:['params'],additionalProperties:false,properties:{
       params:{type:'object',description:'系统配置参数，与网页系统配置页一致'}}}}
  ];
}

/** 只列这个令牌勾选过的工具。没勾的不出现在清单里——模型看不见就不会去试。 */
export function toolsFor(scopes,deviceName){
  const granted=new Set(Array.isArray(scopes)?scopes:[]);
  return catalogue(deviceName).filter(t=>granted.has(t.scope))
    .map(({scope,...tool})=>tool);
}
export function toolScope(name,deviceName){
  return catalogue(deviceName).find(t=>t.name===name)?.scope||null;
}

const ok=(id,result)=>({jsonrpc:'2.0',id,result});
const fail=(id,code,message)=>({jsonrpc:'2.0',id,error:{code,message}});

/**
 * 处理一条 JSON-RPC 消息。通知（没有 id）返回 null，调用方不回包。
 * ctx: {scopes, deviceName, guide, call(name,args)}
 */
export async function dispatch(message,ctx){
  if(!message||typeof message!=='object'||Array.isArray(message))
    return fail(null,-32600,'请求格式错误');
  const {id=null,method}=message;
  const notification=!('id' in message)||id===null||id===undefined;
  if(typeof method!=='string')return notification?null:fail(id,-32600,'缺少方法名');

  if(method==='notifications/initialized'||method.startsWith('notifications/'))return null;

  if(method==='initialize'){
    // 协议版本按客户端要求回：它要的我们支持就原样回，不支持则回我们的版本，
    // 由客户端决定还谈不谈。硬回一个自己的版本会让老客户端直接断线。
    const asked=message.params?.protocolVersion;
    return ok(id,{
      protocolVersion:SUPPORTED_PROTOCOLS.includes(asked)?asked:PROTOCOL_VERSION,
      capabilities:{tools:{},resources:{}},
      serverInfo:{name:'elfremote',version:'1',title:'elfRemote · '+ctx.deviceName},
      instructions:'本服务器固定操作设备 '+ctx.deviceName+'。动手之前先读资源 '+GUIDE_URI+'，'
        +'那里有机型区别、能力位含义、版本下发顺序规则和不可逆操作清单。'});
  }
  if(method==='ping')return ok(id,{});

  if(method==='tools/list')return ok(id,{tools:toolsFor(ctx.scopes,ctx.deviceName)});

  if(method==='resources/list')return ok(id,{resources:[{uri:GUIDE_URI,
    name:'elfRemote 操作说明',mimeType:'text/markdown',
    description:'设备区别、能力位含义、版本下发顺序、不可逆操作与令牌管理'}]});

  if(method==='resources/read'){
    if(message.params?.uri!==GUIDE_URI)return fail(id,-32602,'没有这个资源');
    return ok(id,{contents:[{uri:GUIDE_URI,mimeType:'text/markdown',text:ctx.guide}]});
  }

  if(method==='tools/call'){
    const name=message.params?.name;
    const scope=toolScope(name,ctx.deviceName);
    if(!scope)return fail(id,-32602,'没有这个工具：'+name);
    // 没勾选的工具既不出现在清单里，被硬调也要挡——清单是给模型看的，不是权限。
    if(!(Array.isArray(ctx.scopes)&&ctx.scopes.includes(scope)))
      return fail(id,-32602,'这个令牌没有「'+name+'」权限，请在设备管理页的 MCP 弹窗里重新生成');
    try{
      const text=await ctx.call(name,message.params?.arguments||{});
      return ok(id,{content:[{type:'text',text}]});
    }catch(error){
      // 工具执行失败走 isError 而不是 JSON-RPC 错误：前者模型看得见原因、能换个做法再试，
      // 后者多数客户端直接当协议故障吞掉。
      return ok(id,{content:[{type:'text',text:'失败：'+error.message}],isError:true});
    }
  }
  return notification?null:fail(id,-32601,'不支持的方法：'+method);
}
