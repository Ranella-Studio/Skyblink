// Measuring a clicked source: centroids on the shared grid, a straight-line
// fit of position against time, aperture flux. Pure functions, no DOM.

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
 * Returns { col, row, flux, snr } or null.
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
  for (let y = Math.floor(py - core); y <= Math.ceil(py + core); y++)
    for (let x = Math.floor(px - core); x <= Math.ceil(px + core); x++) {
      if ((x - px) ** 2 + (y - py) ** 2 > core * core) continue;
      const w = at(x, y) - bg;
      if (!(w > 0)) continue;
      sw += w;
      sx += w * x;
      sy += w * y;
    }
  return { col: sx / sw, row: sy / sw, flux: sw, snr: peak / sigma };
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
