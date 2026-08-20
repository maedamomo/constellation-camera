// スマホの画像処理（ISP）を模した劣化をかける。テスト専用。
//
// 実機の写真は、センサーが受けた光がそのまま出てくるわけではない。
// ノイズ低減で淡い星が消え、トーンマッピングで明暗が圧縮され、
// シャープ化で星の周りに縁ができ、JPEG 圧縮で 8x8 の塊ごとに階調が丸められる。
// 合成画像でそこを再現しないと、実写で何が起きるか分からない。

function blur(src, w, h, sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0;
    for (let i = -r; i <= r; i++) v += src[y * w + Math.min(w - 1, Math.max(0, x + i))] * k[i + r];
    tmp[y * w + x] = v;
  }
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
    let v = 0;
    for (let i = -r; i <= r; i++) v += tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x] * k[i + r];
    out[y * w + x] = v;
  }
  return out;
}

/**
 * ノイズ低減。細かい成分のうち振幅が小さいものを削る（コアリング）。
 * 実機の NR と同じく、淡い星は消え、明るい星は残る。
 */
export function denoise(v, w, h, strength) {
  const base = blur(v, w, h, 1.6);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) {
    const d = v[i] - base[i];
    const a = Math.abs(d);
    out[i] = base[i] + (a <= strength ? 0 : Math.sign(d) * (a - strength));
  }
  return out;
}

/** シャープ化（アンシャープマスク）。星の周りに暗い縁ができる。 */
export function sharpen(v, w, h, amount) {
  const base = blur(v, w, h, 1.2);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] + amount * (v[i] - base[i]);
  return out;
}

/** トーンマッピング。暗部を持ち上げ、明部を圧縮する S 字カーブ。 */
export function toneMap(v, gamma, shoulder) {
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) {
    let x = Math.max(0, Math.min(1, v[i] / 255));
    x = Math.pow(x, 1 / gamma);
    x = x / (1 + shoulder * x) * (1 + shoulder); // 明部を寝かせる
    out[i] = Math.max(0, Math.min(255, x * 255));
  }
  return out;
}

// ---- JPEG 相当（8x8 DCT の量子化） ----------------------------------------
const Q50 = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const COS = new Float32Array(64);
for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) {
  COS[x * 8 + u] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);
}
const C = (u) => (u === 0 ? Math.SQRT1_2 : 1);

/** 品質 quality（1〜100）で JPEG 相当の量子化をかける */
export function jpegLike(v, w, h, quality) {
  const scale = quality < 50 ? 5000 / quality : 200 - 2 * quality;
  const q = Q50.map((x) => Math.max(1, Math.floor((x * scale + 50) / 100)));
  const out = Float32Array.from(v);
  const blk = new Float32Array(64), co = new Float32Array(64);
  for (let by = 0; by + 8 <= h; by += 8) {
    for (let bx = 0; bx + 8 <= w; bx += 8) {
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) blk[y * 8 + x] = v[(by + y) * w + bx + x] - 128;
      for (let u = 0; u < 8; u++) for (let z = 0; z < 8; z++) {
        let s = 0;
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) s += blk[y * 8 + x] * COS[x * 8 + z] * COS[y * 8 + u];
        co[u * 8 + z] = 0.25 * C(u) * C(z) * s;
      }
      for (let i = 0; i < 64; i++) co[i] = Math.round(co[i] / q[i]) * q[i];
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        let s = 0;
        for (let u = 0; u < 8; u++) for (let z = 0; z < 8; z++) s += C(u) * C(z) * co[u * 8 + z] * COS[x * 8 + z] * COS[y * 8 + u];
        out[(by + y) * w + bx + x] = Math.max(0, Math.min(255, 0.25 * s + 128));
      }
    }
  }
  return out;
}

/**
 * 合成画像にスマホの画像処理をひととおりかける。
 * @param {{data:Uint8ClampedArray,width:number,height:number}} img
 */
export function throughPhoneIsp(img, o = {}) {
  const w = img.width, h = img.height;
  let v = new Float32Array(w * h);
  for (let i = 0; i < v.length; i++) v[i] = img.data[i * 4];

  if (o.denoise) v = denoise(v, w, h, o.denoise);
  if (o.sharpen) v = sharpen(v, w, h, o.sharpen);
  if (o.gamma) v = toneMap(v, o.gamma, o.shoulder ?? 0.6);
  if (o.quality) v = jpegLike(v, w, h, o.quality);

  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < v.length; i++) {
    const x = Math.max(0, Math.min(255, v[i]));
    data[i * 4] = x; data[i * 4 + 1] = x; data[i * 4 + 2] = x; data[i * 4 + 3] = 255;
  }
  return { data, width: w, height: h, truth: img.truth };
}
