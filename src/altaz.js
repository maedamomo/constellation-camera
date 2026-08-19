// 撮影日時と撮影地から、天球座標（赤経赤緯）を地平座標（方位・高度）に直す。
// EXIF に日時と GPS がある写真では「どの方角の空を撮ったか」を言えるようになる。

const D = Math.PI / 180;

/** ユリウス日 */
export function julianDay(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

/** グリニッジ平均恒星時（度） */
export function gmst(date) {
  const jd = julianDay(date);
  const T = (jd - 2451545.0) / 36525;
  let g = 280.46061837 + 360.98564736629 * (jd - 2451545.0)
    + 0.000387933 * T * T - (T * T * T) / 38710000;
  g %= 360;
  return g < 0 ? g + 360 : g;
}

/**
 * J2000 の赤経赤緯を、その日付の平均分点に歳差補正する。
 * 26 年で最大 0.4 度ほどのずれ。方角を言うだけなら効かないが、入れておく。
 */
export function precess(raDeg, decDeg, date) {
  const T = (julianDay(date) - 2451545.0) / 36525;
  const zeta = (2306.2181 * T + 0.30188 * T * T) / 3600 * D;
  const z = (2306.2181 * T + 1.09468 * T * T) / 3600 * D;
  const theta = (2004.3109 * T - 0.42665 * T * T) / 3600 * D;
  const ra = raDeg * D, dec = decDeg * D;
  const A = Math.cos(dec) * Math.sin(ra + zeta);
  const B = Math.cos(theta) * Math.cos(dec) * Math.cos(ra + zeta) - Math.sin(theta) * Math.sin(dec);
  const C = Math.sin(theta) * Math.cos(dec) * Math.cos(ra + zeta) + Math.cos(theta) * Math.sin(dec);
  return [
    ((Math.atan2(A, B) + z) / D + 360) % 360,
    Math.asin(Math.max(-1, Math.min(1, C))) / D,
  ];
}

/**
 * 地平座標へ変換。
 * @returns {{az:number, alt:number}} az は北を 0 として東回り（度）
 */
export function toAltAz(raDeg, decDeg, date, latDeg, lonDeg) {
  const [ra, dec] = precess(raDeg, decDeg, date);
  const lst = (gmst(date) + lonDeg) % 360;
  const H = ((lst - ra + 540) % 360 - 180) * D;
  const d = dec * D, lat = latDeg * D;
  const sinAlt = Math.sin(d) * Math.sin(lat) + Math.cos(d) * Math.cos(lat) * Math.cos(H);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  const az = Math.atan2(
    -Math.sin(H) * Math.cos(d),
    Math.sin(d) * Math.cos(lat) - Math.cos(d) * Math.sin(lat) * Math.cos(H)
  );
  return { az: ((az / D) + 360) % 360, alt: alt / D };
}

const DIRS = ['北', '北北東', '北東', '東北東', '東', '東南東', '南東', '南南東',
  '南', '南南西', '南西', '西南西', '西', '西北西', '北西', '北北西'];

/** 方位角（度）を日本語の方角に */
export function dirName(az) {
  return DIRS[Math.round((((az % 360) + 360) % 360) / 22.5) % 16];
}
