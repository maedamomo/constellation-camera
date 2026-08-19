// 天球座標とカメラ投影の基礎計算。
//
// 座標系:
//   赤道座標（J2000）の単位ベクトル v = [cos(dec)cos(ra), cos(dec)sin(ra), sin(dec)]
//   カメラ座標は +z が光軸方向、+x が画像の右、+y が画像の上。
//   回転行列 R はカメラ座標 → 赤道座標の変換（列優先ではなく行優先の 9 要素配列）。
//
// 画素座標 (px, py) は左上原点。主点は画像中心とみなす。

export const DEG = Math.PI / 180;

export function sph2vec(raDeg, decDeg) {
  const ra = raDeg * DEG, dec = decDeg * DEG;
  const cd = Math.cos(dec);
  return [cd * Math.cos(ra), cd * Math.sin(ra), Math.sin(dec)];
}

export function vec2sph(v) {
  const ra = Math.atan2(v[1], v[0]) / DEG;
  const dec = Math.asin(Math.max(-1, Math.min(1, v[2]))) / DEG;
  return [(ra + 360) % 360, dec];
}

export function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function normalize(a) {
  const n = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
}

/** 行優先 3x3 と 3 ベクトルの積 */
export function matVec(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** 転置（= 回転行列の逆行列） */
export function matT(m) {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

export function matMul(a, b) {
  const o = new Array(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return o;
}

/** 回転ベクトル（軸×角度, ラジアン）→ 回転行列（ロドリゲスの公式） */
export function rotFromVec(r) {
  const th = Math.hypot(r[0], r[1], r[2]);
  if (th < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const [x, y, z] = [r[0] / th, r[1] / th, r[2] / th];
  const c = Math.cos(th), s = Math.sin(th), t = 1 - c;
  return [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  ];
}

/**
 * 2 組の対応（カメラ座標 d1,d2 ↔ 赤道座標 c1,c2）から回転行列を作る。
 * それぞれから正規直交の三脚を作り、その間の回転を求める。
 */
export function rotFromTwoPairs(d1, d2, c1, c2) {
  const a1 = normalize(d1);
  const a2 = normalize(cross(d1, d2));
  const a3 = cross(a1, a2);
  const b1 = normalize(c1);
  const b2 = normalize(cross(c1, c2));
  const b3 = cross(b1, b2);
  // A の列が a1,a2,a3 / B の列が b1,b2,b3 のとき R = B Aᵀ
  const o = new Array(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      o[i * 3 + j] = b1[i] * a1[j] + b2[i] * a2[j] + b3[i] * a3[j];
  return o;
}

/**
 * カメラモデル。
 *   f  : 焦点距離（画素）
 *   cx,cy: 主点（画像中心）
 *   k1 : 樽型／糸巻き歪みの 1 次係数（0 で歪みなし）
 */
export class Camera {
  constructor(width, height, f, k1 = 0) {
    this.width = width;
    this.height = height;
    this.cx = width / 2;
    this.cy = height / 2;
    this.f = f;
    this.k1 = k1;
  }

  /** 画素 → カメラ座標の単位ベクトル（歪み補正を含む） */
  pixToCam(px, py) {
    let x = (px - this.cx) / this.f;
    let y = -(py - this.cy) / this.f;
    if (this.k1) {
      // 観測画素は歪んだ像。理想座標を反復で求める。
      let ux = x, uy = y;
      for (let i = 0; i < 6; i++) {
        const r2 = ux * ux + uy * uy;
        const s = 1 + this.k1 * r2;
        ux = x / s;
        uy = y / s;
      }
      x = ux; y = uy;
    }
    return normalize([x, y, 1]);
  }

  /** カメラ座標 → 画素。光軸の裏側なら null */
  camToPix(d) {
    if (d[2] <= 1e-9) return null;
    let x = d[0] / d[2], y = d[1] / d[2];
    if (this.k1) {
      const s = 1 + this.k1 * (x * x + y * y);
      x *= s; y *= s;
    }
    return [this.cx + x * this.f, this.cy - y * this.f];
  }

  /** 対角画角（度） */
  fovDiag() {
    const r = Math.hypot(this.width, this.height) / 2;
    return (2 * Math.atan(r / this.f)) / DEG;
  }
}

/** 対角画角（度）から焦点距離（画素）へ */
export function fFromFovDiag(width, height, fovDeg) {
  const r = Math.hypot(width, height) / 2;
  return r / Math.tan((fovDeg * DEG) / 2);
}

/**
 * 画像中心からの 2 点 (u1,v1),(u2,v2)（中心を原点、y は上向き）について、
 * その 2 点が天球上で角距離 sigma だけ離れて見えるような焦点距離 f を求める。
 * 見つからなければ null。
 *
 * cosθ(f) = (u1u2+v1v2+f²) / (√(r1²+f²)·√(r2²+f²)) = cos σ
 * の両辺を二乗すると t = f² の二次方程式になるので直接解ける。
 * （θ(f) は単調減少なので、正しい根は高々ひとつ）
 */
export function solveFocalFromPair(u1, v1, u2, v2, cosSigma, fMin, fMax) {
  const p = u1 * u2 + v1 * v2;
  const r1s = u1 * u1 + v1 * v1;
  const r2s = u2 * u2 + v2 * v2;
  const c2 = cosSigma * cosSigma;
  const A = 1 - c2;
  const B = 2 * p - c2 * (r1s + r2s);
  const C = p * p - c2 * r1s * r2s;
  let t;
  if (Math.abs(A) < 1e-12) {
    if (Math.abs(B) < 1e-12) return null;
    t = -C / B;
    if (!(t > 0)) return null;
  } else {
    const disc = B * B - 4 * A * C;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    const t1 = (-B + sq) / (2 * A), t2 = (-B - sq) / (2 * A);
    // 二乗して増えた偽の根を、元の式を満たすかで捨てる
    t = -1;
    for (const cand of [t1, t2]) {
      if (!(cand > 0)) continue;
      const v = (p + cand) / Math.sqrt((r1s + cand) * (r2s + cand));
      if (Math.abs(v - cosSigma) < 1e-9) { t = cand; break; }
    }
    if (t < 0) return null;
  }
  const f = Math.sqrt(t);
  if (f < fMin || f > fMax) return null;
  return f;
}

/** 2 つの単位ベクトルのなす角（ラジアン）。数値的に安定な式を使う。 */
export function angleBetween(a, b) {
  const d = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const s = [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  return 2 * Math.atan2(Math.hypot(d[0], d[1], d[2]), Math.hypot(s[0], s[1], s[2]));
}

/**
 * 天球上の点を高速に近傍検索するための索引。
 *
 * 赤緯で帯に分け、帯ごとに赤経方向へ等分する。全体を 1 本の配列に詰めて
 * 整数演算だけで引けるようにしてある（照合では数百万回引くため、
 * ハッシュを使わないことが効いてくる）。
 */
export class SkyIndex {
  constructor(vectors, cellRad = 0.03) {
    const n = vectors.length;
    this.vectors = vectors;
    this.cell = cellRad;
    const nB = Math.max(2, Math.ceil(Math.PI / cellRad));
    this.nB = nB;
    this.dB = Math.PI / nB;
    this.nL = new Int32Array(nB);
    this.binOff = new Int32Array(nB + 1); // 帯の先頭ビン番号
    let total = 0;
    for (let k = 0; k < nB; k++) {
      const decMid = -Math.PI / 2 + (k + 0.5) * this.dB;
      const nl = Math.max(1, Math.floor((2 * Math.PI * Math.cos(decMid)) / cellRad));
      this.nL[k] = nl;
      this.binOff[k] = total;
      total += nl;
    }
    this.binOff[nB] = total;

    // 各点のビン番号を求め、計数ソートで詰める
    const bin = new Int32Array(n);
    const count = new Int32Array(total + 1);
    // 座標をあらかじめ展開しておく（照合ループでの配列アクセスを減らす）
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.z = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const v = vectors[i];
      this.x[i] = v[0]; this.y[i] = v[1]; this.z[i] = v[2];
      bin[i] = this._bin(v[0], v[1], v[2]);
      count[bin[i] + 1]++;
    }
    for (let b = 0; b < total; b++) count[b + 1] += count[b];
    this.start = count;
    this.items = new Int32Array(n);
    const cur = Int32Array.from(count.subarray(0, total));
    for (let i = 0; i < n; i++) this.items[cur[bin[i]]++] = i;
  }

  _band(z) {
    const dec = Math.asin(Math.max(-1, Math.min(1, z)));
    let k = Math.floor((dec + Math.PI / 2) / this.dB);
    return k < 0 ? 0 : k >= this.nB ? this.nB - 1 : k;
  }

  _bin(x, y, z) {
    const k = this._band(z);
    const nl = this.nL[k];
    let lon = Math.atan2(y, x);
    if (lon < 0) lon += 2 * Math.PI;
    let l = Math.floor((lon / (2 * Math.PI)) * nl);
    if (l < 0) l = 0; else if (l >= nl) l = nl - 1;
    return this.binOff[k] + l;
  }

  /**
   * v から maxRad 以内の点を順に cb(i) へ渡す。cb が true を返したら打ち切る。
   * 弦長で判定するので三角関数を使わない。
   */
  forEachNear(v, maxRad, cb) {
    const chord = 2 * Math.sin(Math.min(Math.PI / 2, maxRad / 2));
    const lim2 = chord * chord;
    const dec = Math.asin(Math.max(-1, Math.min(1, v[2])));
    let lon = Math.atan2(v[1], v[0]);
    if (lon < 0) lon += 2 * Math.PI;
    const kLo = Math.max(0, Math.floor((dec - maxRad + Math.PI / 2) / this.dB));
    const kHi = Math.min(this.nB - 1, Math.floor((dec + maxRad + Math.PI / 2) / this.dB));
    for (let k = kLo; k <= kHi; k++) {
      const nl = this.nL[k];
      // この帯で赤経方向に何ビン見ればよいか
      const decLo = -Math.PI / 2 + k * this.dB, decHi = decLo + this.dB;
      const cosMin = Math.min(Math.cos(decLo), Math.cos(decHi));
      let lFrom, lTo;
      if (cosMin < 1e-6 || maxRad / cosMin >= Math.PI) {
        lFrom = 0; lTo = nl - 1;
      } else {
        const dLon = maxRad / cosMin;
        lFrom = Math.floor(((lon - dLon) / (2 * Math.PI)) * nl);
        lTo = Math.floor(((lon + dLon) / (2 * Math.PI)) * nl);
        if (lTo - lFrom >= nl - 1) { lFrom = 0; lTo = nl - 1; }
      }
      for (let ll = lFrom; ll <= lTo; ll++) {
        let l = ll % nl;
        if (l < 0) l += nl;
        const b = this.binOff[k] + l;
        const s = this.start[b], e = this.start[b + 1];
        for (let t = s; t < e; t++) {
          const i = this.items[t];
          const ex = this.x[i] - v[0], ey = this.y[i] - v[1], ez = this.z[i] - v[2];
          const d2 = ex * ex + ey * ey + ez * ez;
          if (d2 <= lim2 && cb(i, d2)) return;
        }
      }
    }
  }

  /**
   * maxRad 以内に点があるか（最初の 1 個で打ち切る）。
   * 照合ループから毎秒数十万回呼ばれるため、
   * クロージャも配列も作らずスカラーだけで書いてある。
   */
  hasNear(vx, vy, vz, maxRad) {
    const chord = 2 * Math.sin(Math.min(Math.PI / 2, maxRad / 2));
    const lim2 = chord * chord;
    const dec = Math.asin(vz < -1 ? -1 : vz > 1 ? 1 : vz);
    let lon = Math.atan2(vy, vx);
    if (lon < 0) lon += 2 * Math.PI;
    const half = Math.PI / 2;
    let kLo = Math.floor((dec - maxRad + half) / this.dB);
    let kHi = Math.floor((dec + maxRad + half) / this.dB);
    if (kLo < 0) kLo = 0;
    if (kHi > this.nB - 1) kHi = this.nB - 1;
    const X = this.x, Y = this.y, Z = this.z, items = this.items, start = this.start;
    for (let k = kLo; k <= kHi; k++) {
      const nl = this.nL[k];
      const decLo = -half + k * this.dB, decHi = decLo + this.dB;
      const cLo = Math.cos(decLo), cHi = Math.cos(decHi);
      const cosMin = cLo < cHi ? cLo : cHi;
      let lFrom, lTo;
      if (cosMin < 1e-6 || maxRad / cosMin >= Math.PI) {
        lFrom = 0; lTo = nl - 1;
      } else {
        const dLon = maxRad / cosMin;
        lFrom = Math.floor(((lon - dLon) / (2 * Math.PI)) * nl);
        lTo = Math.floor(((lon + dLon) / (2 * Math.PI)) * nl);
        if (lTo - lFrom >= nl - 1) { lFrom = 0; lTo = nl - 1; }
      }
      const off = this.binOff[k];
      for (let ll = lFrom; ll <= lTo; ll++) {
        let l = ll % nl;
        if (l < 0) l += nl;
        const b = off + l;
        for (let t = start[b], e = start[b + 1]; t < e; t++) {
          const i = items[t];
          const ex = X[i] - vx, ey = Y[i] - vy, ez = Z[i] - vz;
          if (ex * ex + ey * ey + ez * ez <= lim2) return true;
        }
      }
    }
    return false;
  }

  has(v, maxRad) {
    return this.hasNear(v[0], v[1], v[2], maxRad);
  }

  /** v に最も近い点の [index, 角距離rad]。maxRad 以内に無ければ null */
  nearest(v, maxRad) {
    let best = -1, bestD = Infinity;
    this.forEachNear(v, maxRad, (i, d2) => {
      if (d2 < bestD) { bestD = d2; best = i; }
      return false;
    });
    if (best < 0) return null;
    return [best, 2 * Math.asin(Math.min(1, Math.sqrt(bestD) / 2))];
  }
}
