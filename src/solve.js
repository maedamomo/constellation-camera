// プレートソルビング: 検出した点光源の配置だけから、
// その写真が天球のどこを・どの向きで・どれだけの画角で写したものかを求める。
//
// 方針（astrometry.net や ASTAP と同じ発想の簡略版）:
//   1. 画像上の 2 星の組と、星表上の 2 星の組を仮に対応させる。
//   2. 「2 点の画素上の位置」と「その 2 星の真の角距離」から焦点距離 f が一意に決まる。
//      （f が大きいほど 2 点のなす角は小さくなる。単調なので解は高々ひとつ）
//   3. f が決まればカメラ座標が定まり、2 組の対応から回転行列 R が定まる。
//   4. その仮説で他の星がどれだけ合うかを数え、十分合えば正解とみなす。
//   5. 最後に最小二乗で f・R・歪み係数を微調整する。
//
// 画角が未知でも解けるのが利点。EXIF から画角が分かる場合は探索範囲を狭めて高速化する。

import {
  DEG, sph2vec, vec2sph, matVec, matT, matMul, rotFromVec,
  Camera, fFromFovDiag, solveFocalFromPair, SkyIndex,
} from './astro.js';

/** 星表（[ra,dec,mag,hip] の配列）から計算用の構造を作る */
export function buildCatalog(starRows, magLimit) {
  const rows = starRows.filter((s) => s[2] <= magLimit);
  const vectors = rows.map((s) => sph2vec(s[0], s[1]));
  return {
    rows,
    vectors,
    mag: rows.map((s) => s[2]),
    hip: rows.map((s) => s[3]),
    index: new SkyIndex(vectors, 0.02),
  };
}

/**
 * 星表の中から、角距離が maxSep 以下の 2 星の組をすべて作り、角距離順に並べる。
 * 仮説生成のときに「この角距離の組」を二分探索で引くために使う。
 */
export function buildPairIndex(cat, maxSepDeg) {
  const n = cat.vectors.length;
  const maxCos = Math.cos(maxSepDeg * DEG);
  const tmp = [];
  for (let i = 0; i < n; i++) {
    const vi = cat.vectors[i];
    for (let j = i + 1; j < n; j++) {
      const vj = cat.vectors[j];
      const c = vi[0] * vj[0] + vi[1] * vj[1] + vi[2] * vj[2];
      if (c < maxCos) continue;
      tmp.push([Math.acos(Math.min(1, Math.max(-1, c))), i, j]);
    }
  }
  tmp.sort((a, b) => a[0] - b[0]);
  const sep = new Float64Array(tmp.length);
  const cos = new Float64Array(tmp.length);
  const ia = new Int32Array(tmp.length);
  const ib = new Int32Array(tmp.length);
  for (let k = 0; k < tmp.length; k++) {
    sep[k] = tmp[k][0]; cos[k] = Math.cos(tmp[k][0]);
    ia[k] = tmp[k][1]; ib[k] = tmp[k][2];
  }
  return { sep, cos, ia, ib, n: tmp.length };
}

function lowerBound(arr, n, x) {
  let lo = 0, hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** 検出点を画素座標で引くための粗い格子 */
class PixGrid {
  constructor(points, cell) {
    this.cell = cell;
    this.points = points;
    this.map = new Map();
    points.forEach((p, i) => {
      const k = (Math.floor(p.x / cell) << 16) | (Math.floor(p.y / cell) & 0xffff);
      let a = this.map.get(k);
      if (!a) this.map.set(k, (a = []));
      a.push(i);
    });
  }
  nearest(x, y, maxD) {
    const c = this.cell, n = Math.max(1, Math.ceil(maxD / c));
    const bx = Math.floor(x / c), by = Math.floor(y / c);
    let best = -1, bestD = maxD * maxD;
    for (let dx = -n; dx <= n; dx++)
      for (let dy = -n; dy <= n; dy++) {
        const a = this.map.get(((bx + dx) << 16) | ((by + dy) & 0xffff));
        if (!a) continue;
        for (const i of a) {
          const p = this.points[i];
          const d2 = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y);
          if (d2 < bestD) { bestD = d2; best = i; }
        }
      }
    return best < 0 ? null : [best, Math.sqrt(bestD)];
  }
}

