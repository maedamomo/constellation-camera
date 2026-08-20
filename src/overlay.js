// 解けた写真の上に、星座線・星座名・星の名前を描く。
//
// 針穴カメラの投影では大円が直線に写るので、星座線は本来まっすぐ引けばよい。
// ただしレンズ歪みを入れて解いた場合は曲がるため、線は大円に沿って細かく分割して描く。

import { sph2vec, matT, matVec, DEG } from './astro.js';

/** 天球座標 → 画素。視野の裏側なら null */
export function project(sol, ra, dec) {
  const d = matVec(matT(sol.R), sph2vec(ra, dec));
  if (d[2] <= 0.02) return null;
  return sol.camera.camToPix(d);
}

function slerp(a, b, t) {
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const th = Math.acos(dot);
  if (th < 1e-6) return a;
  const s = Math.sin(th);
  const w1 = Math.sin((1 - t) * th) / s, w2 = Math.sin(t * th) / s;
  return [a[0] * w1 + b[0] * w2, a[1] * w1 + b[1] * w2, a[2] * w1 + b[2] * w2];
}

/** 大円に沿って分割した折れ線の画素座標列（視野外は null で切れる） */
function arcPoints(sol, p1, p2) {
  const v1 = sph2vec(p1[0], p1[1]), v2 = sph2vec(p2[0], p2[1]);
  const dot = Math.max(-1, Math.min(1, v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]));
  const sep = Math.acos(dot) / DEG;
  const n = Math.max(2, Math.min(48, Math.ceil(sep / 1.5)));
  const Rt = matT(sol.R);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const v = slerp(v1, v2, i / n);
    const d = matVec(Rt, v);
    pts.push(d[2] <= 0.02 ? null : sol.camera.camToPix(d));
  }
  return pts;
}

/** 画面内（余白込み）に入っているか */
function inside(p, w, h, margin) {
  return p && p[0] >= -margin && p[1] >= -margin && p[0] <= w + margin && p[1] <= h + margin;
}

/**
 * 写真に写っている星座を調べる。
 * @returns {Array<{id,ja,la,pts:number,label:[x,y]|null}>}
 */
export function visibleConstellations(sol, LINES, INFO, w, h) {
  const out = [];
  for (const id of Object.keys(LINES)) {
    let inCount = 0, total = 0;
    let sx = 0, sy = 0, sn = 0;
    for (const seg of LINES[id]) {
      for (const [ra, dec] of seg) {
        total++;
        const p = project(sol, ra, dec);
        if (inside(p, w, h, 0)) {
          inCount++;
          sx += p[0]; sy += p[1]; sn++;
        }
      }
    }
    if (inCount === 0) continue;
    out.push({
      id,
      ja: (INFO[id] && INFO[id].ja) || id,
      la: (INFO[id] && INFO[id].la) || id,
      pts: inCount,
      total,
      frac: inCount / total,
      label: sn ? [sx / sn, sy / sn] : null,
    });
  }
  out.sort((a, b) => b.pts - a.pts);
  return out;
}

/**
 * 文字の重なりを避けながら描く。
 * すでに置いた文字の矩形と重なる場合は描かずに false を返す。
 */
function placeText(ctx, boxes, s, x, y, align, fontPx) {
  const w = ctx.measureText(s).width;
  const h = fontPx || 20;
  const x0 = align === 'center' ? x - w / 2 : x;
  const box = [x0 - 3, y - h * 0.62, x0 + w + 3, y + h * 0.62];
  for (const b of boxes) {
    if (box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]) return false;
  }
  boxes.push(box);
  ctx.lineWidth = Math.max(2, ctx.__scale * 3);
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(s, x, y);
  ctx.fillText(s, x, y);
  return true;
}

/**
 * 検出した点を描く。星表と一致したものと、しなかったものを描き分ける。
 * 「アプリが何を星として見たか」が見えると、うまくいかないときの切り分けができる。
 */
