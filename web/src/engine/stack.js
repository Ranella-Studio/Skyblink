// Stack the frames of one pass into one band image, and simple image maths on
// the common grid. Frame images are Float32Array(n*n), NaN = no data.

import { loadFrame } from './cutout.js';
import { getBand, bandWeight, visitsForBand } from './bands.js';

const median = (sorted) => {
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
};

/** Sigma-clipped (3 sigma) median and MAD-based sigma of the finite values. */
export function skyStats(data, { clip = 3, iterations = 5 } = {}) {
  let vals = Float64Array.from(data.filter((v) => v === v)).sort();
  let med = NaN;
  let sigma = NaN;
  for (let it = 0; it < iterations && vals.length; it++) {
    med = median(vals);
    sigma = 1.4826 * median(vals.map((v) => Math.abs(v - med)).sort());
    const kept = vals.filter((v) => Math.abs(v - med) <= clip * sigma);
    if (kept.length === vals.length || !kept.length) break;
    vals = kept;
  }
  return { median: med, sigma, count: vals.length };
}

/**
 * Per-pixel weighted mean of frames (Float32Array each), ignoring NaN. With 5
 * or more values at a pixel, values over 4 sigma (MAD) from their median are
 * dropped first: cosmic rays and moving objects.
 * Returns { data, coverage (frames used per pixel), weight (summed weight), n (frames with weight > 0) }.
 */
export function stackFrames(frames, weights) {
  const use = frames.map((f, k) => k).filter((k) => weights[k] > 0);
  const len = frames[0]?.length ?? 0;
  const data = new Float32Array(len);
  const coverage = new Uint16Array(len);
  const weight = new Float32Array(len);
  const v = new Float64Array(use.length);
  const w = new Float64Array(use.length);
  for (let p = 0; p < len; p++) {
    let m = 0;
    for (const k of use) {
      const x = frames[k][p];
      if (x === x) {
        v[m] = x;
        w[m++] = weights[k];
      }
    }
    let lo = -Infinity;
    let hi = Infinity;
    if (m >= 5) {
      const s = v.slice(0, m).sort();
      const med = median(s);
      const sig = 1.4826 * median(s.map((x) => Math.abs(x - med)).sort());
      if (sig > 0) [lo, hi] = [med - 4 * sig, med + 4 * sig];
    }
    let sw = 0;
    let swx = 0;
    let c = 0;
    for (let j = 0; j < m; j++) {
      if (v[j] < lo || v[j] > hi) continue;
      sw += w[j];
      swx += w[j] * v[j];
      c++;
    }
    data[p] = sw > 0 ? swx / sw : NaN;
    coverage[p] = c;
    weight[p] = sw;
  }
  return { data, coverage, weight, n: use.length };
}

/** a - b pixel by pixel (NaN where either is missing). */
export function subtract(a, b) {
  const data = a.data.map((x, p) => x - b.data[p]);
  return { ...a, data, label: a.label && b.label ? `${a.label} - ${b.label}` : undefined };
}

/** Combine stacks into one (weighted by each stack's per-pixel weight, or equally if it has none). */
export function add(frames) {
  const len = frames[0].data.length;
  const data = new Float32Array(len);
  const weight = new Float32Array(len);
  const coverage = new Uint16Array(len);
  for (let p = 0; p < len; p++) {
    let sw = 0;
    let swx = 0;
    let c = 0;
    for (const f of frames) {
      const x = f.data[p];
      const w = f.weight ? f.weight[p] : 1;
      if (x === x && w > 0) {
        sw += w;
        swx += w * x;
        c += f.coverage ? f.coverage[p] : 1;
      }
    }
    data[p] = sw > 0 ? swx / sw : NaN;
    weight[p] = sw;
    coverage[p] = c;
  }
  const mjds = frames.flatMap((f) => f.mjdRange ?? []);
  return {
    source: 'spherex',
    band: frames[0].band,
    label: frames.map((f) => f.label).filter(Boolean).join(' + '),
    mjd: frames.reduce((s, f) => s + (f.mjd ?? 0), 0) / frames.length,
    mjdRange: mjds.length ? [Math.min(...mjds), Math.max(...mjds)] : undefined,
    data,
    coverage,
    weight,
    n: frames.reduce((s, f) => s + (f.n ?? 1), 0),
    unit: frames[0].unit,
    files: frames.flatMap((f) => f.files ?? []),
  };
}

/**
 * Load the frames of `pass` that band `bandId` needs onto `grid` and stack them.
 * opts: { signal, onProgress(done, total), loader } (loader defaults to loadFrame).
 * Frames that fail to load are skipped and listed in `errors`.
 */
export async function passStack(pass, bandId, grid, { signal, onProgress, loader = loadFrame } = {}) {
  const band = getBand(bandId);
  const visits = visitsForBand(band, pass.visits);
  let done = 0;
  const errors = [];
  const loaded = await Promise.all(
    visits.map((v) =>
      loader(v, grid, { signal })
        .catch((err) => {
          if (err.name === 'AbortError') throw err;
          errors.push({ url: v.url, error: String(err.message || err) });
          return null;
        })
        .finally(() => onProgress?.(++done, visits.length)),
    ),
  );
  const frames = loaded.filter((f) => f && f.noise > 0);
  const weights = frames.map((f) => bandWeight(band, f.lambda, f.bandwidth) / f.noise ** 2);
  const used = frames.filter((f, k) => weights[k] > 0);
  const s = stackFrames(frames.map((f) => f.data), weights);
  const lambdas = used.map((f) => f.lambda);
  const mjds = used.map((f) => f.mjd);
  const flagCounts = {};
  for (const f of used) for (const [k, c] of f.flagCounts) flagCounts[k] = (flagCounts[k] || 0) + c;
  return {
    source: 'spherex',
    band: band.id,
    label: pass.label,
    mjd: mjds.length ? mjds.reduce((a, b) => a + b, 0) / mjds.length : pass.mjdMean,
    mjdRange: mjds.length ? [Math.min(...mjds), Math.max(...mjds)] : null,
    data: s.data,
    coverage: s.coverage,
    weight: s.weight,
    n: s.n,
    unit: 'MJy/sr',
    lambdaRange: lambdas.length ? [Math.min(...lambdas), Math.max(...lambdas)] : null,
    files: used.map((f) => f.url),
    flagCounts,
    requested: visits.length,
    errors,
  };
}