/**
 * 与えられたカメラと回転で、星表と検出点を突き合わせる。
 * 星表側から画像に投影し、許容半径内で最も近い検出点と対応づける。
 */
function matchAll(cam, R, cat, grid, dets, tolPix, magLimit) {
  const Rt = matT(R);
  const used = new Map(); // 検出点 index -> 対応の距離
  const out = [];
  for (let i = 0; i < cat.vectors.length; i++) {
    if (cat.mag[i] > magLimit) continue;
    const d = matVec(Rt, cat.vectors[i]);
    const p = cam.camToPix(d);
    if (!p) continue;
    if (p[0] < -tolPix || p[1] < -tolPix || p[0] > cam.width + tolPix || p[1] > cam.height + tolPix) continue;
    const hit = grid.nearest(p[0], p[1], tolPix);
    if (!hit) continue;
    const [di, dist] = hit;
    const prev = used.get(di);
    if (prev !== undefined && prev[1] <= dist) continue;
    if (prev !== undefined) prev[2] = true; // 置き換えられた対応を無効化
    const rec = [i, dist, false, di, p[0], p[1]];
    used.set(di, rec);
    out.push(rec);
  }
  const matches = [];
  for (const rec of out) {
    if (rec[2]) continue;
    matches.push({
      cat: rec[0], det: rec[3], dist: rec[1],
      px: rec[4], py: rec[5],
      dx: dets[rec[3]].x - rec[4], dy: dets[rec[3]].y - rec[5],
    });
  }
  return matches;
}

/** 5x5 までの小さな線形方程式を解く（部分ピボット付きガウス消去） */
function solveLinear(A, b, n) {
  const M = A.map((r, i) => r.slice(0, n).concat([b[i]]));
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-14) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/**
 * 最小二乗（Levenberg–Marquardt、ヤコビアンは数値微分）で
 * 回転・焦点距離・歪み係数を微調整する。
 */
function refine(cam0, R0, cat, matches, dets, useK1) {
  const nP = useK1 ? 5 : 4;
  let R = R0.slice();
  let f = cam0.f, k1 = cam0.k1 || 0;
  let lambda = 1e-3;

  const residuals = (rot, ff, kk) => {
    const cam = new Camera(cam0.width, cam0.height, ff, kk);
    const Rt = matT(rot);
    const res = new Float64Array(matches.length * 2);
    for (let m = 0; m < matches.length; m++) {
      const mm = matches[m];
      const p = cam.camToPix(matVec(Rt, cat.vectors[mm.cat]));
      if (!p) { res[m * 2] = 1e3; res[m * 2 + 1] = 1e3; continue; }
      res[m * 2] = dets[mm.det].x - p[0];
      res[m * 2 + 1] = dets[mm.det].y - p[1];
    }
    return res;
  };
  const cost = (r) => { let s = 0; for (let i = 0; i < r.length; i++) s += r[i] * r[i]; return s; };

  let r = residuals(R, f, k1);
  let c = cost(r);

  for (let iter = 0; iter < 30; iter++) {
    // 数値微分でヤコビアンを作る
    const steps = [1e-5, 1e-5, 1e-5, Math.max(1e-3, f * 1e-5), 1e-5];
    const J = [];
    for (let p = 0; p < nP; p++) {
      let rp;
      if (p < 3) {
        const dv = [0, 0, 0]; dv[p] = steps[p];
        rp = residuals(matMul(rotFromVec(dv), R), f, k1);
      } else if (p === 3) {
        rp = residuals(R, f + steps[3], k1);
      } else {
        rp = residuals(R, f, k1 + steps[4]);
      }
      const col = new Float64Array(r.length);
      for (let i = 0; i < r.length; i++) col[i] = (rp[i] - r[i]) / steps[p];
      J.push(col);
    }
    // 正規方程式 (JᵀJ + λI) δ = Jᵀ r
    const A = [], b = [];
    for (let i = 0; i < nP; i++) {
      const row = [];
      for (let j = 0; j < nP; j++) {
        let s = 0;
        for (let k = 0; k < r.length; k++) s += J[i][k] * J[j][k];
        row.push(s);
      }
      A.push(row);
      let s = 0;
      for (let k = 0; k < r.length; k++) s += J[i][k] * r[k];
      b.push(s);
    }
    let improved = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      const Ad = A.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) + 1e-12 : v)));
      const d = solveLinear(Ad, b, nP);
      if (!d) break;
      const Rn = matMul(rotFromVec([d[0], d[1], d[2]]), R);
      const fn = f + d[3];
      const kn = useK1 ? k1 + d[4] : k1;
      if (!(fn > 1) || !isFinite(fn)) { lambda *= 10; continue; }
      const rn = residuals(Rn, fn, kn);
      const cn = cost(rn);
      if (cn < c) {
        R = Rn; f = fn; k1 = kn; r = rn;
        const rel = (c - cn) / Math.max(c, 1e-12);
        c = cn; lambda = Math.max(1e-9, lambda / 3);
        improved = true;
        if (rel < 1e-6) iter = 99;
        break;
      }
      lambda *= 10;
    }
    if (!improved) break;
  }
  const rms = Math.sqrt(c / Math.max(1, matches.length * 2));
  return { R, f, k1, rms };
}

