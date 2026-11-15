// Measuring a clicked source: centroids on the shared grid, a straight-line
// fit of position against time, aperture flux. Pure functions, no DOM.

import { angularDistance } from '../data/sky-math.js';
import { gridToSky, skyToGrid } from '../engine/grid.js';

export const SEARCH_ARCSEC = 12;
export const STILL_ARCSEC = 3; // one click: the same source within 3″ on other dates means it did not move
const APERTURE_ARCSEC = 9; // one aperture for every frame; sky from a ring at 2 to 3 times that

const sortNum = (a) => a.sort((x, y) => x - y);
function median(a) {
  if (!a.length) return NaN;
  const s = sortNum(Float64Array.from(a));
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

/**
 * The source nearest (col, row): the brightest pixel within `radius` pixels,
 * then the flux-weighted centroid within `core` pixels of it, on a local
 * background (median of a box 2 x radius around the click). The brightest pixel
 * must stand `snr` sigma (MAD of the box) above the background.
 * Returns { col, row, flux (positive core sum), npix (finite core pixels), snr } or null.
 */
export function centroid(data, n, col, row, radius, { snr = 5, core = 2.5 } = {}) {
  const at = (x, y) => (x < 0 || y < 0 || x >= n || y >= n ? NaN : data[y * n + x]);
  const R = Math.ceil(radius * 2);
  const box = [];
  for (let y = Math.round(row) - R; y <= Math.round(row) + R; y++)
    for (let x = Math.round(col) - R; x <= Math.round(col) + R; x++) {
      const v = at(x, y);
      if (v === v) box.push(v);
    }
  if (box.length < 25) return null;
  const bg = median(box);
  const sigma = 1.4826 * median(box.map((v) => Math.abs(v - bg))) || 1e-30;
  let px = -1;
  let py = -1;
  let peak = -Infinity;
  for (let y = Math.floor(row - radius); y <= Math.ceil(row + radius); y++)
    for (let x = Math.floor(col - radius); x <= Math.ceil(col + radius); x++) {
      if ((x - col) ** 2 + (y - row) ** 2 > radius * radius) continue;
      const v = at(x, y);
      if (v - bg > peak) [peak, px, py] = [v - bg, x, y];
    }
  if (!(peak >= snr * sigma)) return null;
  let sw = 0;
  let sx = 0;
  let sy = 0;
  let npix = 0;
  for (let y = Math.floor(py - core); y <= Math.ceil(py + core); y++)
    for (let x = Math.floor(px - core); x <= Math.ceil(px + core); x++) {
      if ((x - px) ** 2 + (y - py) ** 2 > core * core) continue;
      const w = at(x, y) - bg;
      if (w === w) npix++;
      if (!(w > 0)) continue;
      sw += w;
      sx += w * x;
      sy += w * y;
    }
  return { col: sx / sw, row: sy / sw, flux: sw, npix, snr: peak / sigma };
}

/** Sum over a circular aperture minus the median of a surrounding annulus; NaN if the aperture has holes. */
export function apertureFlux(data, width, height, x0, y0, r, rIn = r * 2, rOut = r * 3) {
  const ann = [];
  const inside = [];
  let holes = 0;
  for (let y = Math.floor(y0 - rOut); y <= Math.ceil(y0 + rOut); y++) {
    for (let x = Math.floor(x0 - rOut); x <= Math.ceil(x0 + rOut); x++) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const d2 = (x - x0) ** 2 + (y - y0) ** 2;
      const v = data[y * width + x];
      if (d2 <= r * r) Number.isFinite(v) ? inside.push(v) : holes++;
      else if (d2 >= rIn * rIn && d2 <= rOut * rOut && Number.isFinite(v)) ann.push(v);
    }
  }
  if (holes || !inside.length || ann.length < 8) return NaN;
  const bg = median(ann);
  return inside.reduce((s, v) => s + v - bg, 0);
}

const DIRS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
export const direction = (pa) => DIRS[Math.round((((pa % 360) + 360) % 360) / 45) % 8];

/**
 * Straight-line fit of position against time. points: [{ mjd, ra, dec }].
 * Offsets are measured on the sky (east = RA * cos Dec). Returns
 * { speed (arcsec/yr), pa (deg east of north), sigma (arcsec/yr), years, n } or null.
 * sigma comes from the residuals; with two points it assumes `floor` arcsec per position.
 */
