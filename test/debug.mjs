// 失敗したケースの原因を切り分ける。
//   node test/debug.mjs
// 「検出がおかしいのか」「仮説が作れていないのか」「採用条件が厳しすぎるのか」を分ける。

import { STARS } from '../src/data.js';
import { detectStars } from '../src/detect.js';
import { buildCatalog, buildPairIndex, solvePlate } from '../src/solve.js';
import { Camera, matT, matVec, sph2vec, fFromFovDiag } from '../src/astro.js';
import { makeSky } from '../src/sample.js';

const CASE = JSON.parse(process.argv[2] || '{}');
const img = makeSky({ seed: 42, ...CASE });
const { stars, noiseMedian: sigma } = detectStars(img, { maxStars: 140 });
console.log(`検出 ${stars.length} 点 / ノイズσ=${sigma.toFixed(2)} / 描画した星 ${img.truth.nStars}`);

// 検出点が本物の星かどうかを、正解の描画位置と突き合わせて調べる
const truth = img.truth.drawn;
const real = stars.map((s) => {
  let best = null, bd = 6;
  for (const t of truth) {
    const d = Math.hypot(t.x - s.x, t.y - s.y);
    if (d < bd) { bd = d; best = t; }
  }
  return best;
});
const nReal = real.filter(Boolean).length;
console.log(`うち本物の星 ${nReal} 点 / 偽 ${stars.length - nReal} 点`);
console.log('上位12点: ' + stars.slice(0, 12).map((s, i) =>
  real[i] ? `${real[i].mag.toFixed(1)}等` : '偽').join(' '));

for (const lim of [3.2, 4.2, 5.0]) {
  const idx = [];
  for (let i = 0; i < Math.min(24, stars.length); i++)
    if (real[i] && real[i].mag <= lim) idx.push(i);
  console.log(`上位24点のうち ${lim}等以下の本物: ${idx.length} 個 (位置 ${idx.slice(0, 8).join(',')})`);
}

// 正解の解を直接与えたとき、採用条件を満たすか
const catalog = buildCatalog(STARS, 5.8);
const cam = new Camera(img.width, img.height, img.truth.f, img.truth.k1);
const Rt = matT(img.truth.R);
let n = 0;
const tol = Math.max(4, Math.hypot(img.width, img.height) * 0.005) * 0.45;
for (let i = 0; i < catalog.vectors.length; i++) {
  const p = cam.camToPix(matVec(Rt, catalog.vectors[i]));
  if (!p || p[0] < 0 || p[1] < 0 || p[0] > img.width || p[1] > img.height) continue;
  let hit = false;
  for (const s of stars) if (Math.hypot(s.x - p[0], s.y - p[1]) < tol) { hit = true; break; }
  if (hit) n++;
}
console.log(`正解の解での一致数（許容${tol.toFixed(1)}px）: ${n}`);

const t0 = Date.now();
const quickCatalog = buildCatalog(STARS, 4.8);
const tiers = [[3.2, 115], [4.2, 75], [5.0, 35]].map(([m, s]) => {
  const c = buildCatalog(STARS, m);
  return { name: `${m}等`, cat: c, pairs: buildPairIndex(c, s) };
});
const sol = solvePlate(stars, img.width, img.height, {
  catalog, quickCatalog, hypCatalogs: tiers,
  deadline: Date.now() + 60000,
  onProgress: (p) => console.log('  進捗', JSON.stringify(p)),
});
console.log(sol ? `解けた: 一致${sol.nMatch} rms${sol.rms.toFixed(2)} 画角${sol.fovDiag.toFixed(1)}°`
  : `解けなかった (${Date.now() - t0}ms)`);
