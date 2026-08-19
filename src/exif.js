// JPEG の EXIF から、判定に使える手がかりだけを取り出す。
//   ・35mm 換算焦点距離 → 画角が分かるので、照合の探索範囲を一気に絞れる
//   ・撮影日時と GPS   → 写っている方角（方位・高度）を言える
// 取れなくても動作するので、失敗は握りつぶして null を返す。

function rational(view, off, le) {
  const a = view.getUint32(off, le), b = view.getUint32(off + 4, le);
  return b === 0 ? 0 : a / b;
}

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

function readIFD(view, tiff, ifd, le, want) {
  const out = {};
  const n = view.getUint16(tiff + ifd, le);
  for (let i = 0; i < n; i++) {
    const e = tiff + ifd + 2 + i * 12;
    const tag = view.getUint16(e, le);
    if (want && !want.has(tag)) continue;
    const type = view.getUint16(e + 2, le);
    const count = view.getUint32(e + 4, le);
    const size = (TYPE_SIZE[type] || 1) * count;
    let off = e + 8;
    if (size > 4) off = tiff + view.getUint32(e + 8, le);
    if (off < 0 || off + size > view.byteLength) continue;
    let v;
    if (type === 2) {
      let s = '';
      for (let k = 0; k < count; k++) {
        const c = view.getUint8(off + k);
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      v = s;
    } else if (type === 3) {
      v = count === 1 ? view.getUint16(off, le)
        : Array.from({ length: count }, (_, k) => view.getUint16(off + k * 2, le));
    } else if (type === 4) {
      v = count === 1 ? view.getUint32(off, le)
        : Array.from({ length: count }, (_, k) => view.getUint32(off + k * 4, le));
    } else if (type === 5 || type === 10) {
      v = count === 1 ? rational(view, off, le)
        : Array.from({ length: count }, (_, k) => rational(view, off + k * 8, le));
    } else {
      v = null;
    }
    out[tag] = v;
  }
  return out;
}

/** EXIF の日時文字列 "YYYY:MM:DD HH:MM:SS" を Date に（タイムゾーン指定があれば反映） */
function parseExifDate(s, offset) {
  if (!s) return null;
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  const [, Y, M, D, h, mi, sec] = m.map(Number);
  const tz = offset && /^([+-])(\d{2}):(\d{2})/.exec(offset);
  if (tz) {
    const sign = tz[1] === '-' ? -1 : 1;
    const mins = sign * (Number(tz[2]) * 60 + Number(tz[3]));
    return new Date(Date.UTC(Y, M - 1, D, h, mi, sec) - mins * 60000);
  }
  // タイムゾーン不明なら端末のローカル時刻として解釈する
  return new Date(Y, M - 1, D, h, mi, sec);
}

/**
 * @param {ArrayBuffer} buf
 * @returns {object|null}
 */
export function readExif(buf) {
  try {
    const view = new DataView(buf);
    if (view.getUint16(0) !== 0xffd8) return null; // JPEG でない
    let p = 2, tiff = -1;
    while (p + 4 < view.byteLength) {
      if (view.getUint8(p) !== 0xff) break;
      const marker = view.getUint8(p + 1);
      const len = view.getUint16(p + 2);
      if (marker === 0xe1 && view.getUint32(p + 4) === 0x45786966) { tiff = p + 10; break; }
      if (marker === 0xda) break; // 画像データに入った
      p += 2 + len;
    }
    if (tiff < 0) return null;
    const le = view.getUint16(tiff) === 0x4949;
    if (view.getUint16(tiff + 2, le) !== 42) return null;
    const ifd0 = view.getUint32(tiff + 4, le);

    const main = readIFD(view, tiff, ifd0, le,
      new Set([0x0112, 0x010f, 0x0110, 0x8769, 0x8825]));
    const out = {
      orientation: main[0x0112] ?? 1,
      make: main[0x010f] ?? null,
      model: main[0x0110] ?? null,
    };
    if (main[0x8769]) {
      const ex = readIFD(view, tiff, main[0x8769], le,
        new Set([0x920a, 0xa405, 0x9003, 0x9011, 0xa002, 0xa003]));
      out.focal = ex[0x920a] ?? null;
      out.focal35 = ex[0xa405] ?? null;
      out.dateTime = parseExifDate(ex[0x9003], ex[0x9011]);
      out.dateTimeRaw = ex[0x9003] ?? null;
      out.tzOffset = ex[0x9011] ?? null;
    }
    if (main[0x8825]) {
      const gp = readIFD(view, tiff, main[0x8825], le,
        new Set([1, 2, 3, 4, 5, 6, 0x0010, 0x0011]));
      const dms = (a) => (Array.isArray(a) ? a[0] + a[1] / 60 + a[2] / 3600 : null);
      const lat = dms(gp[2]), lon = dms(gp[4]);
      if (lat !== null && lon !== null) {
        out.lat = gp[1] === 'S' ? -lat : lat;
        out.lon = gp[3] === 'W' ? -lon : lon;
      }
      if (gp[0x0011] != null) {
        out.imgDirection = gp[0x0011];
        out.imgDirectionRef = gp[0x0010] ?? null;
      }
    }
    return out;
  } catch {
    return null;
  }
}

/** 35mm 換算焦点距離（mm）から対角画角（度）へ。35mm 判の対角は 43.267mm */
export function fovFromFocal35(f35) {
  if (!f35 || f35 <= 0) return null;
  return (2 * Math.atan(43.267 / (2 * f35)) * 180) / Math.PI;
}
