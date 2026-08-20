// スマホの画像処理を通したあとの写真で解けるかを確かめる。
//   node test/real-like.test.mjs

import { STARS } from '../src/data.js';
import { detectStars } from '../src/detect.js';
import { buildCatalog, buildPairIndex, solvePlate } from '../src/solve.js';
import { sph2vec, angleBetween, matVec, DEG } from '../src/astro.js';
import { makeSky } from '../src/sample.js';
import { throughPhoneIsp } from './phone.mjs';

const catalog = buildCatalog(STARS, 5.6);
const quickCatalog = buildCatalog(STARS, 4.8);
const tiers = [[3.2, 115], [4.2, 75], [5.0, 35]].map(([m, s]) => {
  const c = buildCatalog(STARS, m);
  return { name: `${m}等`, cat: c, pairs: buildPairIndex(c, s) };
});

const CASES = [
  { name: '弱いISP（軽い圧縮のみ）', sky: {}, isp: { quality: 92 } },
  { name: '標準的なスマホ（NR+シャープ+トーン+圧縮)', sky: {}, isp: { denoise: 2.5, sharpen: 0.6, gamma: 1.8, quality: 85 } },
  { name: '強いノイズ低減', sky: { noise: 5 }, isp: { denoise: 6, sharpen: 0.5, gamma: 1.8, quality: 85 } },
  { name: '夜景モード（持ち上げ強め）', sky: { noise: 4, glow: 90 }, isp: { denoise: 4, sharpen: 0.8, gamma: 2.4, shoulder: 1.2, quality: 88 } },
  { name: '強い圧縮（SNS相当）', sky: {}, isp: { denoise: 2, gamma: 1.8, quality: 55 } },
  { name: '街中の空（4.0等まで）＋標準ISP', sky: { limitMag: 4.0, glow: 110 }, isp: { denoise: 3, sharpen: 0.6, gamma: 2.0, quality: 85 } },
  { name: '街中の空（3.5等まで）＋強ISP', sky: { limitMag: 3.5, glow: 130, noise: 5 }, isp: { denoise: 5, sharpen: 0.8, gamma: 2.2, quality: 80 } },
  { name: '地上の風景が下半分', sky: { occludeFrac: 0.5, spurious: 15 }, isp: { denoise: 3, sharpen: 0.6, gamma: 1.9, quality: 85 } },
  { name: '手持ちで少しぶれた', sky: { psf: 2.4 }, isp: { denoise: 3, sharpen: 0.6, gamma: 1.9, quality: 85 } },
  { name: '超広角＋標準ISP', sky: { fov: 105 }, isp: { denoise: 3, sharpen: 0.6, gamma: 1.9, quality: 85 } },
];

const BASE = { seed: 11, ra: 83, dec: 0, roll: 15, fov: 65, limitMag: 5.2, glow: 60, width: 1600, height: 1200 };

let pass = 0, fail = 0;
for (const c of CASES) {
  const raw = makeSky({ ...BASE, ...c.sky });
  const img = throughPhoneIsp(raw, c.isp);
  const { stars } = detectStars(img, { maxStars: 150 });
  const t0 = Date.now();
  const sol = solvePlate(stars, img.width, img.height, {
    catalog, quickCatalog, hypCatalogs: tiers, deadline: Date.now() + 30000,
  });
  const ms = Date.now() - t0;
  if (!sol) {
    console.log(`✗ ${c.name}: 解けなかった（写った星 ${raw.truth.nStars} / 検出 ${stars.length} / ${ms}ms）`);
    fail++;
    continue;
  }
  const truth = matVec(raw.truth.R, [0, 0, 1]);
  const err = angleBetween(truth, sph2vec(sol.center[0], sol.center[1])) / DEG;
  const ok = err < 0.5;
  ok ? pass++ : fail++;
  console.log(`${ok ? '✓' : '✗'} ${c.name}: ずれ ${err.toFixed(3)}度 / 一致 ${sol.nMatch} / 検出 ${stars.length} / rms ${sol.rms.toFixed(2)}px / ${ms}ms`);
}
console.log(`\n${pass} 合格 / ${fail} 不合格`);
process.exit(fail ? 1 : 0);