/**
 * 仮説を磨き上げて、偶然の一致でないかを判定する。
 *
 * 偶然の一致がどれくらい起きうるかを見積もり（視野内の星表の星数 ×
 * 許容円の面積 × 検出点の密度）、それを十分上回る数が合ったときだけ採用する。
 * この判定を入れないと、星が数個たまたま合っただけの誤答を拾ってしまう。
 */
function polish(cam0, R0, cat, grid, dets, tolPix, verifyMag, width, height) {
  let cam = cam0, R = R0;
  let matches = matchAll(cam, R, cat, grid, dets, tolPix, verifyMag);
  if (matches.length < 6) return null;
  let rms = null;

  for (let pass = 0; pass < 3; pass++) {
    const useK1 = pass > 0 && matches.length >= 16;
    const out = refine(cam, R, cat, matches, dets, useK1);
    const camN = new Camera(width, height, out.f, out.k1);
    const tol = Math.max(2.5, tolPix * (pass === 0 ? 0.7 : 0.45));
    const mN = matchAll(camN, out.R, cat, grid, dets, tol, verifyMag);
    if (mN.length < 5) break;
    cam = camN; R = out.R; matches = mN; rms = out.rms;
  }
  if (rms === null || matches.length < 6) return null;

  // 偶然の一致の期待値
  const fovW = 2 * Math.atan(width / 2 / cam.f);
  const fovH = 2 * Math.atan(height / 2 / cam.f);
  const areaDeg2 = (fovW / DEG) * (fovH / DEG);
  if (cat._countCache === undefined || cat._countMag !== verifyMag) {
    let n = 0;
    for (let i = 0; i < cat.mag.length; i++) if (cat.mag[i] <= verifyMag) n++;
    cat._countCache = n; cat._countMag = verifyMag;
  }
  const density = cat._countCache / 41253;
  const nInField = density * areaDeg2;
  const tolFinal = Math.max(2.5, tolPix * 0.45);
  const expected = nInField * Math.PI * tolFinal * tolFinal * (dets.length / (width * height));
  const need = Math.max(12, Math.ceil(8 * expected));

  if (matches.length < need) return null;
  if (rms > Math.max(2.0, tolPix * 0.3)) return null;

  // 明るい星ほど見逃しにくい。視野内にあるはずの明るい星が
  // ほとんど写っていない解は、偶然の一致を疑う。
  const Rt = matT(R);
  let nBright = 0, nBrightMatched = 0;
  const matched = new Set(matches.map((m) => m.cat));
  for (let i = 0; i < cat.vectors.length; i++) {
    if (cat.mag[i] > 4.0) continue;
    const p = cam.camToPix(matVec(Rt, cat.vectors[i]));
    if (!p) continue;
    const m = Math.min(width, height) * 0.04; // 縁は写り方が不安定なので除く
    if (p[0] < m || p[1] < m || p[0] > width - m || p[1] > height - m) continue;
    nBright++;
    if (matched.has(i)) nBrightMatched++;
  }
  if (nBright >= 5 && nBrightMatched / nBright < 0.35) return null;

  return { cam, R, matches, rms, expected, need, nBright, nBrightMatched };
}

