// 画面まわり。写真の読み込み → 星の検出 → 星図との照合 → 重ね描き。
// 処理はすべてブラウザの中で完結する（写真はどこにも送らない）。

import { STARS, LINES, INFO, NAMES } from './data.js';
import { detectStars } from './detect.js';
import { buildCatalog, buildPairIndex, solvePlateGen } from './solve.js';
import { readExif, fovFromFocal35 } from './exif.js';
import { toAltAz, dirName } from './altaz.js';
import { drawOverlay, visibleConstellations, project } from './overlay.js';
import { makeSky } from './sample.js';
import { sph2vec, vec2sph, matVec, matT, angleBetween, DEG } from './astro.js';

const $ = (id) => document.getElementById(id);
const WORK_MAX = 1400; // 解析に使う画像の長辺（画素）

const state = {
  sol: null, dets: null, cons: null, exif: null,
  width: 0, height: 0, only: null,
  show: { lines: true, names: true, starNames: true, stars: false },
};

let CAT = null;
function catalogs(onStatus) {
  if (CAT) return CAT;
  if (onStatus) onStatus('星表を準備しています…');
  const catalog = buildCatalog(STARS, 5.6);
  const quickCatalog = buildCatalog(STARS, 4.8);
  const tiers = [[3.2, 115], [4.2, 75], [5.0, 35]].map(([m, sep]) => {
    const c = buildCatalog(STARS, m);
    return { name: `${m}等`, cat: c, pairs: buildPairIndex(c, sep) };
  });
  CAT = { catalog, quickCatalog, tiers };
  return CAT;
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

function status(msg, sub) {
  $('status').hidden = false;
  $('statusMain').textContent = msg;
  $('statusSub').textContent = sub || '';
}
function hideStatus() { $('status').hidden = true; }

function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像を読み込めませんでした')); };
    img.src = url;
  });
}

