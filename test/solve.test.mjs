// 合成画像でプレートソルバーを検証する。
//   node test/solve.test.mjs
//
// 各ケースで「正解の中心方向・画角」と「解いた結果」を突き合わせ、
// 角度のずれが許容内かを確認する。

import { STARS } from '../src/data.js';
import { detectStars } from '../src/detect.js';
import { buildCatalog, buildPairIndex, solvePlate } from '../src/solve.js';
import { sph2vec, angleBetween, matVec, DEG } from '../src/astro.js';
import { makeSky } from '../src/sample.js';

const t0 = Date.now();
const catalog = buildCatalog(STARS, 5.8);
const quickCatalog = buildCatalog(STARS, 4.8);
const tiers = [
  { name: '3.2等', mag: 3.2, maxSep: 115 },
  { name: '4.2等', mag: 4.2, maxSep: 75 },
  { name: '5.0等', mag: 5.0, maxSep: 35 },
].map((t) => {
  const cat = buildCatalog(STARS, t.mag);
  return { name: t.name, cat, pairs: buildPairIndex(cat, t.maxSep) };
});
console.log(
  `準備: 照合用 ${catalog.vectors.length} 星 / 仮説用 ` +
  tiers.map((t) => `${t.name}=${t.cat.vectors.length}星 ${t.pairs.n}組`).join(', ') +
  ` (${Date.now() - t0}ms)`
);

const CASES = [
  { name: 'オリオン座 60度', ra: 83, dec: 0, roll: 12, fov: 60 },
  { name: '北斗七星 70度', ra: 185, dec: 55, roll: -30, fov: 70 },
  { name: '夏の大三角 75度', ra: 290, dec: 30, roll: 5, fov: 75 },
  { name: 'さそり座 50度', ra: 250, dec: -30, roll: 100, fov: 50 },
  { name: '南天 65度', ra: 190, dec: -60, roll: 200, fov: 65 },
  { name: '広角 100度', ra: 40, dec: 40, roll: 0, fov: 100 },
  { name: '狭角 25度', ra: 83, dec: 0, roll: 45, fov: 25, limitMag: 6.0 },
  { name: '天の北極 55度', ra: 30, dec: 80, roll: 170, fov: 55 },
  { name: '暗い空・弱い星まで', ra: 310, dec: 45, roll: 20, fov: 65, limitMag: 5.9 },
  { name: '街明かり・4.3等まで', ra: 100, dec: 20, roll: -60, fov: 65, limitMag: 4.3, glow: 90, noise: 5 },
  { name: '外れ値20個・下部が木', ra: 83, dec: 10, roll: 8, fov: 70, spurious: 20, occludeFrac: 0.25 },
  { name: 'レンズ歪みあり', ra: 265, dec: 20, roll: -15, fov: 80, k1: -0.06 },
  { name: '縦位置', ra: 83, dec: 0, roll: 90, fov: 65, width: 1200, height: 1600 },
  { name: 'ぶれ気味（にじみ大）', ra: 150, dec: 25, roll: 33, fov: 60, psf: 2.6 },
  { name: '周辺減光＋ホットピクセル', ra: 83, dec: 0, roll: 20, fov: 70, vignette: 0.6, hotPixels: 40 },
  { name: '日周運動で星が流れる(0.5度)', ra: 290, dec: 30, roll: 15, fov: 65, trailDeg: 0.5 },
  { name: '星が大きく流れる(0.8度)', ra: 83, dec: 0, roll: 15, fov: 65, trailDeg: 0.8 },
  { name: '星が大きく流れる(1.2度)', ra: 83, dec: 0, roll: 15, fov: 65, trailDeg: 1.2 },
  { name: '甘い結像＋強い街明かり', ra: 60, dec: 20, roll: -25, fov: 68, softBlur: true, glow: 120, glowX: 40, noise: 6, limitMag: 4.6 },
  { name: '悪条件全部入り', ra: 200, dec: 0, roll: 140, fov: 72, vignette: 0.5, hotPixels: 25, softBlur: true, trailDeg: 0.25, spurious: 12, glow: 70, noise: 5, limitMag: 4.8, k1: -0.04 },
];

let pass = 0, fail = 0;
for (const c of CASES) {
  const img = makeSky({ seed: 42, ...c });
  const tDet = Date.now();
  const { stars, noiseMedian: sigma } = detectStars(img, { maxStars: 140 });
  const tSolve = Date.now();
  const sol = solvePlate(stars, img.width, img.height, {
    catalog,
    quickCatalog,
    hypCatalogs: tiers,
    deadline: Date.now() + 40000,
  });
  const dt = Date.now();

  if (!sol) {
    console.log(`✗ ${c.name}: 解けなかった（検出 ${stars.length} 点, 写った星 ${img.truth.nStars}）`);
    fail++;
    continue;
  }
  const truthCenter = matVec(img.truth.R, [0, 0, 1]);
  const gotCenter = sph2vec(sol.center[0], sol.center[1]);
  const errDeg = angleBetween(truthCenter, gotCenter) / DEG;
  const fovErr = Math.abs(sol.fovDiag - img.truth.fov);
  const ok = errDeg < 0.5 && fovErr < 1.5 && sol.rms < 3.5;
  if (ok) pass++; else fail++;
  console.log(
    `${ok ? '✓' : '✗'} ${c.name}: 中心ずれ ${errDeg.toFixed(3)}° / 画角 ${sol.fovDiag.toFixed(1)}°(正 ${img.truth.fov}°) ` +
    `/ 一致 ${sol.nMatch}星 / rms ${sol.rms.toFixed(2)}px / 検出 ${stars.length} ` +
    `/ 検出${tSolve - tDet}ms 照合${dt - tSolve}ms 仮説${sol.tested}`
  );
}
console.log(`\n${pass} 合格 / ${fail} 不合格`);
process.exit(fail ? 1 : 0);
