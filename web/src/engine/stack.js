// Stack the frames of one pass into one band image, and simple image maths on
// the common grid. Frame images are Float32Array(n*n), NaN = no data.

import { loadFrame } from './cutout.js';
import { getBand, synthWeights, visitsForBand, estimateLambda } from './bands.js';

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
 * At most `max` items, spread as evenly as possible in key(item): for each of
 * `max` evenly spaced targets across the key range, the nearest unused item.
 */
export function spreadPick(items, key, max) {
  if (items.length <= max) return items;
  const keyed = items.map((it) => ({ it, k: key(it) })).sort((a, b) => a.k - b.k);
  const lo = keyed[0].k;
  const step = (keyed.at(-1).k - lo) / Math.max(1, max - 1);
  const used = new Set();
  for (let t = 0; t < max; t++) {
    const target = lo + t * step;
    let best = -1;
    for (let j = 0; j < keyed.length; j++) {
      if (used.has(j)) continue;
      if (best < 0 || Math.abs(keyed[j].k - target) < Math.abs(keyed[best].k - target)) best = j;
    }
    used.add(best);
  }
  return keyed.filter((x, j) => used.has(j)).map((x) => x.it);
}

/**
 * Load the frames of `pass` that band `bandId` needs onto `grid` and stack them.
 * opts: { signal, onProgress(done, total), loader, maxFrames } (loader defaults to loadFrame).
 * At most maxFrames visits are downloaded: spread in wavelength for matched
 * bands, in time for detector bands. Frames that fail to load are skipped and
 * listed in `errors`. Matched bands are a synthetic-photometry integral
 * (synthWeights); detector bands are inverse-variance weighted.
 */
export async function passStack(pass, bandId, grid, { signal, onProgress, loader = loadFrame, maxFrames = 48 } = {}) {
  const band = getBand(bandId);
  const detector = band.kind === 'detector';
  const all = visitsForBand(band, pass.visits);
  const visits = spreadPick(all, detector ? (v) => v.mjd : (v) => estimateLambda(v.det, v.y), maxFrames);
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
  let weights = frames.map((f) => 1 / f.noise ** 2);
  let bandCoverage = 1;
  if (!detector) ({ weights, coverage: bandCoverage } = synthWeights(band, frames));
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
    bandCoverage,
    requested: visits.length,
    available: all.length,
    errors,
  };
}
