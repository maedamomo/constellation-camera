// 合成の夜空画像を作る。テストの検証用と、アプリの「サンプルで試す」の両方で使う。
// 実際のスマホ写真に近づけるため、背景のかぶり・ノイズ・にじみ・
// 星以外の光（街灯や飛行機）も入れられるようにしてある。

import { STARS } from './data.js';
import { sph2vec, normalize, cross, matT, matVec, Camera, fFromFovDiag } from './astro.js';

/** 中心方向とロール角から回転行列（カメラ→天球）を作る */
export function rotForView(raDeg, decDeg, rollDeg) {
  const z = sph2vec(raDeg, decDeg);
  const north = [0, 0, 1];
  let y = [north[0] - z[0] * z[2], north[1] - z[1] * z[2], north[2] - z[2] * z[2]];
  if (Math.hypot(y[0], y[1], y[2]) < 1e-6) y = [1, 0, 0];
  y = normalize(y);
  let x = normalize(cross(y, z));
  const t = (rollDeg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  const x2 = [x[0] * c + y[0] * s, x[1] * c + y[1] * s, x[2] * c + y[2] * s];
  const y2 = [-x[0] * s + y[0] * c, -x[1] * s + y[1] * c, -x[2] * s + y[2] * c];
  return [x2[0], y2[0], z[0], x2[1], y2[1], z[1], x2[2], y2[2], z[2]];
}

// 再現性のある乱数
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * 合成画像を作る。
 * @returns {{data:Uint8ClampedArray,width,height,truth:{R,f,ra,dec,roll,fov,nStars}}}
 */
export function makeSky(o = {}) {
  const width = o.width ?? 1600;
  const height = o.height ?? 1200;
  const ra = o.ra ?? 83, dec = o.dec ?? 0, roll = o.roll ?? 0;
  const fov = o.fov ?? 60;              // 対角画角（度）
  const limitMag = o.limitMag ?? 5.4;   // 写る限界等級
  const psf = o.psf ?? 1.4;             // にじみ（画素）
  const noise = o.noise ?? 3.0;
  const bg = o.bg ?? 22;
  const k1 = o.k1 ?? 0;                 // レンズ歪み
  const rand = rng(o.seed ?? 1);

  const f = fFromFovDiag(width, height, fov);
  const cam = new Camera(width, height, f, k1);
  const R = rotForView(ra, dec, roll);
  const Rt = matT(R);

  const buf = new Float32Array(width * height);
  // 背景のかぶり（街明かりを想定した片側の勾配）
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      buf[y * width + x] = bg + (o.glow ?? 25) * Math.pow(y / height, 3) + (o.glowX ?? 0) * (x / width);

  const drawn = [];
  const put = (px, py, amp, sig) => {
    const r = Math.ceil(sig * 3.5);
    for (let dy = -r; dy <= r; dy++) {
      const y = Math.round(py) + dy;
      if (y < 0 || y >= height) continue;
      for (let dx = -r; dx <= r; dx++) {
        const x = Math.round(px) + dx;
        if (x < 0 || x >= width) continue;
        const ex = x - px, ey = y - py;
        buf[y * width + x] += amp * Math.exp(-(ex * ex + ey * ey) / (2 * sig * sig));
      }
    }
  };

  // 日周運動による星の流れ（露光中に天の極のまわりを回る）
  const trail = (o.trailDeg ?? 0) * Math.PI / 180;
  const nSub = trail > 0 ? Math.max(2, Math.round((trail * 180 / Math.PI) * 12)) : 1;

  for (const [sra, sdec, mag] of STARS) {
    if (mag > limitMag) continue;
    // 明るい星ほど大きく写る（にじみと飽和の再現）
    const amp = (40 * Math.pow(10, -0.4 * (mag - 3.0))) / nSub;
    const sig = psf * (1 + 0.35 * Math.max(0, 3.0 - mag) / 3);
    let first = null;
    for (let k = 0; k < nSub; k++) {
      const a = trail * (k / Math.max(1, nSub - 1) - 0.5);
      // 天の極まわりの回転 = 赤経が増えること
      const p = cam.camToPix(matVec(Rt, sph2vec(sra + (a * 180) / Math.PI, sdec)));
      if (!p) continue;
      if (p[0] < -5 || p[1] < -5 || p[0] > width + 5 || p[1] > height + 5) continue;
      // 周辺減光
      const rr = Math.hypot(p[0] - width / 2, p[1] - height / 2) / (Math.hypot(width, height) / 2);
      const vig = 1 - (o.vignette ?? 0) * rr * rr;
      put(p[0], p[1], amp * vig, sig);
      if (!first) first = p;
    }
    if (first) drawn.push({ ra: sra, dec: sdec, mag, x: first[0], y: first[1] });
  }

  // ホットピクセル（暗所での長時間露光で出る輝点）
  for (let i = 0; i < (o.hotPixels ?? 0); i++) {
    const x = Math.floor(rand() * width), y = Math.floor(rand() * height);
    buf[y * width + x] += 120 + rand() * 135;
  }

  // 星以外の光（街灯・窓・飛行機）
  for (let i = 0; i < (o.spurious ?? 0); i++) {
    put(rand() * width, height - rand() * height * 0.25, 60 + rand() * 150, psf * (1 + rand()));
  }
  // 雲や木で一部を隠す
  if (o.occludeFrac) {
    const h = Math.round(height * o.occludeFrac);
    for (let y = height - h; y < height; y++)
      for (let x = 0; x < width; x++) buf[y * width + x] = bg * 0.3;
  }

  if (o.softBlur) {
    const tmp = new Float32Array(buf.length);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        let s = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const yy = y + dy, xx = x + dx;
            if (yy < 0 || yy >= height || xx < 0 || xx >= width) continue;
            s += buf[yy * width + xx]; n++;
          }
        tmp[y * width + x] = s / n;
      }
    buf.set(tmp);
  }

  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    // ガウスノイズ（Box–Muller）
    const n = Math.sqrt(-2 * Math.log(rand() + 1e-9)) * Math.cos(2 * Math.PI * rand()) * noise;
    const v = Math.max(0, Math.min(255, buf[i] + n));
    data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255;
  }

  return {
    data, width, height,
    truth: { R, f, ra, dec, roll, fov, k1, nStars: drawn.length, drawn },
  };
}
