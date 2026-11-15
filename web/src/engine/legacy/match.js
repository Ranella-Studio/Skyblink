// Making frames from different surveys comparable: PSF matching, flux scaling, display stretch.
// Pure functions on frames ({ data: Float32Array(n*n), ... }); no DOM, run in Node and the browser.
import { median, mad, clippedStats, finiteSorted } from './stats.js';

const FWHM_PER_SIGMA = 2 * Math.sqrt(2 * Math.log(2));

/** Typical native resolutions, arcsec. AllWISE Atlas images are PSF-smoothed, so measure before trusting. */
export const FWHM = { '2mass': 2.8, W1: 6.1, W2: 6.4, spherex: 6.5 };

function blur1d(src, dst, n, kernel, r, horizontal) {
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      let s = 0;
      for (let k = -r; k <= r; k++) {
        const t = b + k;
        if (t < 0 || t >= n) continue;
        s += kernel[k + r] * (horizontal ? src[a * n + t] : src[t * n + a]);
      }
      if (horizontal) dst[a * n + b] = s;
      else dst[b * n + a] = s;
    }
  }
}

/**
 * Gaussian blur taking a frame from fromFwhm to toFwhm (arcsec, added in quadrature).
 * scale = arcsec per grid pixel. NaN pixels are left out of the average and stay NaN.
 */
export function blurToFwhm(frame, fromFwhmArcsec, toFwhmArcsec, scale = 3.0) {
  if (toFwhmArcsec <= fromFwhmArcsec) return frame;
  const sigma = Math.sqrt(toFwhmArcsec ** 2 - fromFwhmArcsec ** 2) / FWHM_PER_SIGMA / scale;
  const n = Math.round(Math.sqrt(frame.data.length));
  const r = Math.max(1, Math.ceil(4 * sigma));
  const kernel = Float64Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
  const ksum = kernel.reduce((s, v) => s + v, 0);
  for (let i = 0; i < kernel.length; i++) kernel[i] /= ksum;

  const val = new Float64Array(n * n);
  const wt = new Float64Array(n * n);
  for (let i = 0; i < n * n; i++) {
    const ok = Number.isFinite(frame.data[i]);
    val[i] = ok ? frame.data[i] : 0;
    wt[i] = ok ? 1 : 0;
  }
  const tmp = new Float64Array(n * n);
  const v2 = new Float64Array(n * n);
  const w2 = new Float64Array(n * n);
  blur1d(val, tmp, n, kernel, r, true);
  blur1d(tmp, v2, n, kernel, r, false);
  blur1d(wt, tmp, n, kernel, r, true);
  blur1d(tmp, w2, n, kernel, r, false);
  // Normalised convolution: dividing by the blurred weight keeps edges and holes from darkening.
  const data = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) data[i] = wt[i] ? v2[i] / w2[i] : NaN;
  // A source near the edge loses the flux that would have spread off the grid; fine for display.
  return { ...frame, data, note: `${frame.note} Blurred from ${fromFwhmArcsec} to ${toFwhmArcsec} arcsec FWHM.`.trim() };
}

/**
 * Robust s such that a ~ s * b, from pixels at least `k` sigma above the sky in both frames
 * (median of the per-pixel ratios, so a source present in only one frame does not pull it).
 */
export function fluxScale(a, b, { k = 5 } = {}) {
  const sa = clippedStats(a.data);
  const sb = clippedStats(b.data);
  const ratios = [];
  for (let i = 0; i < a.data.length; i++) {
    const x = a.data[i] - sa.median;
    const y = b.data[i] - sb.median;
    if (x > k * sa.sigma && y > k * sb.sigma) ratios.push(x / y);
  }
  return ratios.length ? median(ratios) : NaN;
}

/** a - s*b with s = fluxScale(a, b); what changed between the epochs. */
export function difference(a, b) {
  const s = fluxScale(a, b);
  const data = new Float32Array(a.data.length);
  for (let i = 0; i < data.length; i++) data[i] = a.data[i] - s * b.data[i];
  return { ...a, data, label: `${a.label} minus ${b.label}`, fluxScale: s, note: `${a.label} minus ${s.toPrecision(4)} x ${b.label}.` };
}

/** Zero median, unit MAD (raw MAD, not scaled to sigma). */
export function normalise(frame) {
  const m = median(frame.data);
  const d = mad(frame.data, m) || 1;
  return { ...frame, data: frame.data.map((v) => (v - m) / d), unit: 'MAD' };
}

/**
 * asinh stretch to 8-bit grey: 0 at or below zero, 255 at `max`, linear below `soft`, logarithmic above.
 * max defaults to the 99.5th percentile of the frame. NaN -> 0.
 */
export function toBytes(frame, { soft = 1, max } = {}) {
  if (max === undefined) {
    const s = finiteSorted(frame.data);
    max = s.length ? s[Math.min(s.length - 1, Math.floor(0.995 * s.length))] : 1;
  }
  const top = Math.asinh(max / soft) || 1;
  const out = new Uint8ClampedArray(frame.data.length);
  for (let i = 0; i < out.length; i++) {
    const v = frame.data[i];
    out[i] = v > 0 ? Math.round((255 * Math.asinh(v / soft)) / top) : 0;
  }
  return out;
}