function* searchOnce(dets, width, height, opt, fovRange, stats) {
  const cx = width / 2, cy = height / 2;
  const diag = Math.hypot(width, height);
  const [fovMin, fovMax] = fovRange;
  const fMin = fFromFovDiag(width, height, fovMax);
  const fMax = fFromFovDiag(width, height, fovMin);
  const tolPix = opt.tolPix ?? Math.max(4, diag * 0.005);
  const nHyp = Math.min(dets.length, opt.nHyp ?? 28);
  const nFirst = Math.min(nHyp, opt.nFirst ?? 14);
  const verifyMag = opt.verifyMag ?? 5.6;
  const deadline = opt.deadline;
  const cat = opt.catalog;
  const quick = opt.quickCatalog || cat;
  const qDensity = quick.vectors.length / 41253; // 1 平方度あたりの星の数

  const Ux = new Float64Array(dets.length), Uy = new Float64Array(dets.length);
  for (let m = 0; m < dets.length; m++) { Ux[m] = dets[m].x - cx; Uy[m] = -(dets[m].y - cy); }
  const grid = new PixGrid(dets, Math.max(16, tolPix * 2));
  const qidx = quick.index;

  // 画像側のペアは明るい星どうしを先に試す
  const pairs = [];
  for (let i = 0; i < nFirst; i++)
    for (let j = i + 1; j < nHyp; j++) pairs.push([i, j, i + j * 1.0001]);
  pairs.sort((a, b) => a[2] - b[2]);

  for (const tier of opt.hypCatalogs) {
    const hc = tier.cat, hp = tier.pairs;
    for (const [i, j] of pairs) {
      const now = Date.now();
      if (now > deadline) return null;
      // 画面を固まらせないよう、ときどき呼び出し側に制御を返す
      if (now - stats.lastYield > 30) {
        stats.lastYield = now;
        yield { tested: stats.tested, verified: stats.verified, fovRange };
      }
      const u1 = Ux[i], v1 = Uy[i], u2 = Ux[j], v2 = Uy[j];
      const r1 = Math.hypot(u1, v1), r2 = Math.hypot(u2, v2);
      if (r1 < 1 || r2 < 1) continue;
      const p12 = u1 * u2 + v1 * v2;
      const phi = Math.acos(Math.min(1, Math.max(-1, p12 / (r1 * r2))));
      const th = (f) => {
        const ff = f * f;
        return Math.acos(Math.min(1, Math.max(-1,
          (p12 + ff) / (Math.sqrt(r1 * r1 + ff) * Math.sqrt(r2 * r2 + ff)))));
      };
      const sepLo = th(fMax), sepHi = Math.min(phi, th(fMin));
      if (!(sepHi > sepLo)) continue;

      // 明るさの差は星表と画像でおおよそ一致するはず（飽和している星は除く）
      const dImag = dets[i].imag - dets[j].imag;
      const useMag = !dets[i].sat && !dets[j].sat;

      let k = lowerBound(hp.sep, hp.n, sepLo);
      for (; k < hp.n && hp.sep[k] <= sepHi; k++) {
        const a = hp.ia[k], b = hp.ib[k];
        const dMag = hc.mag[a] - hc.mag[b];
        for (let swap = 0; swap < 2; swap++) {
          const ai = swap ? b : a, bi = swap ? a : b;
          if (useMag) {
            const dm = swap ? -dMag : dMag;
            if (Math.abs(dm - dImag) > 1.6) continue;
          }
          const f = solveFocalFromPair(u1, v1, u2, v2, hp.cos[k], fMin, fMax);
          if (f === null) continue;
          stats.tested++;

          // ここは数百万回まわるので、配列を作らずスカラーだけで回転行列を組む。
          // カメラ側・天球側それぞれに正規直交の三脚を作り、R = B Aᵀ とする。
          const n1 = 1 / Math.sqrt(r1 * r1 + f * f), n2 = 1 / Math.sqrt(r2 * r2 + f * f);
          const a1x = u1 * n1, a1y = v1 * n1, a1z = f * n1;
          const e2x = u2 * n2, e2y = v2 * n2, e2z = f * n2;
          let a2x = a1y * e2z - a1z * e2y, a2y = a1z * e2x - a1x * e2z, a2z = a1x * e2y - a1y * e2x;
          const na = Math.sqrt(a2x * a2x + a2y * a2y + a2z * a2z);
          if (na < 1e-9) continue;
          a2x /= na; a2y /= na; a2z /= na;
          const a3x = a1y * a2z - a1z * a2y, a3y = a1z * a2x - a1x * a2z, a3z = a1x * a2y - a1y * a2x;

          const cv = hc.vectors[ai], cw = hc.vectors[bi];
          const b1x = cv[0], b1y = cv[1], b1z = cv[2];
          let b2x = b1y * cw[2] - b1z * cw[1], b2y = b1z * cw[0] - b1x * cw[2], b2z = b1x * cw[1] - b1y * cw[0];
          const nb = Math.sqrt(b2x * b2x + b2y * b2y + b2z * b2z);
          if (nb < 1e-9) continue;
          b2x /= nb; b2y /= nb; b2z /= nb;
          const b3x = b1y * b2z - b1z * b2y, b3y = b1z * b2x - b1x * b2z, b3z = b1x * b2y - b1y * b2x;

          const r00 = b1x * a1x + b2x * a2x + b3x * a3x;
          const r01 = b1x * a1y + b2x * a2y + b3x * a3y;
          const r02 = b1x * a1z + b2x * a2z + b3x * a3z;
          const r10 = b1y * a1x + b2y * a2x + b3y * a3x;
          const r11 = b1y * a1y + b2y * a2y + b3y * a3y;
          const r12 = b1y * a1z + b2y * a2z + b3y * a3z;
          const r20 = b1z * a1x + b2z * a2x + b3z * a3x;
          const r21 = b1z * a1y + b2z * a2y + b3z * a3y;
          const r22 = b1z * a1z + b2z * a2z + b3z * a3z;

          // 粗い検査: 明るい星表だけを使って、上位の検出点が何個当たるかを見る。
          // 何個当たれば「偶然でない」と言えるかは画角によって変わる
          // （視野が広い仮説ほど許容角が大きく、偶然当たりやすい）ので、
          // 期待値と標準偏差から必要数をその都度決める。
          const tolAng = (tolPix / f) * 1.5;
          const tolDeg = tolAng * 57.29577951308232;
          const pr = qDensity * Math.PI * tolDeg * tolDeg;
          const maxTries = 16;
          const need1 = Math.max(3, Math.ceil(maxTries * pr + 3 * Math.sqrt(maxTries * pr)));
          let hits = 0, tries = 0;
          for (let m = 0; m < dets.length && tries < maxTries; m++) {
            if (m === i || m === j) continue;
            tries++;
            const um = Ux[m], vm = Uy[m];
            const nm = 1 / Math.sqrt(um * um + vm * vm + f * f);
            const dx = um * nm, dy = vm * nm, dz = f * nm;
            if (qidx.hasNear(
              r00 * dx + r01 * dy + r02 * dz,
              r10 * dx + r11 * dy + r12 * dz,
              r20 * dx + r21 * dy + r22 * dz, tolAng)) hits++;
            if (hits + (maxTries - tries) < need1) break;
          }
          if (hits < need1) continue;
          stats.passed1++;

          // 中位の検査: 検出点をもっと多く天球に飛ばし、明るい星表に当たる数を数える。
          // ここを抜けた仮説だけを、重い本検査（polish）に回す。
          const maxTries2 = Math.min(dets.length, 50);
          const need2 = Math.max(6, Math.ceil(maxTries2 * pr + 4.5 * Math.sqrt(maxTries2 * pr)));
          let hits2 = 0, tries2 = 0;
          for (let m = 0; m < dets.length && tries2 < maxTries2; m++) {
            if (m === i || m === j) continue;
            tries2++;
            const um = Ux[m], vm = Uy[m];
            const nm = 1 / Math.sqrt(um * um + vm * vm + f * f);
            const dx = um * nm, dy = vm * nm, dz = f * nm;
            if (qidx.hasNear(
              r00 * dx + r01 * dy + r02 * dz,
              r10 * dx + r11 * dy + r12 * dz,
              r20 * dx + r21 * dy + r22 * dz, tolAng)) hits2++;
            if (hits2 + (maxTries2 - tries2) < need2) break;
          }
          if (hits2 < need2) continue;
          stats.verified++;

          const R = [r00, r01, r02, r10, r11, r12, r20, r21, r22];
          const cam = new Camera(width, height, f, 0);
          const got = polish(cam, R, cat, grid, dets, tolPix, verifyMag, width, height);
          if (got) return got;
        }
      }
    }
  }
  return null;
}