/** 解析用の縮小画像を作る */
function toWorkCanvas(source, sw, sh) {
  const scale = Math.min(1, WORK_MAX / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  return c;
}

/** 生成器を少しずつ回して、画面を固まらせずに解く */
async function solveAsync(dets, w, h, opt) {
  const gen = solvePlateGen(dets, w, h, opt);
  let r = gen.next();
  while (!r.done) {
    const p = r.value;
    if (p && p.tested) {
      const [a, b] = p.fovRange || [0, 0];
      status('星の並びを星図と照合しています…',
        `画角 ${Math.round(a)}〜${Math.round(b)}度 を探索中 / ${(p.tested / 10000).toFixed(0)}万通り試行`);
    }
    await nextFrame();
    r = gen.next();
  }
  return r.value;
}

async function analyze(canvas, exif) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  state.width = canvas.width; state.height = canvas.height;

  status('写真から星を探しています…');
  await nextFrame();
  const { stars } = detectStars(img, { maxStars: 150 });
  state.dets = stars;

  if (stars.length < 6) {
    fail(`星らしい点が ${stars.length} 個しか見つかりませんでした。`);
    return;
  }

  status('星表を準備しています…', `${stars.length} 個の光点を検出`);
  await nextFrame();
  const { catalog, quickCatalog, tiers } = catalogs();

  const base = {
    catalog, quickCatalog, hypCatalogs: tiers,
    deadline: Date.now() + 45000,
  };

  // EXIF に 35mm 換算焦点距離があれば、そこから画角を絞って先に試す（ふつうは一瞬で解ける）
  let sol = null;
  const fov = exif && fovFromFocal35(exif.focal35);
  if (fov) {
    status('星の並びを星図と照合しています…', `写真の記録から画角 約${fov.toFixed(0)}度 として照合`);
    await nextFrame();
    sol = await solveAsync(state.dets, canvas.width, canvas.height, {
      ...base, fovRange: [fov * 0.72, fov * 1.35], deadline: Date.now() + 15000,
    });
  }
  if (!sol) {
    sol = await solveAsync(state.dets, canvas.width, canvas.height, {
      ...base, deadline: Date.now() + 45000,
    });
  }

  if (!sol) {
    fail(`星は ${stars.length} 個見つかりましたが、星図の並びと一致しませんでした。`);
    return;
  }

  state.sol = sol;
  state.cons = visibleConstellations(sol, LINES, INFO, canvas.width, canvas.height);
  state.only = null;
  hideStatus();
  render();
  $('result').hidden = false;
  $('failure').hidden = true;
  $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function fail(reason) {
  hideStatus();
  $('result').hidden = true;
  $('failure').hidden = false;
  $('failReason').textContent = reason;
}

function render() {
  const sol = state.sol;
  const ov = $('ov');
  ov.width = state.width; ov.height = state.height;
  const ctx = ov.getContext('2d');
  drawOverlay(ctx, sol, { LINES, INFO, NAMES, STARS }, {
    ...state.show,
    constellations: state.cons,
    only: state.only,
  });
  renderInfo();
}

function raStr(ra) {
  const h = ra / 15;
  return `${Math.floor(h)}時${String(Math.round((h % 1) * 60)).padStart(2, '0')}分`;
}

function renderInfo() {
  const sol = state.sol, cons = state.cons;
  const top = cons.slice(0, 3).map((c) => c.ja).join('・');
  $('headline').textContent = cons.length
    ? `${top}${cons.length > 3 ? ` ほか${cons.length - 3}星座` : ''} が写っています`
    : '星座の線が入る範囲には届きませんでした';

  const rows = [];
  rows.push(['写っている範囲', `対角 ${sol.fovDiag.toFixed(0)}度（横 ${sol.fovWidth.toFixed(0)}度 × 縦 ${sol.fovHeight.toFixed(0)}度）`]);
  rows.push(['画面中心の天球座標', `赤経 ${raStr(sol.center[0])} / 赤緯 ${sol.center[1] >= 0 ? '+' : ''}${sol.center[1].toFixed(1)}度`]);
  rows.push(['星図と一致した星', `${sol.nMatch} 個（位置のずれ ${sol.rms.toFixed(1)} 画素）`]);

  const ex = state.exif;
  if (ex && ex.dateTime && ex.lat != null) {
    const aa = toAltAz(sol.center[0], sol.center[1], ex.dateTime, ex.lat, ex.lon);
    rows.push(['向いていた方角', `${dirName(aa.az)}（方位 ${aa.az.toFixed(0)}度）・高度 ${aa.alt.toFixed(0)}度`]);
    rows.push(['撮影', `${ex.dateTime.toLocaleString('ja-JP')} / 北緯${ex.lat.toFixed(2)}度 東経${ex.lon.toFixed(2)}度`]);
  } else if (ex && ex.dateTime) {
    rows.push(['撮影日時', ex.dateTime.toLocaleString('ja-JP')]);
    rows.push(['方角', '位置情報が写真に入っていないため出せません']);
  }
  $('facts').innerHTML = rows.map(([k, v]) => `<div class="row"><dt>${k}</dt><dd>${v}</dd></div>`).join('');

  $('conList').innerHTML = cons.map((c) => {
    const pct = Math.round(c.frac * 100);
    const on = state.only === c.id;
    return `<button class="chip${on ? ' on' : ''}" data-id="${c.id}">${c.ja}` +
      `<span class="pct">${pct >= 95 ? '全体' : `${pct}%`}</span></button>`;
  }).join('');
  for (const b of $('conList').querySelectorAll('.chip')) {
    b.onclick = () => {
      state.only = state.only === b.dataset.id ? null : b.dataset.id;
      render();
    };
  }
}

/** 画面をタップしたとき、その点に何があるかを答える */
function whatIsAt(px, py) {
  const sol = state.sol;
  if (!sol) return null;
  const d = sol.camera.pixToCam(px, py);
  const v = matVec(sol.R, d);
  const [ra, dec] = vec2sph(v);

  let star = null, sd = 3 * DEG;
  for (const [sra, sdec, mag, hip] of STARS) {
    if (mag > 4.5) continue;
    const a = angleBetween(v, sph2vec(sra, sdec));
    if (a < sd) { sd = a; star = { ra: sra, dec: sdec, mag, hip }; }
  }
  let con = null, cd = 12 * DEG;
  for (const id of Object.keys(LINES)) {
    for (const seg of LINES[id]) {
      for (const [lra, ldec] of seg) {
        const a = angleBetween(v, sph2vec(lra, ldec));
        if (a < cd) { cd = a; con = id; }
      }
    }
  }
  return { ra, dec, star, con };
}

function setupTap() {
  const ov = $('ov');
  ov.onclick = (e) => {
    const r = ov.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * state.width;
    const py = ((e.clientY - r.top) / r.height) * state.height;
    const w = whatIsAt(px, py);
    if (!w) return;
    const parts = [];
    if (w.star) {
      const name = NAMES[w.star.hip];
      parts.push(name ? `${name}（${w.star.mag.toFixed(1)}等）` : `${w.star.mag.toFixed(1)}等の星`);
    }
    if (w.con) parts.push(`${(INFO[w.con] && INFO[w.con].ja) || w.con} のあたり`);
    parts.push(`赤経 ${raStr(w.ra)} / 赤緯 ${w.dec >= 0 ? '+' : ''}${w.dec.toFixed(1)}度`);
    $('tapInfo').textContent = parts.join(' ・ ');
    $('tapInfo').hidden = false;
  };
}

async function handleFile(file) {
  $('failure').hidden = true;
  $('result').hidden = true;
  try {
    status('写真を読み込んでいます…');
    const buf = await file.arrayBuffer();
    state.exif = readExif(buf);
    const img = await loadImageFile(file);
    const work = toWorkCanvas(img, img.naturalWidth, img.naturalHeight);
    const photo = $('photo');
    photo.width = work.width; photo.height = work.height;
    photo.getContext('2d').drawImage(work, 0, 0);
    await analyze(work, state.exif);
  } catch (err) {
    fail(`読み込みでつまずきました: ${err.message}`);
  }
}

async function useSample() {
  $('failure').hidden = true;
  $('result').hidden = true;
  status('サンプルの夜空を作っています…');
  await nextFrame();
  // 実在の星の配置から、スマホ写真に近い見え方の合成画像を作る
  const pick = [
    { ra: 83, dec: 0, roll: 12, fov: 62, limitMag: 5.2, glow: 60 },     // オリオン
    { ra: 290, dec: 32, roll: -8, fov: 70, limitMag: 5.3, glow: 50 },   // 夏の大三角
    { ra: 185, dec: 55, roll: 24, fov: 66, limitMag: 5.2, glow: 55 },   // 北斗七星
    { ra: 250, dec: -28, roll: 6, fov: 60, limitMag: 5.0, glow: 70 },   // さそり
  ][Math.floor(Math.random() * 4)];
  const sky = makeSky({ ...pick, width: 1400, height: 1050, seed: Math.floor(Math.random() * 1e6) });
  const c = document.createElement('canvas');
  c.width = sky.width; c.height = sky.height;
  c.getContext('2d').putImageData(new ImageData(sky.data, sky.width, sky.height), 0, 0);
  const photo = $('photo');
  photo.width = sky.width; photo.height = sky.height;
  photo.getContext('2d').drawImage(c, 0, 0);
  state.exif = null;
  await analyze(c, null);
}

function composite() {
  const out = document.createElement('canvas');
  out.width = state.width; out.height = state.height;
  const ctx = out.getContext('2d');
  ctx.drawImage($('photo'), 0, 0);
  ctx.drawImage($('ov'), 0, 0);
  const img = $('saveImg');
  img.src = out.toDataURL('image/jpeg', 0.9);
  img.hidden = false;
  $('saveHint').hidden = false;
}

export function init() {
  $('file').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) handleFile(f);
    e.target.value = '';
  });
  $('sample').addEventListener('click', useSample);
  $('save').addEventListener('click', composite);
  for (const key of ['lines', 'names', 'starNames', 'stars']) {
    const el = $('t_' + key);
    el.addEventListener('click', () => {
      state.show[key] = !state.show[key];
      el.classList.toggle('on', state.show[key]);
      render();
    });
    el.classList.toggle('on', state.show[key]);
  }
  setupTap();

  // ドラッグ＆ドロップ
  const drop = $('drop');
  ['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault(); drop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault(); drop.classList.remove('over');
  }));
  drop.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });
}
