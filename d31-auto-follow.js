import {releaseKey, releaseListKey, deviceReleaseChannel, validateReleaseManifest, manifestChannel} from './release-channels.js';

export const D31_RECOMMENDATION_KEY = 'elfremote_recommendation_d31';
export const D31_ATTEMPT_PREFIX = 'elfremote_auto_attempt_d31/';

function authorizedIds(raw) {
  try {
    const ids = JSON.parse(raw);
    if (Array.isArray(ids) && ids.length === 3 && new Set(ids).size === 3
        && ids.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id))) return ids;
  } catch {}
  return [];
}

function d31(device, models) {
  try {
    const registered = models.filter(model => model.id === device.model_id);
    return device.hardware_identity?.variant === 'd31' && device.model_id === 'mdl_d31'
      && registered.length === 1 && registered[0].registration_key === 'd31'
      && deviceReleaseChannel(device, models) === 'd31';
  }
  catch { return false; }
}

function updateArtifact(device) {
  try {
    const update = device.update, manifest = JSON.parse(update.manifest_raw);
    if (device.hardware_identity?.variant === 'd31' && update.job_id && manifestChannel(manifest) === 'd31'
        && Number.isSafeInteger(update.versionCode) && update.versionCode > 0
        && update.versionCode === manifest.versionCode && /^[a-f0-9]{64}$/.test(manifest.sha256))
      return {update, manifest};
  } catch {}
  return null;
}

// 与原assign/progress同事务；手动任务也留防自动重试索引，显式手动重试仍走原assign。
export async function rememberD31Update(storage, device, now = Date.now()) {
  const artifact = updateArtifact(device);
  if (!artifact || !storage) return;
  const {update, manifest} = artifact;
  const key = D31_ATTEMPT_PREFIX + device.id + '/' + update.versionCode + '/' + manifest.sha256;
  if (!await storage.get(key)) await storage.put(key, {job_id: update.job_id,
    recorded_at: new Date(now).toISOString(), origin: 'existing_update'});
  if (update.state === 'success') device.d31_auto_confirmed = {versionCode: update.versionCode,
    versionName: manifest.versionName, job_id: update.job_id, installation_id: device.installation_id ?? null};
}

function validRelease(rel, now) {
  if (!rel || rel.retired_at || !rel.signature) return false;
  try {
    const m = JSON.parse(rel.manifest_raw);
    return validateReleaseManifest(m, now) === 'd31' && m.device_id === undefined
      && ['versionCode', 'versionName', 'sha256', 'size', 'certSha256', 'expires_at', 'job_id']
        .every(key => rel[key] === m[key]);
  } catch { return false; }
}

export function publicD31Recommendation(value) {
  if (!value) return null;
  const {enabled, versionCode, sha256, release_job_id, recommended_at} = value;
  return {enabled, versionCode, sha256, release_job_id, recommended_at};
}

// 仅供现有管理员assign事务调用；发布候选不调用这里。
export async function setD31Recommendation({storage, read, devices, models, allowedIds}, input, now = Date.now()) {
  if (input.channel !== 'd31') throw Error('正式推荐仅适用于D31');
  const previous = await storage.get(D31_RECOMMENDATION_KEY);
  if (input.action === 'pause_d31_auto_follow') {
    if (previous?.enabled) await storage.put(D31_RECOMMENDATION_KEY, {...previous, enabled: false});
    return publicD31Recommendation(previous ? {...previous, enabled: false} : null);
  }
  const ids = authorizedIds(allowedIds);
  if (ids.length !== 3) throw Error('尚未配置获准的三机固定ID集合');
  if (ids.some(id => !devices.some(device => device.id === id && d31(device, models))))
    throw Error('授权集合包含未登记或型号身份不匹配的设备');
  const rel = await read(releaseKey('d31', input.versionCode));
  if (!validRelease(rel, now) || input.versionCode !== rel.versionCode
      || input.sha256 !== rel.sha256 || input.release_job_id !== rel.job_id)
    throw Error('推荐必须绑定已发布、有效且通用的D31制品与发布编号');
  const job = await read('elfremote_job_' + rel.job_id);
  if (job?.channel !== 'd31' || job.versionCode !== rel.versionCode || job.manifest_raw !== rel.manifest_raw)
    throw Error('推荐发布索引不一致');
  const next = {enabled: true, versionCode: rel.versionCode, sha256: rel.sha256,
    release_job_id: rel.job_id, device_ids: ids.slice().sort(), recommended_at: new Date(now).toISOString()};
  if (previous?.enabled && previous.versionCode === next.versionCode && previous.sha256 === next.sha256
      && previous.release_job_id === next.release_job_id && JSON.stringify(previous.device_ids) === JSON.stringify(next.device_ids))
    return publicD31Recommendation(previous);
  await storage.put(D31_RECOMMENDATION_KEY, next);
  return publicD31Recommendation(next);
}

