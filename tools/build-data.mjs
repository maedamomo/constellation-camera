#!/usr/bin/env node
// 星表データを Web アプリ用のコンパクトな JS に変換する。
//
// 入力（このフォルダに無ければ GitHub から取得する）:
//   stars.6.json              6等までの恒星（HIP番号・赤経赤緯・等級）
//   constellations.lines.json 88星座の星座線
//   constellations.json       星座名（日本語を含む多言語）
//   starnames.json            固有名（日本語を含む）
//   出典: ofrohn/d3-celestial（BSD-3-Clause）。元データは Hipparcos / IAU。
//
// 出力: ../src/data.js

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/';
const FILES = ['stars.6.json', 'constellations.lines.json', 'constellations.json', 'starnames.json'];

async function load(name) {
  const p = path.join(HERE, name);
  if (!fs.existsSync(p)) {
    process.stderr.write(`downloading ${name}\n`);
    const res = await fetch(BASE + name);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    fs.writeFileSync(p, Buffer.from(await res.arrayBuffer()));
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const r3 = (x) => Math.round(x * 1000) / 1000;
const r2 = (x) => Math.round(x * 100) / 100;
const norm360 = (ra) => ((ra % 360) + 360) % 360;

const stars = await load('stars.6.json');
const lines = await load('constellations.lines.json');
const consts = await load('constellations.json');
const names = await load('starnames.json');

// ---- 恒星 -----------------------------------------------------------------
// [赤経(度), 赤緯(度), 等級, HIP番号] の配列。等級順に並べる（明るい順）。
const STARS = stars.features
  .map((f) => [
    r3(norm360(f.geometry.coordinates[0])),
    r3(f.geometry.coordinates[1]),
    r2(f.properties.mag),
    f.id,
  ])
  .sort((a, b) => a[2] - b[2]);

// ---- 星座線 ---------------------------------------------------------------
// { 略号: [[[ra,dec],...], ...] }
const LINES = {};
for (const f of lines.features) {
  LINES[f.id] = f.geometry.coordinates.map((seg) =>
    seg.map(([ra, dec]) => [r3(norm360(ra)), r3(dec)])
  );
}

// ---- 星座名 ---------------------------------------------------------------
// d3-celestial の ja が欠けている／表記を直したいものはここで上書きする。
const JA_OVERRIDE = {
  Ser: 'へび座',
  Oph: 'へびつかい座',
  Sex: 'ろくぶんぎ座',
  Nor: 'じょうぎ座',
  Cir: 'コンパス座',
  Ant: 'ポンプ座',
  Ret: 'レチクル座',
  Men: 'テーブルさん座',
  Hor: 'とけい座',
  Cae: 'ちょうこくぐ座',
  Scl: 'ちょうこくしつ座',
  Mic: 'けんびきょう座',
  Tel: 'ぼうえんきょう座',
  Oct: 'はちぶんぎ座',
  Pyx: 'らしんばん座',
  Vol: 'とびうお座',
  Dor: 'かじき座',
  Cha: 'カメレオン座',
  Mus: 'はえ座',
  Aps: 'ふうちょう座',
  Pav: 'くじゃく座',
  Tuc: 'きょしちょう座',
  Gru: 'つる座',
  Phe: 'ほうおう座',
  Ind: 'インディアン座',
  Cru: 'みなみじゅうじ座',
  Car: 'りゅうこつ座',
  Pup: 'とも座',
  Vel: 'ほ座',
  TrA: 'みなみのさんかく座',
  CrA: 'みなみのかんむり座',
  PsA: 'みなみのうお座',
  Equ: 'こうま座',
  Del: 'いるか座',
  Sge: 'や座',
  Vul: 'こぎつね座',
  Lac: 'とかげ座',
  Lyn: 'やまねこ座',
  LMi: 'こじし座',
  CVn: 'りょうけん座',
  Com: 'かみのけ座',
  CrB: 'かんむり座',
  Sct: 'たて座',
  Mon: 'いっかくじゅう座',
  Cam: 'きりん座',
  Aur: 'ぎょしゃ座',
  Per: 'ペルセウス座',
  Cas: 'カシオペヤ座',
  Cep: 'ケフェウス座',
  Dra: 'りゅう座',
  UMi: 'こぐま座',
  UMa: 'おおぐま座',
  Boo: 'うしかい座',
  Vir: 'おとめ座',
  Lib: 'てんびん座',
  Sco: 'さそり座',
  Sgr: 'いて座',
  Cap: 'やぎ座',
  Aqr: 'みずがめ座',
  Psc: 'うお座',
  Ari: 'おひつじ座',
  Tau: 'おうし座',
  Gem: 'ふたご座',
  Cnc: 'かに座',
  Leo: 'しし座',
  Ori: 'オリオン座',
  CMa: 'おおいぬ座',
  CMi: 'こいぬ座',
  Lep: 'うさぎ座',
  Col: 'はと座',
  Eri: 'エリダヌス座',
  Cet: 'くじら座',
  For: 'ろ座',
  Scu: 'たて座',
  Hya: 'うみへび座',
  Crt: 'コップ座',
  Crv: 'からす座',
  Cen: 'ケンタウルス座',
  Lup: 'おおかみ座',
  Ara: 'さいだん座',
  Aql: 'わし座',
  Lyr: 'こと座',
  Cyg: 'はくちょう座',
  Her: 'ヘルクレス座',
  Peg: 'ペガスス座',
  And: 'アンドロメダ座',
  Tri: 'さんかく座',
  Aur2: null,
};

const INFO = {};
const missing = [];
for (const f of consts.features) {
  const id = f.id;
  if (!LINES[id]) continue;
  const ja = JA_OVERRIDE[id] || f.properties.ja || null;
  if (!ja) missing.push(id);
  INFO[id] = { ja: ja || f.properties.name, la: f.properties.la || f.properties.name };
}

// 星座名を置くための代表点（星座線の頂点の平均方向）
for (const id of Object.keys(LINES)) {
  let x = 0, y = 0, z = 0, n = 0;
  for (const seg of LINES[id]) {
    for (const [ra, dec] of seg) {
      const a = (ra * Math.PI) / 180, d = (dec * Math.PI) / 180;
      x += Math.cos(d) * Math.cos(a);
      y += Math.cos(d) * Math.sin(a);
      z += Math.sin(d);
      n++;
    }
  }
  const r = Math.hypot(x, y, z) || 1;
  x /= r; y /= r; z /= r;
  const ra = norm360((Math.atan2(y, x) * 180) / Math.PI);
  const dec = (Math.asin(z) * 180) / Math.PI;
  if (!INFO[id]) INFO[id] = { ja: id, la: id };
  INFO[id].c = [r3(ra), r3(dec)];
}

// ---- 固有名（日本語） -----------------------------------------------------
// 4.0 等より明るい星のうち、日本語の固有名が付いているものだけ。英語の固有名（Larawag など）を
// こちらで勝手にカタカナに直すと読みを誤るので、載せない方を選ぶ。
const BRIGHT = new Set(STARS.filter((s) => s[2] <= 4.0).map((s) => s[3]));
const NAMES = {};
for (const [hip, v] of Object.entries(names)) {
  const id = Number(hip);
  if (!BRIGHT.has(id) || !v.ja) continue;
  NAMES[id] = v.ja;
}

const out = `// 自動生成ファイル — tools/build-data.mjs が生成する。直接編集しないこと。
// 出典: ofrohn/d3-celestial (BSD-3-Clause) / Hipparcos catalogue / IAU constellation lines
// 座標は J2000.0 の赤経赤緯（度）。
export const STARS = ${JSON.stringify(STARS)};
export const LINES = ${JSON.stringify(LINES)};
export const INFO = ${JSON.stringify(INFO)};
export const NAMES = ${JSON.stringify(NAMES)};
`;

const dest = path.join(HERE, '..', 'src', 'data.js');
fs.writeFileSync(dest, out);
process.stderr.write(
  `stars=${STARS.length} constellations=${Object.keys(LINES).length} names=${Object.keys(NAMES).length} ` +
  `missing_ja=${missing.join(',') || 'none'}\n` +
  `wrote ${dest} (${(out.length / 1024).toFixed(0)} KB)\n`
);