export function fitMotion(points, { floor = 1 } = {}) {
  if (points.length < 2) return null;
  const ref = points[0];
  const cosd = Math.cos((ref.dec * Math.PI) / 180);
  const pts = points.map((p) => {
    let dra = p.ra - ref.ra;
    if (dra > 180) dra -= 360;
    if (dra < -180) dra += 360;
    return { t: (p.mjd - ref.mjd) / 365.25, x: dra * cosd * 3600, y: (p.dec - ref.dec) * 3600 };
  });
  const k = pts.length;
  const tm = pts.reduce((s, p) => s + p.t, 0) / k;
  const stt = pts.reduce((s, p) => s + (p.t - tm) ** 2, 0);
  if (stt < 0.25 ** 2) return null; // under three months of baseline
  const fit = (key) => {
    const m = pts.reduce((s, p) => s + p[key], 0) / k;
    const slope = pts.reduce((s, p) => s + (p.t - tm) * (p[key] - m), 0) / stt;
    const res = pts.reduce((s, p) => s + (p[key] - m - slope * (p.t - tm)) ** 2, 0);
    return { slope, res, mean: m };
  };
  const fx = fit('x');
  const fy = fit('y');
  const rms = k > 2 ? Math.sqrt((fx.res + fy.res) / (2 * (k - 2))) : floor;
  const sigma = Math.max(rms, floor / 2) / Math.sqrt(stt);
  const speed = Math.hypot(fx.slope, fy.slope);
  const pa = ((Math.atan2(fx.slope, fy.slope) * 180) / Math.PI + 360) % 360;
  const t = pts.map((p) => p.t);
  /** The fitted line's [ra, dec] at `mjd`. */
  const at = (mjd) => {
    const dt = (mjd - ref.mjd) / 365.25 - tm;
    return [ref.ra + (fx.mean + fx.slope * dt) / 3600 / cosd, ref.dec + (fy.mean + fy.slope * dt) / 3600];
  };
  return { speed, pa, sigma, years: Math.max(...t) - Math.min(...t), n: k, vEast: fx.slope, vNorth: fy.slope, at };
}

/** Robust per-pixel noise of a frame: 1.4826 x the median absolute deviation of its finite pixels. */
export function frameNoise(data) {
  const v = Array.from(data).filter(Number.isFinite);
  const m = median(v);
  return 1.4826 * median(v.map((x) => Math.abs(x - m)));
}

/** A source found on the predicted track counts only if its aperture sum is at least `k` times the aperture's noise. */
export const accepted = (flux, pixNoise, npix, k = 5) => Number.isFinite(flux) && flux >= k * pixNoise * Math.sqrt(npix);

/** RMS distance in arcsec of points [{ ra, dec }] from their mean position. */
export function scatterArcsec(points) {
  const cosd = Math.cos((points[0].dec * Math.PI) / 180);
  const xs = points.map((p) => (((p.ra - points[0].ra + 540) % 360) - 180) * cosd * 3600);
  const ys = points.map((p) => (p.dec - points[0].dec) * 3600);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  return Math.sqrt(xs.reduce((s, x, i) => s + (x - mx) ** 2 + (ys[i] - my) ** 2, 0) / xs.length);
}

/** The plain sentence for a fit. */
export function motionSentence(fit) {
  if (!fit) return 'Not enough dates to measure motion.';
  if (fit.speed < 3 * fit.sigma) return `No clear motion: less than ${(3 * fit.sigma).toFixed(1)} arcsec a year over ${fit.years.toFixed(0)} years.`;
  return `Moved ${fit.speed.toFixed(2)} ± ${fit.sigma.toFixed(2)} arcsec a year, toward ${direction(fit.pa)}.`;
}

/** Sky position + brightness of a centroid in one frame. */
function position(slot, m, kind, grid) {
  const [ra, dec] = gridToSky(grid, m.col, m.row);
  const flux = apertureFlux(slot.frame.data, grid.n, grid.n, m.col, m.row, APERTURE_ARCSEC / grid.scale);
  return { slot, mjd: slot.frame.mjd, found: true, kind, col: m.col, row: m.row, ra, dec, flux, ...brightness(flux, slot.frame.unit, grid.scale) };
}

