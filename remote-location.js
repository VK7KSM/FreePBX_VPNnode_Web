export function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip.indexOf("10.") === 0 || ip.indexOf("192.168.") === 0 || ip.indexOf("127.") === 0) return true;
  if (ip.indexOf("172.") === 0) {
    const n = parseInt(ip.split(".")[1], 10);
    return n >= 16 && n <= 31;
  }
  return false;
}

function finitePoint(p) {
  return p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng));
}

function accOr(v, fallback) {
  const n = Number(v);
  return n > 0 ? n : fallback;
}

export function pickLocation(report, ipGeo) {
  const r = report || {};
  if (finitePoint(r.gps)) {
    const acc = accOr(r.gps.acc_m, 30);
    return {
      lat: Number(r.gps.lat),
      lng: Number(r.gps.lng),
      acc_m: acc < 5000 ? acc : 30,
      source: "gps",
      at: r.gps.at || null
    };
  }
  if (finitePoint(r.wifi)) {
    return {
      lat: Number(r.wifi.lat),
      lng: Number(r.wifi.lng),
      acc_m: accOr(r.wifi.acc_m, 200),
      source: "wifi",
      at: r.wifi.at || null
    };
  }
  if (finitePoint(r.cell)) {
    return {
      lat: Number(r.cell.lat),
      lng: Number(r.cell.lng),
      acc_m: accOr(r.cell.acc_m, 3000),
      source: "cell",
      at: r.cell.at || null
    };
  }
  if (finitePoint(ipGeo)) {
    return {
      lat: Number(ipGeo.lat),
      lng: Number(ipGeo.lng),
      acc_m: accOr(ipGeo.acc_m, 2000),
      source: "ip",
      at: ipGeo.at || null
    };
  }
  return null;
}

export function parseGeoCache(raw) {
  if (!raw) return null;
  if (typeof raw === "string") return null;
  if (finitePoint(raw)) {
    return {
      label: raw.label || "",
      lat: Number(raw.lat),
      lng: Number(raw.lng)
    };
  }
  return null;
}
