// EXIF の読み取りと、赤経赤緯 → 方位・高度の変換を確かめる。
//   node test/exif-altaz.test.mjs

import { readExif, fovFromFocal35 } from '../src/exif.js';
import { toAltAz, dirName, gmst } from '../src/altaz.js';

let ng = 0;
const ok = (cond, name, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) ng++;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ---- EXIF ------------------------------------------------------------------
// 最小限の JPEG（APP1 に EXIF）を組み立てて、読めるかを見る。
function buildJpegWithExif() {
  const tiff = [];
  const push16 = (a, v) => { a.push(v & 0xff, (v >> 8) & 0xff); };
  const push32 = (a, v) => { a.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff); };

  // データ領域（4 バイトに収まらない値の置き場）は IFD の後ろに置く
  const heap = [];
  const HEAP_BASE = 8 + 2 + 12 * 3 + 4 + 2 + 12 * 3 + 4 + 2 + 12 * 4 + 4;
  const addHeap = (bytes) => {
    const off = HEAP_BASE + heap.length;
    heap.push(...bytes);
    return off;
  };
  const rational = (num, den) => {
    const b = [];
    push32(b, num); push32(b, den);
    return b;
  };

  const dateStr = '2026:08:19 21:30:00\0';
  const dateOff = addHeap([...dateStr].map((c) => c.charCodeAt(0)));
  // 北緯 35度40分30秒 / 東経 139度46分12秒
  const latOff = addHeap([...rational(35, 1), ...rational(40, 1), ...rational(30, 1)]);
  const lonOff = addHeap([...rational(139, 1), ...rational(46, 1), ...rational(12, 1)]);
  const nOff = addHeap([0x4e, 0]); // "N"
  const eOff = addHeap([0x45, 0]); // "E"

  const entry = (tag, type, count, valueBytes) => {
    const e = [];
    push16(e, tag); push16(e, type); push32(e, count);
    while (valueBytes.length < 4) valueBytes.push(0);
    e.push(...valueBytes.slice(0, 4));
    return e;
  };
  const off32 = (v) => { const b = []; push32(b, v); return b; };
  const short = (v) => { const b = []; push16(b, v); return b; };

  const IFD0_OFF = 8;
  const EXIF_OFF = IFD0_OFF + 2 + 12 * 3 + 4;
  const GPS_OFF = EXIF_OFF + 2 + 12 * 3 + 4;

  // TIFF ヘッダ（リトルエンディアン）
  tiff.push(0x49, 0x49); push16(tiff, 42); push32(tiff, IFD0_OFF);

  // IFD0: Orientation / ExifIFD / GPSIFD
  push16(tiff, 3);
  tiff.push(...entry(0x0112, 3, 1, short(1)));
  tiff.push(...entry(0x8769, 4, 1, off32(EXIF_OFF)));
  tiff.push(...entry(0x8825, 4, 1, off32(GPS_OFF)));
  push32(tiff, 0);

  // Exif IFD: FocalLength / FocalLengthIn35mmFilm / DateTimeOriginal
  push16(tiff, 3);
  tiff.push(...entry(0x920a, 5, 1, off32(addHeap(rational(52, 10)))));
  tiff.push(...entry(0xa405, 3, 1, short(26)));
  tiff.push(...entry(0x9003, 2, dateStr.length, off32(dateOff)));
  push32(tiff, 0);

  // GPS IFD
  push16(tiff, 4);
  tiff.push(...entry(1, 2, 2, off32(nOff)));
  tiff.push(...entry(2, 5, 3, off32(latOff)));
  tiff.push(...entry(3, 2, 2, off32(eOff)));
  tiff.push(...entry(4, 5, 3, off32(lonOff)));
  push32(tiff, 0);

  tiff.push(...heap);

  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]; // "Exif\0\0" + TIFF
  const out = [0xff, 0xd8, 0xff, 0xe1];
  out.push(((app1.length + 2) >> 8) & 0xff, (app1.length + 2) & 0xff);
  out.push(...app1, 0xff, 0xda);
  return new Uint8Array(out).buffer;
}

const ex = readExif(buildJpegWithExif());
ok(!!ex, 'EXIF を読める');
ok(ex && ex.focal35 === 26, '35mm換算焦点距離', `${ex && ex.focal35}mm`);
ok(ex && near(ex.focal, 5.2, 0.001), '実焦点距離', `${ex && ex.focal}mm`);
ok(ex && near(ex.lat, 35.675, 0.001), '緯度', `${ex && ex.lat}`);
ok(ex && near(ex.lon, 139.77, 0.001), '経度', `${ex && ex.lon}`);
ok(ex && ex.dateTimeRaw === '2026:08:19 21:30:00', '撮影日時', ex && ex.dateTimeRaw);
ok(readExif(new Uint8Array([1, 2, 3]).buffer) === null, 'JPEG でないものは null を返す');

const fov = fovFromFocal35(26);
ok(near(fov, 79.6, 0.5), '26mm の対角画角', `${fov.toFixed(1)}度`);

// ---- 方位・高度 ------------------------------------------------------------
const TOKYO = [35.68, 139.77];
const date = new Date(Date.UTC(2026, 7, 19, 12, 0, 0));

// 天の北極の高度は観測地の緯度に等しい
const pole = toAltAz(0, 90, date, TOKYO[0], TOKYO[1]);
ok(near(pole.alt, TOKYO[0], 0.1), '天の北極の高度＝緯度', `${pole.alt.toFixed(2)}度`);
ok(near(pole.az, 0, 0.5) || near(pole.az, 360, 0.5), '天の北極の方位は真北', `${pole.az.toFixed(2)}度`);

// 以下、入力は J2000 の座標なので、2026 年の分点まで歳差補正される。
// そのぶん最大 0.7 度ほどずれるのが正しい挙動なので、許容も 1 度にしてある。
// 地方恒星時に等しい赤経・緯度に等しい赤緯の点は、ほぼ天頂に来る
const lst = (gmst(date) + TOKYO[1]) % 360;
const zenith = toAltAz(lst, TOKYO[0], date, TOKYO[0], TOKYO[1]);
ok(near(zenith.alt, 90, 1.0), '子午線上・緯度と同じ赤緯の星は天頂', `${zenith.alt.toFixed(2)}度`);

// 子午線上で天頂より南の星は真南
const south = toAltAz(lst, TOKYO[0] - 30, date, TOKYO[0], TOKYO[1]);
ok(near(south.az, 180, 1.0), '子午線上の南寄りの星は真南', `${south.az.toFixed(2)}度`);
ok(near(south.alt, 60, 1.0), 'その高度は 90-30 度', `${south.alt.toFixed(2)}度`);

// 東の地平線から昇ってくる星（赤緯 0 は真東から昇る）
const rising = toAltAz((lst + 90) % 360, 0, date, TOKYO[0], TOKYO[1]);
ok(near(rising.alt, 0, 1.0), '赤緯0で時角-6hの星は地平線上', `${rising.alt.toFixed(2)}度`);
ok(near(rising.az, 90, 1.0), 'その方位は真東', `${rising.az.toFixed(2)}度`);

ok(dirName(0) === '北' && dirName(90) === '東' && dirName(180) === '南' && dirName(247.5) === '西南西',
  '方角の名前');

console.log(ng ? `\n${ng} 件不合格` : '\nすべて合格');
process.exit(ng ? 1 : 0);
