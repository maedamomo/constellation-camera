// 写真から点光源（星の候補）を検出する。
//
// 手順:
//   1. 輝度化
//   2. タイルごとに「背景の明るさ」と「ノイズの大きさ」を推定する
//      （街明かりのかぶりも周辺減光も、場所によって変わるため）
//   3. 背景を引き、星のにじみと同じ幅のガウシアンをかける（整合フィルタ）
//      — 1 画素だけのノイズの尖りを潰し、星のような広がりだけを残す
//   4. 局所ノイズの定数倍でしきい値処理し、連結成分の重心と光量を出す
//
// 木・建物・車のライトなどは点光源として拾ってしまうが、
// 後段の照合（solve.js）が外れ値として無視する。

/** ImageData 互換のオブジェクト（{data,width,height}）を輝度配列に変換 */
export function toGray(img) {
  const { data } = img;
  const g = new Float32Array(img.width * img.height);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    g[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }
  return g;
}

/**
 * タイルごとに背景（中央値）とノイズ（中央値と16%点の差 ≒ 1σ）を推定する。
 * 星は画素数としては少数なので、低い方の分位点なら星に引っ張られない。
 */
function tileStats(gray, width, height, tile) {
  const nx = Math.max(2, Math.ceil(width / tile));
  const ny = Math.max(2, Math.ceil(height / tile));
  const bg = new Float32Array(nx * ny);
  const sg = new Float32Array(nx * ny);
  const buf = new Float32Array(1024);
  for (let ty = 0; ty < ny; ty++) {
    for (let tx = 0; tx < nx; tx++) {
      const x0 = Math.floor((tx * width) / nx), x1 = Math.floor(((tx + 1) * width) / nx);
      const y0 = Math.floor((ty * height) / ny), y1 = Math.floor(((ty + 1) * height) / ny);
      let n = 0;
      const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 900)));
      for (let y = y0; y < y1 && n < buf.length; y += step)
        for (let x = x0; x < x1 && n < buf.length; x += step) buf[n++] = gray[y * width + x];
      const a = buf.slice(0, n).sort();
      const med = a[Math.floor(n * 0.5)] ?? 0;
      const p16 = a[Math.floor(n * 0.16)] ?? med;
      bg[ty * nx + tx] = med;
      sg[ty * nx + tx] = Math.max(0.5, med - p16);
    }
  }
  return { bg, sg, nx, ny };
}

function bilinear(map, nx, ny, width, height, x, y) {
  const fx = (x / width) * nx - 0.5, fy = (y / height) * ny - 0.5;
  const ix = Math.max(0, Math.min(nx - 2, Math.floor(fx)));
  const iy = Math.max(0, Math.min(ny - 2, Math.floor(fy)));
  const ax = Math.max(0, Math.min(1, fx - ix)), ay = Math.max(0, Math.min(1, fy - iy));
  const v00 = map[iy * nx + ix], v10 = map[iy * nx + ix + 1];
  const v01 = map[(iy + 1) * nx + ix], v11 = map[(iy + 1) * nx + ix + 1];
  return (v00 * (1 - ax) + v10 * ax) * (1 - ay) + (v01 * (1 - ax) + v11 * ax) * ay;
}

/** 分離型ガウシアン。kf は「ノイズがこの倍率まで下がる」係数 */
function gaussianBlur(src, width, height, sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
    sum += k[i + r];
  }
  let sq = 0;
  for (let i = 0; i < k.length; i++) { k[i] /= sum; sq += k[i] * k[i]; }
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) {
        let xx = x + i;
        if (xx < 0) xx = 0; else if (xx >= width) xx = width - 1;
        s += src[row + xx] * k[i + r];
      }
      tmp[row + x] = s;
    }
  }
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let s = 0;
      for (let i = -r; i <= r; i++) {
        let yy = y + i;
        if (yy < 0) yy = 0; else if (yy >= height) yy = height - 1;
        s += tmp[yy * width + x] * k[i + r];
      }
      out[y * width + x] = s;
    }
  }
  return { out, kf: sq }; // 2 次元なので σ_out = σ_in * sqrt(sq)·sqrt(sq) = σ_in * sq
}


/**
 * なだらかな明るさのムラだけを引く。
 * 8x8 画素ごとの中央値（星は画素数が少ないので中央値には効かない）で縮小画像を作り、
 * そこでぼかしてから元の大きさに戻して引く。
 */
function subtractBroad(sub, width, height, sigma) {
  const B = 8;
  const sw = Math.max(2, Math.ceil(width / B)), sh = Math.max(2, Math.ceil(height / B));
  const small = new Float32Array(sw * sh);
  const buf = new Float32Array(B * B);
  for (let by = 0; by < sh; by++) {
    for (let bx = 0; bx < sw; bx++) {
      let n = 0;
      for (let y = by * B; y < Math.min(height, (by + 1) * B); y++)
        for (let x = bx * B; x < Math.min(width, (bx + 1) * B); x++) buf[n++] = sub[y * width + x];
      const a = buf.slice(0, n).sort();
      small[by * sw + bx] = a[Math.floor(n * 0.5)] || 0;
    }
  }
  const { out: blurred } = gaussianBlur(small, sw, sh, Math.max(1, sigma / B));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      sub[y * width + x] -= bilinear(blurred, sw, sh, width, height, x, y);
    }
  }
}