// 与设备报告及现有assign处于同一个DO串行事务；尝试记录不随update槽位覆盖而丢失。
export async function followD31Recommendation({storage, read, device, models, allowedIds, assign}, now = Date.now()) {
  if (device.enabled === false || !d31(device, models)
      || device.managed_update !== true || device.managed_update_v2 !== true
      || !authorizedIds(allowedIds).includes(device.id)) return null;
  const recommendation = await storage.get(D31_RECOMMENDATION_KEY);
  if (!recommendation?.enabled || !recommendation.device_ids.includes(device.id)) return null;
  const rel = await read(releaseKey('d31', recommendation.versionCode));
  if (!validRelease(rel, now) || rel.sha256 !== recommendation.sha256 || rel.job_id !== recommendation.release_job_id) return null;
  const key = D31_ATTEMPT_PREFIX + device.id + '/' + rel.versionCode + '/' + rel.sha256;
  if (await storage.get(key)) return null;
  const update = device.update;
  let sameArtifact = false;
  try { sameArtifact = update?.versionCode === rel.versionCode && JSON.parse(update.manifest_raw).sha256 === rel.sha256; } catch {}
  if (update?.job_id && sameArtifact) {
    await storage.put(key, {job_id: update.job_id, recorded_at: new Date(now).toISOString(), origin: 'existing_update'});
    return null;
  }
  // 即使TTL已过，已领取/安装/回滚中的资源归属仍不由自动策略覆盖。
  if (update?.job_id && !['success', 'recovered', 'rejected'].includes(update.state)
      && !(update.state === 'pending' && Number(update.expires_at) > 0 && Number(update.expires_at) <= now)) return null;
  const ids = await read(releaseListKey('d31')) || [];
  const current = [];
  for (const version of ids) {
    const row = await read(releaseKey('d31', version));
    if (row?.versionName === device.app_version) current.push(row.versionCode);
  }
  const versions = [...new Set(current)];
  if (versions.length !== 1 || !Number.isSafeInteger(versions[0]) || versions[0] >= rel.versionCode) return null;
  // success确认当前版本；recovered的versionCode是失败目标，不能拿它充当恢复后的活动版本。
  const artifact = updateArtifact(device);
  const latest = artifact?.update.state === 'success' ? artifact.update.versionCode : null;
  const saved = device.d31_auto_confirmed;
  const confirmed = saved?.installation_id === (device.installation_id ?? null) && Number.isSafeInteger(saved?.versionCode)
    ? saved.versionCode : null;
  const knownActive = Math.max(latest || 0, confirmed || 0);
  if (knownActive > versions[0] || knownActive >= rel.versionCode) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  const request_id = 'auto-d31-' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const assigned = await assign(device.id, rel, {request_id});
  if (!assigned?.update?.job_id) throw Error('自动分配未保存更新任务');
  await storage.put(key, {job_id: assigned.update.job_id, recorded_at: new Date(now).toISOString(), origin: 'auto_follow'});
  return assigned;
}
