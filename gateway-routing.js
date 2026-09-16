const PRODUCT_ID = 'elfremote_gateway';
const TARGET = 'gateway_routing';
const MODES = ['sip_first','answer_first'];
const ROUTING_FIELDS = ['schema_version','sim1_destination','sim2_destination','incoming_mode','last_config_task_id'];
const RESULT_FIELDS = ['target','action','applied','verified','exit_code','sim1_destination','sim2_destination','incoming_mode'];

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const destination = (value, optional = false) => typeof value === 'string'
  && (optional && value === '' || /^\d{1,15}$/.test(value));

function exactFields(value, allowed, required, message) {
  if (!record(value)) throw Error(message);
  const keys = Object.keys(value);
  if (keys.some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value,key))) throw Error(message);
}

function normalizedValues(value, message) {
  const sim1 = value.sim1_destination;
  const sim2 = value.sim2_destination;
  const mode = value.incoming_mode;
  if (!destination(sim1) || !destination(sim2,true) || sim2 && sim1 === sim2 || !MODES.includes(mode)) throw Error(message);
  return {sim1_destination:sim1,sim2_destination:sim2,incoming_mode:mode};
}

export function gatewayRoutingParams(value) {
  exactFields(value,['target','sim1_destination','sim2_destination','incoming_mode'],
    ['target','sim1_destination','sim2_destination','incoming_mode'],'SIP Gateway路由参数无效');
  if (value.target !== TARGET) throw Error('SIP Gateway路由目标无效');
  return {target:TARGET,...normalizedValues(value,'SIP Gateway路由参数无效')};
}

export function gatewayRoutingReport(data, device) {
  const gateway = device?.product_id === PRODUCT_ID;
  const hasCapability = Object.hasOwn(data,'managed_gateway_routing');
  const hasStatus = Object.hasOwn(data,'gateway_routing');
  if (!gateway) {
    if (hasCapability || hasStatus) throw Error('SIP Gateway路由状态仅限网关产品');
    return {managed:false,status:null};
  }
  if (hasCapability && typeof data.managed_gateway_routing !== 'boolean') throw Error('SIP Gateway路由能力无效');
  const managed = data.managed_gateway_routing === true;
  if (!hasStatus) return {managed,status:null};
  if (!managed) throw Error('SIP Gateway路由状态缺少管理能力');
  const value = data.gateway_routing;
  exactFields(value,ROUTING_FIELDS,ROUTING_FIELDS.slice(0,4),'SIP Gateway路由状态字段无效');
  if (new TextEncoder().encode(JSON.stringify(value)).length > 512 || value.schema_version !== 1)
    throw Error('SIP Gateway路由状态版本无效');
  const status = {schema_version:1,...normalizedValues(value,'SIP Gateway路由状态无效')};
  if (Object.hasOwn(value,'last_config_task_id')) {
    if (typeof value.last_config_task_id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(value.last_config_task_id))
      throw Error('SIP Gateway路由任务编号无效');
    status.last_config_task_id=value.last_config_task_id;
  }
  return {managed,status};
}

export function gatewayRoutingResult(value, params) {
  exactFields(value,RESULT_FIELDS,RESULT_FIELDS,'SIP Gateway路由完成证据无效');
  const expected = gatewayRoutingParams(params);
  if (value.target !== TARGET || value.action !== 'completed' || value.applied !== true
      || value.verified !== true || value.exit_code !== 0) throw Error('SIP Gateway路由完成证据无效');
  const applied = normalizedValues(value,'SIP Gateway路由完成证据无效');
  if (applied.sim1_destination !== expected.sim1_destination
      || applied.sim2_destination !== expected.sim2_destination
      || applied.incoming_mode !== expected.incoming_mode) throw Error('SIP Gateway路由完成结果与任务不匹配');
  return {target:TARGET,action:'completed',applied:true,verified:true,exit_code:0,...applied};
}

export function saveGatewayRoutingResult(device, taskId, value, completedAt) {
  device.gateway_routing_result={task_id:taskId,...value,completed_at:completedAt,report_confirmed:false};
  return device.gateway_routing_result;
}

export function applyGatewayRoutingReport(device, status, receivedAt) {
  if (!status) return null;
  device.gateway_routing=status;
  const result=device.gateway_routing_result;
  const received=Date.parse(receivedAt);
  const completed=Date.parse(result?.completed_at);
  if (result && status.last_config_task_id === result.task_id
      && status.sim1_destination === result.sim1_destination
      && status.sim2_destination === result.sim2_destination
      && status.incoming_mode === result.incoming_mode && Number.isFinite(received)
      && Number.isFinite(completed) && received >= completed) {
    result.report_confirmed=true;
    result.reported_at=receivedAt;
  }
  return status;
}