export function drawDetections(ctx, dets, matchedDetIndices) {
  const scale = Math.hypot(ctx.canvas.width, ctx.canvas.height) / 1600;
  const matched = matchedDetIndices || new Set();
  ctx.lineWidth = Math.max(1, scale * 1.6);
  for (let i = 0; i < dets.length; i++) {
    const d = dets[i];
    const hit = matched.has(i);
    const r = Math.max(5, scale * 9);
    ctx.strokeStyle = hit ? 'rgba(120,255,170,0.9)' : 'rgba(255,120,120,0.85)';
    ctx.beginPath();
    if (hit) {
      ctx.arc(d.x, d.y, r, 0, Math.PI * 2);
    } else {
      ctx.moveTo(d.x - r, d.y - r); ctx.lineTo(d.x + r, d.y + r);
      ctx.moveTo(d.x + r, d.y - r); ctx.lineTo(d.x - r, d.y + r);
    }
    ctx.stroke();
  }
}

/**
 * 重ね描き。
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} sol 解
 * @param {object} data {LINES, INFO, NAMES, STARS}
 * @param {object} opt 表示の切り替え
 */
export function drawOverlay(ctx, sol, data, opt = {}) {
  const w = ctx.canvas.width, h = ctx.canvas.height;
  const scale = Math.hypot(w, h) / 1600;
  ctx.__scale = scale;
  ctx.clearRect(0, 0, w, h);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const cons = opt.constellations || visibleConstellations(sol, data.LINES, data.INFO, w, h);
  const only = opt.only || null;
  const boxes = []; // 文字の重なりを避けるための占有領域

  if (opt.lines !== false) {
    for (const c of cons) {
      if (only && c.id !== only) continue;
      const dim = only && c.id !== only;
      ctx.strokeStyle = dim ? 'rgba(120,180,220,0.25)' : (opt.lineColor || 'rgba(130,210,255,0.9)');
      ctx.lineWidth = Math.max(1.2, scale * 2.2);
      ctx.shadowColor = 'rgba(40,140,220,0.9)';
      ctx.shadowBlur = scale * 6;
      for (const seg of data.LINES[c.id]) {
        for (let i = 0; i + 1 < seg.length; i++) {
          const pts = arcPoints(sol, seg[i], seg[i + 1]);
          let started = false;
          ctx.beginPath();
          let any = false;
          for (const p of pts) {
            if (!p) { started = false; continue; }
            if (!started) { ctx.moveTo(p[0], p[1]); started = true; }
            else { ctx.lineTo(p[0], p[1]); any = true; }
            if (inside(p, w, h, w * 0.5)) any = any || true;
          }
          if (any) ctx.stroke();
        }
      }
      ctx.shadowBlur = 0;
    }
  }

  // 星表の星の位置に印をつける
  if (opt.stars) {
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = Math.max(1, scale * 1.2);
    for (const [ra, dec, mag] of data.STARS) {
      if (mag > (opt.starMag ?? 4.5)) continue;
      const p = project(sol, ra, dec);
      if (!inside(p, w, h, 0)) continue;
      const r = Math.max(3, (6 - mag) * 2.2 * scale);
      ctx.beginPath();
      ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  if (opt.names !== false) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const fs = Math.round(26 * scale);
    ctx.font = `600 ${fs}px system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    for (const c of cons) {
      if (only && c.id !== only) continue;
      if (!c.label) continue;
      if (c.pts < (opt.minPts ?? 2)) continue;
      const lx = Math.max(w * 0.06, Math.min(w * 0.94, c.label[0]));
      const ly = Math.max(h * 0.04, Math.min(h * 0.96, c.label[1]));
      placeText(ctx, boxes, c.ja, lx, ly, 'center', fs);
    }
  }

  if (opt.dets && opt.dets.length) {
    drawDetections(ctx, opt.dets, opt.matchedDets);
  }

  if (opt.starNames !== false) {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const fs2 = Math.round(19 * scale);
    ctx.font = `500 ${fs2}px system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif`;
    ctx.fillStyle = 'rgba(255,236,170,0.95)';
    const seen = [];
    for (const [ra, dec, mag, hip] of data.STARS) {
      const name = data.NAMES[hip];
      if (!name || mag > (opt.nameMag ?? 3.0)) continue;
      const p = project(sol, ra, dec);
      if (!inside(p, w, h, -10)) continue;
      // 近すぎるラベルは間引く
      if (seen.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 70 * scale)) continue;
      const r = Math.max(4, (5.5 - mag) * 2.4 * scale);
      if (!placeText(ctx, boxes, name, p[0] + r + 6 * scale, p[1], 'left', fs2)) continue;
      seen.push(p);
      ctx.beginPath();
      ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,236,170,0.85)';
      ctx.lineWidth = Math.max(1, scale * 1.4);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,236,170,0.95)';
    }
  }
}