/**
 * 本体。検出点から解を探す。
 *
 * @param {Array<{x:number,y:number,flux:number,imag:number,sat:boolean}>} dets 明るい順の検出点
 * @param {number} width @param {number} height
 * @param {object} opt
 *   catalog      : buildCatalog の結果（照合用。5.6 等程度まで）
 *   quickCatalog : 粗い検査用の明るい星表（4.8 等程度まで）
 *   hypCatalogs  : [{cat, pairs}] 仮説生成用（明るい順のティア）
 *   fovRange     : [最小画角, 最大画角]（度, 対角）。省略時は段階探索
 *   onProgress   : 進捗コールバック
 * @returns {object|null}
 */
export function* solvePlateGen(dets, width, height, opt) {
  if (dets.length < 6) return null;
  const deadline = opt.deadline ?? Date.now() + 40000;
  const stats = { tested: 0, passed1: 0, verified: 0, lastYield: Date.now() };
  const o = { ...opt, deadline };

  // 画角が分かっていればその範囲だけ。分からなければ段階的に広げる。
  const ranges = opt.fovRange
    ? [[opt.fovRange, 1]]
    // スマホの標準的な画角 → 超広角 → 望遠 の順（ありそうな順）に広げる
    : [[[45, 92], 0.4], [[88, 118], 0.35], [[20, 46], 0.6], [[12, 21], 1]];

  for (const [range, weight] of ranges) {
    const now = Date.now();
    if (now > deadline) break;
    // 段階ごとに持ち時間を配分する（前段が早く終われば後段が長く使える）
    o.deadline = Math.min(deadline, now + (deadline - now) * weight);
    const got = yield* searchOnce(dets, width, height, o, range, stats);
    if (opt.onProgress) opt.onProgress({ range, ...stats, found: !!got });
    if (got) {
      const { cam, R, matches, rms } = got;
      return {
        R, camera: cam, f: cam.f, k1: cam.k1,
        matches, rms,
        tested: stats.tested, passed1: stats.passed1, verified: stats.verified,
        nMatch: matches.length,
        need: got.need, expected: got.expected,
        center: vec2sph(matVec(R, [0, 0, 1])),
        up: matVec(R, [0, 1, 0]),
        fovDiag: cam.fovDiag(),
        fovWidth: (2 * Math.atan(width / 2 / cam.f)) / DEG,
        fovHeight: (2 * Math.atan(height / 2 / cam.f)) / DEG,
      };
    }
  }
  return null;
}

/** 同期版（テストや、進捗表示のいらない場面で使う） */
export function solvePlate(dets, width, height, opt) {
  const g = solvePlateGen(dets, width, height, opt);
  let r = g.next();
  while (!r.done) r = g.next();
  return r.value;
}

/** 解を使って天球座標 → 画素座標 */
export function skyToPix(sol, raDeg, decDeg) {
  const d = matVec(matT(sol.R), sph2vec(raDeg, decDeg));
  return sol.camera.camToPix(d);
}

/** 解を使って画素座標 → 天球座標 */
export function pixToSky(sol, px, py) {
  return vec2sph(matVec(sol.R, sol.camera.pixToCam(px, py)));
}
