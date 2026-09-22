import { radioRequest } from './google-geolocation.js';

// 大陆设备的 WiFi/基站定位。
//
// 为什么单独一条路：Google 在大陆没有 WiFi 指纹数据——2026-09-21 实测，大陆那台设备
// 连续 200 次上报全部返回 not_found（HTTP 404「请求合法但无结果」），不是额度问题，
// 换任何境外厂商都一样。高德的智能硬件定位需单独开通服务权限，且其参数表「推荐」提交
// imei / imsi / 电话号码 / 设备 MAC，定位一个点根本不需要这些。
//
// 现走 cellocation：不需要账号与 key，默认返回 WGS-84（与面板的 OSM 瓦片同一坐标系，
// 不需要 GCJ-02 转换），实测混合定位约 100 米、单基站约 119 米。它只开在 :84 的明文端口，
// 而 Workers 出站端口是白名单（HTTP 仅 80/8080/8880/2052/2086/2095），其 443 证书又只签给
// cellocation.com / www.cellocation.com，对 api.* 校验失败——所以必须经我们自己的固定 IP
// 转发（geo.elfradio.net，跑在 MQTT 那台 VPS 上），这也正是该站条款要求的用法。
const RELAY_URL = 'https://geo.elfradio.net/locate';
const MAX_AGE = 15 * 60 * 1000;

/** 把 Google 那套已校验的载荷转成转发所需的形状，不另写一遍过滤规则。 */
export function cnRelayBody(payload) {
  if (!payload) return null;
  const wifis = (payload.wifiAccessPoints || []).map(row => ({ mac: row.macAddress, signal: row.signalStrength }));
  const cells = (payload.cellTowers || []).map(row => ({
    mcc: row.mobileCountryCode, mnc: row.mobileNetworkCode,
    lac: row.locationAreaCode, ci: row.cellId,
    // 转发要求信号强度在 -150..-1；Google 那边这一项是可选的，缺了就给一个中性值，
    // 它只影响多基站时的加权，不影响能否查到。
    signal: Number.isInteger(row.signalStrength) && row.signalStrength >= -150 && row.signalStrength <= -1 ? row.signalStrength : -70
  }));
  return wifis.length || cells.length ? { ...(cells.length ? { cells } : {}), ...(wifis.length ? { wifis } : {}) } : null;
}

/** 只有 Cloudflare 判定来源 IP 在中国大陆才走这条路。港澳台各有自己的国家码，不会落进来。 */
export function mainland(cf) {
  return cf?.country === 'CN';
}

async function fingerprint(body) {
  const shape = {
    wifi: (body.wifis || []).map(x => x.mac).sort(),
    cells: (body.cells || []).map(({ signal, ...cell }) => JSON.stringify(cell)).sort()
  };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(shape)));
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
}

export async function cnLocation(env, deviceId, data, now = Date.now(), fetcher = (...args) => fetch(...args)) {
  const token = env.GEO_RELAY_TOKEN;
  if (!token) return { location: null, reason: 'not_configured' };
  const body = cnRelayBody(radioRequest(data.radio, now));
  if (!body) return { location: null, reason: 'no_radio_data' };

  // 同一批接入点十五分钟内只查一次。设备静止时每轮上报的指纹都一样，
  // 不缓存就会把对方每天的配额白白烧掉，而结果根本不会变。
  const signature = await fingerprint(body);
  const key = 'cn-geolocation/' + encodeURIComponent(deviceId);
  const cached = await env.__storage?.get(key);
  if (cached?.signature === signature && now >= cached.at && now - cached.at < (cached.location ? MAX_AGE : 60000))
    return { location: cached.location, reason: cached.reason };

  let location = null, reason = 'unavailable';
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetcher(RELAY_URL, {
      method: 'POST', signal: controller.signal, redirect: 'manual',
      headers: { 'Content-Type': 'application/json', 'X-Elf-Token': token },
      body: JSON.stringify(body)
    });
    if (!response.ok) reason = response.status === 404 ? 'not_found' : 'relay_http_' + response.status;
    else {
      const found = await response.json();
      const lat = Number(found?.lat), lng = Number(found?.lon), radius = Number(found?.radius);
      if (found?.ok === true && Number.isFinite(lat) && Math.abs(lat) <= 90
        && Number.isFinite(lng) && Math.abs(lng) <= 180 && Number.isFinite(radius) && radius > 0) {
        // 转发已声明 coord=wgs84。这里再钉一次：万一哪天上游默认值变了，
        // 坐标会静静地偏出几百米，而地图上看不出错——宁可当场判为无效。
        if (found.coord !== 'wgs84') reason = 'unexpected_coord';
        else {
          location = {
            lat, lng, acc_m: Math.max(1, Math.round(radius)),
            source: body.wifis ? (body.cells ? 'network' : 'wifi') : 'cell',
            provider: 'cellocation', at: new Date(data.radio.sampled_at_ms).toISOString()
          };
          reason = 'located';
        }
      } else reason = 'invalid_response';
    }
  } catch (error) {
    reason = controller.signal.aborted ? 'timeout' : 'relay_failed';
  } finally { clearTimeout(timer); }

  await env.__storage?.put(key, { signature, at: now, location, reason });
  return { location, reason };
}
