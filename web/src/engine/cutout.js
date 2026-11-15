// Ported from Ranella-Studio/Nasa-Challenge (first version): web/src/lab/cutout.js (approach: range-read only the needed rows, bilinear resampling through the TAN-SIP WCS skipping flagged pixels; rewritten for the shared grid)
// One SPHEREx Level 2 file -> one sky-subtracted image on a common grid.

import { SpherexFile, W, isBadPixel, flagCounts as countFlags } from '../fits/spherex.js';
import { gridToSky } from './grid.js';
import { skyStats } from './stack.js';

// Opened files (header, WCS), least recently used first.
const files = new Map();
const MAX_FILES = 400;
// Finished frames per (file, grid), so switching bands does not download again.
const frames = new Map();
const MAX_FRAMES = 600; // ~60 KB each at 121 x 121

function lru(map, key, make, max) {
  let p = map.get(key);
  if (p) map.delete(key);
  else {
    p = make();
    p.catch(() => map.get(key) === p && map.delete(key));
  }
  map.set(key, p);
  if (map.size > max) map.delete(map.keys().next().value);
  return p;
}

// At most MAX_ACTIVE files downloading at once.
const MAX_ACTIVE = 6;
let active = 0;
const waiting = [];
async function slot(signal) {
  while (active >= MAX_ACTIVE) {
    await new Promise((r) => waiting.push(r));
    signal?.throwIfAborted();
  }
  active++;
}
function release() {
  active--;
  waiting.shift()?.();
}

const gridKey = (g) => `${g.ra0},${g.dec0},${g.n},${g.scale}`;

/**
 * Load one visit onto `grid`. Tries each of visit.urls (or visit.url) in turn
 * when a file is not where the index says. Returns
 * { data, lambda, bandwidth, mjd, det, url, flagCounts, noise, sky, rows }.
 * data is Float32Array(n*n) in MJy/sr with the local sky removed, NaN where
 * the detector does not cover the grid or the pixel is flagged bad.
 */
export function loadFrame(visit, grid, { signal } = {}) {
  const urls = visit.urls ?? [visit.url];
  return lru(frames, `${urls[0]}|${gridKey(grid)}`, () => loadAny(urls, visit, grid, signal), MAX_FRAMES);
}

async function loadAny(urls, visit, grid, signal) {
  await slot(signal);
  try {
    for (let k = 0; ; k++) {
      try {
        return await loadNow(urls[k], visit, grid, signal);
      } catch (err) {
        if (err.code !== 404 || k === urls.length - 1) throw err;
      }
    }
  } finally {
    release();
  }
}

async function loadNow(url, visit, grid, signal) {
  const f = await lru(files, url, () => new SpherexFile(url, { signal }).open(), MAX_FILES);
  // shortcut: an opened file is shared, so its reads follow the latest caller's signal; fine while one view loads at a time.
  f.signal = signal;
  const n = grid.n;
  // Detector position (1-based FITS pixels) of every grid pixel centre.
  const xs = new Float64Array(n * n);
  const ys = new Float64Array(n * n);
  let ymin = Infinity;
  let ymax = -Infinity;
  for (let row = 0; row < n; row++)
    for (let col = 0; col < n; col++) {
      const p = f.wcs.skyToPix(...gridToSky(grid, col, row));
      const k = row * n + col;
      xs[k] = p ? p[0] : NaN;
      ys[k] = p ? p[1] : NaN;
      if (p && p[0] >= 1 && p[0] <= W) {
        ymin = Math.min(ymin, p[1]);
        ymax = Math.max(ymax, p[1]);
      }
    }
  const y0 = Math.max(1, Math.floor(ymin));
  const y1 = Math.min(W, Math.ceil(ymax) + 1);
  if (!(y1 > y0)) throw Object.assign(new Error('field not on this detector'), { code: 'off' });
  const centre = f.wcs.skyToPix(grid.ra0, grid.dec0);
  const [img, flags, wave] = await Promise.all([
    f.readRows(y0, y1),
    f.readFlagRows(y0, y1).catch(() => null),
    f.wavelength(centre[0], centre[1]),
  ]);
  const rows = y1 - y0 + 1;
  const data = new Float32Array(n * n);
  const flagGrid = new Int32Array(n * n);
  for (let k = 0; k < n * n; k++) {
    const x = xs[k] - 1; // 0-based column
    const y = ys[k] - y0; // row within what was read
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    if (!(ix >= 0 && iy >= 0 && ix < W - 1 && iy < rows - 1)) {
      data[k] = NaN;
      continue;
    }
    const fx = x - ix;
    const fy = y - iy;
    if (flags) flagGrid[k] = flags[(iy + (fy >= 0.5)) * W + ix + (fx >= 0.5)];
    let sum = 0;
    let wsum = 0;
    for (let dy = 0; dy < 2; dy++)
      for (let dx = 0; dx < 2; dx++) {
        const idx = (iy + dy) * W + ix + dx;
        const v = img[idx];
        if (v !== v || (flags && isBadPixel(flags[idx]))) continue;
        const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
        sum += w * v;
        wsum += w;
      }
    // Keep a pixel only if most of its interpolation weight came from good pixels.
    data[k] = wsum >= 0.5 ? sum / wsum : NaN;
  }
  // SPHEREx frames carry strong zodiacal light: remove the local sky level.
  const sky = skyStats(data);
  for (let k = 0; k < data.length; k++) data[k] -= sky.median;
  return {
    data,
    lambda: wave.lambda,
    bandwidth: wave.bandwidth,
    mjd: f.mjd,
    det: f.detector ?? visit.det,
    url,
    flagCounts: countFlags(flagGrid),
    noise: sky.sigma,
    sky: sky.median,
    rows: [y0, y1],
  };
}
