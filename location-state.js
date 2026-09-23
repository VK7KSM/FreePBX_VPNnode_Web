// 设备周期上报里的定位可用性。只保留三个来源的开关与权限判定，不含任何坐标。
// 面板原先分不出「定位被关了」和「还没定到」，一律退回 IP 显示两公里，
// 每次都要连设备翻 dumpsys 才知道，这个字段就是为了把原因带上来。
export const LOCATION_REASONS = Object.freeze(['ok', 'location_disabled', 'permission_denied', 'provider_unavailable']);

/** 失败关闭：取值不在白名单里就整条丢弃，面板退回原有行为，不显示一个猜出来的原因。 */
export function normalizeLocationState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!LOCATION_REASONS.includes(value.reason)) return null;
  return {
    enabled: value.enabled === true,
    reason: value.reason,
    gps: value.gps === true,
    fused: value.fused === true,
    network: value.network === true,
  };
}