/**
 * Marks -> positions on every ready frame. One mark: frames where the same source sits within 3″ join;
 * found in two or more other frames and nowhere further away, it did not move. Two or more: fit a line,
 * look within 12″ of its prediction in each unmarked frame, accept a centroid whose aperture sum is at least 5 times the frame's aperture noise, refit with all.
 */
export function measure(app) {
  const c = app.click;
  if (!c) return;
  const grid = app.tl.grid;
  const ready = app.view.filter((s) => s.status === 'ready');
  for (const id of c.marks.keys()) if (!ready.some((s) => s.id === id)) c.marks.delete(id);
  const look = (slot, ra, dec, radius) => {
    const g = skyToGrid(grid, ra, dec);
    return g && centroid(slot.frame.data, grid.n, g[0], g[1], radius / grid.scale, { core: 9 / grid.scale });
  };
  const marked = ready.filter((s) => c.marks.has(s.id)).map((s) => position(s, c.marks.get(s.id), 'marked', grid));
  c.still = null;
  c.fit = null;
  c.positions = marked;
  if (marked.length === 1) {
    const [m] = marked;
    // Search the normal 12″ (centroid measures its sky in a box twice the search radius; at 3″ that box is
    // the star itself and nothing is found), then keep what lies within 3″ of the mark.
    let away = 0;
    for (const s of ready) {
      if (s.id === m.slot.id) continue;
      const f = look(s, m.ra, m.dec, SEARCH_ARCSEC);
      if (!f) continue;
      const p = position(s, f, 'found', grid);
      if (angularDistance(p.ra, p.dec, m.ra, m.dec) * 3600 <= STILL_ARCSEC) c.positions.push(p);
      else away++;
    }
    c.positions.sort((x, y) => x.mjd - y.mjd);
    c.away = away;
    if (c.positions.length >= 3 && !away) c.still = { scatter: scatterArcsec(c.positions) };
  } else if (marked.length >= 2) {
    const line = fitMotion(marked, { floor: grid.scale / 2 });
    if (line) {
      const npix = Math.PI * (APERTURE_ARCSEC / grid.scale) ** 2;
      const found = [];
      for (const s of ready) {
        if (c.marks.has(s.id)) continue;
        const f = look(s, ...line.at(s.frame.mjd), SEARCH_ARCSEC);
        if (!f) continue;
        const p = position(s, f, 'found', grid);
        s.frame.noise ??= frameNoise(s.frame.data); // shortcut: cached on the frame object, recomputed if the frame is rebuilt
        // A saturated core leaves flagged (NaN) pixels in the aperture: then judge the centroid's core sum instead.
        const ok = Number.isFinite(p.flux) ? accepted(p.flux, s.frame.noise, npix) : accepted(f.flux, s.frame.noise, f.npix);
        if (ok) found.push(p);
      }
      c.positions = [...marked, ...found].sort((x, y) => x.mjd - y.mjd);
    }
    c.fit = fitMotion(c.positions, { floor: grid.scale / 2 });
  }
  c.readyCount = ready.length;
}

/**
 * Aperture sum -> a value in the frame's own unit. Surface brightness in MJy/sr
 * summed over pixels times the pixel's solid angle is a flux density, given in mJy;
 * any other unit is shown as the plain sum, labelled with that unit.
 */
function brightness(sum, unit, scaleArcsec) {
  if (!Number.isFinite(sum)) return { value: NaN, unit: unit || '' };
  if (unit === 'MJy/sr') return { value: sum * 1e9 * (scaleArcsec / 206264.806) ** 2, unit: 'mJy' };
  return { value: sum, unit: `${unit || 'counts'} summed` };
}

/** A published track { ra, dec, epoch (Julian year), pmra, pmdec (mas/yr, pmra with cos Dec) } -> [ra, dec] at `mjd`. */
export function trackAt(t, mjd) {
  const dt = 2000 + (mjd - 51544.5) / 365.25 - t.epoch;
  const dec = t.dec + (t.pmdec * dt) / 3.6e6;
  return [t.ra + (t.pmra * dt) / 3.6e6 / Math.cos((((t.dec + dec) / 2) * Math.PI) / 180), dec];
}
