// Grid images -> greyscale bytes. Each frame is stretched on its own median
// and MAD, so frames from different telescopes and units look alike.

/** Robust level and spread of the finite pixels: { med, mad } (mad scaled to sigma). */
export function robust(data, step = Math.max(1, Math.floor(data.length / 40000))) {
  const v = [];
  for (let i = 0; i < data.length; i += step) if (Number.isFinite(data[i])) v.push(data[i]);
  if (!v.length) return { med: NaN, mad: NaN };
  const s = Float64Array.from(v).sort();
  const med = s[s.length >> 1];
  const d = s.map((x) => Math.abs(x - med)).sort();
  return { med, mad: 1.4826 * d[d.length >> 1] || 1e-12, hi: s[Math.min(s.length - 1, Math.floor(s.length * 0.998))] };
}

/**
 * asinh stretch: black at med - 1.5 sigma, soft knee at `soft` sigma, white at
 * the 99.8th percentile. Returns bytes and a mask (0 where there is no data).
 */
export function stretch(data, { soft = 3, invert = false } = {}) {
  const { med, mad, hi } = robust(data);
  const lo = med - 1.5 * mad;
  const k = soft * mad;
  const top = Math.asinh(Math.max(hi - lo, 10 * mad) / k);
  const out = new Uint8ClampedArray(data.length);
  const mask = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const x = data[i];
    if (!Number.isFinite(x)) continue;
    mask[i] = 1;
    const y = (255 * Math.asinh(Math.max(0, x - lo) / k)) / top;
    out[i] = invert ? 255 - y : y;
  }
  return { bytes: out, mask };
}

/** A difference image on mid grey: white above zero, black below, asinh beyond 2 sigma. */
export function diverging(d, { invert = false } = {}) {
  const rd = robust(d);
  const out = new Uint8ClampedArray(d.length);
  const mask = new Uint8Array(d.length);
  const k = 2 * rd.mad;
  const top = Math.asinh(20);
  for (let i = 0; i < d.length; i++) {
    if (!Number.isFinite(d[i])) continue;
    mask[i] = 1;
    const y = 127.5 + (127.5 * Math.asinh((d[i] - rd.med) / k)) / top;
    out[i] = invert ? 255 - y : y;
  }
  return { bytes: out, mask };
}

/** Mean of normalised frames ((x - med) / mad), NaN where every frame is NaN. */
export function addFrames(frames) {
  const len = frames[0].length;
  const sum = new Float32Array(len);
  const cnt = new Uint16Array(len);
  for (const f of frames) {
    const { med, mad } = robust(f);
    for (let i = 0; i < len; i++) {
      if (!Number.isFinite(f[i])) continue;
      sum[i] += (f[i] - med) / mad;
      cnt[i]++;
    }
  }
  for (let i = 0; i < len; i++) sum[i] = cnt[i] ? sum[i] / cnt[i] : NaN;
  return sum;
}

// Heat: false colour for brightness only. Black, red, yellow, white, with stops
// spaced so lightness rises steadily (close to matplotlib's "inferno" endpoints).
const HEAT_STOPS = [[0, 0, 0, 0], [0.3, 120, 16, 12], [0.55, 215, 60, 8], [0.8, 250, 190, 40], [1, 255, 255, 255]];
export const HEAT = (() => {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const k = HEAT_STOPS.findIndex((s) => s[0] >= t);
    const [a, b] = [HEAT_STOPS[Math.max(0, k - 1)], HEAT_STOPS[k]];
    const f = b[0] === a[0] ? 0 : (t - a[0]) / (b[0] - a[0]);
    for (let c = 1; c < 4; c++) lut[i * 3 + c - 1] = a[c] + f * (b[c] - a[c]);
  }
  return lut;
})();

/** Bytes + mask -> ImageData-ready RGBA (grey, or the heat ramp). No-data pixels are a dim blue-grey, distinct from black sky. */
export function toRgba({ bytes, mask }, heat = false) {
  const rgba = new Uint8ClampedArray(bytes.length * 4);
  for (let i = 0; i < bytes.length; i++) {
    const j = i * 4;
    if (mask[i] && heat) {
      const v = bytes[i] * 3;
      rgba[j] = HEAT[v];
      rgba[j + 1] = HEAT[v + 1];
      rgba[j + 2] = HEAT[v + 2];
    } else if (mask[i]) rgba[j] = rgba[j + 1] = rgba[j + 2] = bytes[i];
    else {
      rgba[j] = 34;
      rgba[j + 1] = 37;
      rgba[j + 2] = 48;
    }
    rgba[j + 3] = 255;
  }
  return rgba;
}