/** しきい値を超える連結成分を拾って、重心・光量・伸び具合を出す */
function extractComponents(sm, sub, noise, width, height, kSigma, kf, opt) {
  const seen = new Uint8Array(width * height);
  const stack = new Int32Array(Math.min(width * height, 1 << 21));
  const stars = [];
  for (let y0 = 0; y0 < height; y0++) {
    for (let x0 = 0; x0 < width; x0++) {
      const i0 = y0 * width + x0;
      if (seen[i0]) continue;
      if (sm[i0] < kSigma * noise[i0] * kf) continue;
      let sp = 0;
      stack[sp++] = i0;
      seen[i0] = 1;
      let area = 0, flux = 0, wsum = 0, sx = 0, sy = 0, peak = 0, nCore = 0, rawPeak = 0;
      let sxx = 0, syy = 0, sxy = 0, touches = false;
      while (sp > 0) {
        const i = stack[--sp];
        const x = i % width, y = (i / width) | 0;
        const v = Math.max(0, sm[i]);
        area++;
        flux += Math.max(0, sub[i]);
        wsum += v;
        sx += x * v; sy += y * v;
        sxx += x * x * v; syy += y * y * v; sxy += x * y * v;
        if (v > peak) peak = v;
        if (sub[i] > rawPeak) rawPeak = sub[i];
        if (v >= kSigma * noise[i] * kf) nCore++;
        if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touches = true;
        if (area > opt.maxArea * 4) break;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= width) continue;
            const j = ny * width + nx;
            if (seen[j]) continue;
            if (sm[j] < kSigma * noise[j] * kf * 0.5) continue;
            seen[j] = 1;
            if (sp < stack.length) stack[sp++] = j;
          }
        }
      }
      // しきい値をきちんと超えた画素が 2 個以上ないものはノイズの尖りとみなす
      if (nCore < 2 || area < opt.minArea || area > opt.maxArea || wsum <= 0 || flux <= 0) continue;
      const cx = sx / wsum, cy = sy / wsum;
      const vxx = Math.max(0.01, sxx / wsum - cx * cx);
      const vyy = Math.max(0.01, syy / wsum - cy * cy);
      const vxy = sxy / wsum - cx * cy;
      const tr = vxx + vyy, det = vxx * vyy - vxy * vxy;
      const disc = Math.max(0, (tr * tr) / 4 - det);
      const l1 = tr / 2 + Math.sqrt(disc), l2 = Math.max(1e-6, tr / 2 - Math.sqrt(disc));
      const elong = Math.sqrt(l1 / l2);
      if (elong > opt.maxElong) continue;
      stars.push({
        x: cx, y: cy, flux, area, peak, elong, touches, nCore,
        width: Math.sqrt((vxx + vyy) / 2),
        sat: rawPeak > 200,
      });
    }
  }

  // ホットピクセル（1 画素だけの輝点）は星のにじみより鋭く、
  // 雲の切れ間や街明かりの塊は星より大きく写る。
  // 検出したもの全体の幅の中央値を基準に、両側を落とす。
  let kept = stars;
  if (stars.length >= 8) {
    const ws = stars.map((s) => s.width).sort((a, b) => a - b);
    const med = ws[ws.length >> 1];
    kept = stars.filter((s) => s.width >= med * 0.72 && s.width <= Math.max(6, med * 3));
  }

  kept.sort((a, b) => b.flux - a.flux);
  const out = kept.slice(0, opt.maxStars);
  for (const s of out) s.imag = -2.5 * Math.log10(s.flux);
  return out;
}

/**
 * 星の候補を検出する。
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} img
 * @param {object} opt
 * @returns {{stars:Array, noiseMedian:number, nAll:number}}
 */
export function detectStars(img, opt = {}) {
  const width = img.width, height = img.height;
  const kSigma = opt.kSigma ?? 4.2;
  const psf = opt.psf ?? 1.1;
  const gray = opt.gray || toGray(img);

  const tile = Math.max(24, Math.round(Math.min(width, height) / 12));
  const st = tileStats(gray, width, height, tile);

  const sub = new Float32Array(width * height);
  const noise = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      sub[i] = gray[i] - bilinear(st.bg, st.nx, st.ny, width, height, x, y);
      noise[i] = bilinear(st.sg, st.nx, st.ny, width, height, x, y);
    }
  }

  // タイル背景を引いてもなお残る、なだらかなムラ（街明かりのにじみや薄雲）を落とす。
  // 星より十分大きい幅でぼかしたものを引くと、点光源はほとんど減らずにムラだけ消える。
  // ムラは細かい形を持たないので、8 分の 1 に縮めてから計算する（そのぶん速い）。
  subtractBroad(sub, width, height, Math.max(8, Math.round(Math.min(width, height) / 90)));

  const { out: sm, kf } = gaussianBlur(sub, width, height, psf);

  const stars = extractComponents(sm, sub, noise, width, height, kSigma, kf, {
    maxStars: opt.maxStars ?? 150,
    minArea: opt.minArea ?? 3,
    maxArea: opt.maxArea ?? Math.max(150, Math.round(width * height * 0.0004)),
    maxElong: opt.maxElong ?? 3.5,
  });

  const sorted = Array.from(st.sg).sort((a, b) => a - b);
  return { stars, noiseMedian: sorted[sorted.length >> 1] || 0, nAll: stars.length };
}
