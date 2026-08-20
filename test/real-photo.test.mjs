// 実写の回帰テスト。
//   node test/real-photo.test.mjs
//
// test/ に置いた実写(星が写っていない霧・粒子の写真)を最後まで通し、
//   1. 光点の大半が「星ではない形」と分類されること
//   2. 誤った星座を返さないこと（偽陽性ゼロ）
// を確かめる。jpeg-js が無い環境では跳ばす（npm i jpeg-js で入る）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let jpeg;
try { jpeg = (await import('jpeg-js')).default; }
catch {
  console.log('jpeg-js が無いため実写テストを跳ばします（npm i jpeg-js）');
  process.exit(0);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PHOTO = path.join(HERE, 'CF253EF9-91ED-40A3-B3F8-E119B3897998.JPG');
if (!fs.existsSync(PHOTO)) {
  console.log('実写ファイルが無いため跳ばします');
  process.exit(0);
}

const { detectStars, classifyDetections } = await import('../src/detect.js');
const { buildCatalog, buildPairIndex, solvePlate } = await import('../src/solve.js');
const { STARS } = await import('../src/data.js');

const img = jpeg.decode(fs.readFileSync(PHOTO), { maxMemoryUsageInMB: 1024, formatAsRGBA: true });
const s = Math.min(1, 1400 / Math.max(img.width, img.height));
const w = Math.round(img.width * s), h = Math.round(img.height * s);
const data = new Uint8ClampedArray(w * h * 4);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const p = (Math.min(img.height - 1, Math.floor(y / s)) * img.width + Math.min(img.width - 1, Math.floor(x / s))) * 4;
  const q = (y * w + x) * 4;
  data[q] = img.data[p]; data[q + 1] = img.data[p + 1]; data[q + 2] = img.data[p + 2]; data[q + 3] = 255;
}

const { stars: allDets } = detectStars({ data, width: w, height: h }, { maxStars: 400 });
const stars = allDets.slice(0, 150);
const cls = classifyDetections(allDets);
console.log(`検出 ${allDets.length} / 線像率 ${(cls.junkFraction * 100).toFixed(0)}% / 点像 ${cls.points.length}`);

let ng = 0;
if (cls.junkFraction <= 0.45) {
  console.log('✗ 線像率が 45% を超えるはず（この写真の光点は虫・霧雨）');
  ng++;
} else {
  console.log('✓ 光点の大半を「星ではない形」と分類');
}

const catalog = buildCatalog(STARS, 5.6);
const quickCatalog = buildCatalog(STARS, 4.8);
const tiers = [[3.2, 115], [4.2, 75], [5.0, 35]].map(([m, sep]) => {
  const c = buildCatalog(STARS, m);
  return { name: `${m}等`, cat: c, pairs: buildPairIndex(c, sep) };
});
const base = { catalog, quickCatalog, hypCatalogs: tiers };
let sol = solvePlate(stars, w, h, { ...base, deadline: Date.now() + 40000 });
if (!sol && cls.points.length >= 10) {
  sol = solvePlate(cls.points.slice(0, 150), w, h, {
    ...base, quickCatalog: catalog, magGate: Infinity, checkBright: false,
    deadline: Date.now() + 30000,
  });
}
if (sol) {
  console.log(`✗ 星の無い写真で解を返してしまった（一致${sol.nMatch}）— 偽陽性`);
  ng++;
} else {
  console.log('✓ 誤った星座を返さない（正しく「特定できない」と判定）');
}
console.log(ng ? `\n${ng} 件不合格` : '\nすべて合格');
process.exit(ng ? 1 : 0);
