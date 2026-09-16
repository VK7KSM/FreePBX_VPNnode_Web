import {GATEWAY_PRODUCT} from './gateway-product.js';

const STALE_REPORT=Object.freeze({
  device_id:'dev_mu0jw89ap2vidt',
  report_id:'b25c8e0e-013f-4a97-97b4-b3c59a55c8ed',
  app_version:'1.5.0-gateway-alpha50-lost-message-ready',
  update_job_id:'update-7e2a86e1-41b0-402f-81c0-3d6cd6caf6e4',
  update_version_code:57
});

function reportMatches(device,data){
  return device?.id===STALE_REPORT.device_id
    && device.product_id===GATEWAY_PRODUCT.product_id
    && device.app_package===GATEWAY_PRODUCT.app_package
    && device.model_id===GATEWAY_PRODUCT.model_id
    && device.app_cert_sha256===GATEWAY_PRODUCT.certSha256
    && device.app_abi===GATEWAY_PRODUCT.abi
    && data?.device_id===STALE_REPORT.device_id
    && data.report_id===STALE_REPORT.report_id
    && data.app_version===STALE_REPORT.app_version
    && data.product_id===GATEWAY_PRODUCT.product_id
    && data.app_package===GATEWAY_PRODUCT.app_package
    && data.model_id===GATEWAY_PRODUCT.model_id
    && data.app_cert_sha256===GATEWAY_PRODUCT.certSha256
    && data.app_abi===GATEWAY_PRODUCT.abi
    && data.status_only===true;
}

function rollbackMatches(update){
  return update?.state==='rollback'
    && update.job_id===STALE_REPORT.update_job_id
    && update.versionName===STALE_REPORT.app_version
    && update.versionCode===STALE_REPORT.update_version_code;
}

function response(device,duplicate){
  return {
    ok:true,
    paired:device.paired!==false,
    server_time:Date.now(),
    unpaired_at_ms:device.unpaired_at_ms||0,
    duplicate,
    stale_discarded:true,
    report_id:STALE_REPORT.report_id
  };
}

export async function acknowledgeStaleGatewayRollbackReport(storage,device,data){
  if(!reportMatches(device,data))return null;
  const key='stale-report-ack/'+STALE_REPORT.device_id+'/'+STALE_REPORT.report_id;
  const acknowledged=await storage.get(key);
  if(acknowledged)return response(device,true);
  if(!rollbackMatches(device.update))throw Error('陈旧报告的回滚事务不匹配');
  await storage.put(key,{
    device_id:STALE_REPORT.device_id,
    report_id:STALE_REPORT.report_id,
    app_version:STALE_REPORT.app_version,
    update_job_id:STALE_REPORT.update_job_id,
    acknowledged_at:new Date().toISOString()
  });
  return response(device,false);
}
