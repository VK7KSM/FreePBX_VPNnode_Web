// 显式能力集合优先；畸形或未知字段失败关闭，不提升旧客户端权限。
export const MEDIA_MODES = Object.freeze(['ptt','call','microphone','video','photo','alarm']);
export function mediaModes(device) {
  if (!device || device.enabled === false) return [];
  if (!Object.hasOwn(device, 'managed_media_modes')) return device.managed_media === true ? [...MEDIA_MODES] : [];
  const modes = device.managed_media_modes;
  if (!Array.isArray(modes) || modes.length > MEDIA_MODES.length || modes.some(mode => typeof mode !== 'string' || !MEDIA_MODES.includes(mode)) || new Set(modes).size !== modes.length) return [];
  return MEDIA_MODES.filter(mode => modes.includes(mode));
}
export function mediaAllowed(device, mode) { return mediaModes(device).includes(mode); }
export function mediaCapabilityFields(report) {
  return Object.hasOwn(report || {}, 'managed_media_modes') ? {managed_media_modes: mediaModes({...report, enabled: true})} : {};
}
export function applyMediaCapabilities(device, report) {
  if (Object.hasOwn(report, 'managed_media_modes')) device.managed_media_modes = mediaCapabilityFields(report).managed_media_modes;
  else delete device.managed_media_modes;
}
// 网页采用同一实现，避免界面和API校验语义漂移。
export const mediaCapabilitiesSource = `var ElfMediaCapabilities=(function(){var MEDIA_MODES=${JSON.stringify(MEDIA_MODES)};${mediaModes.toString()}${mediaAllowed.toString()}return {modes:mediaModes,allows:mediaAllowed};})();`;
