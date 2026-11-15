// AllWISE Atlas images (WISE 2010 coadds) read straight from NASA's public S3 bucket:
// find the tile, range-read the header and only the rows under the cutout, resample onto the grid.
import { fetchRange, parseHeader, beFloat32 } from '../../fits/fits.js';
import { angularDistance } from '../../data/sky-math.js';
import { gridToSky } from '../grid.js';
import { sinProject } from './sin.js';
import { clippedStats } from './stats.js';

const TILE_PIX = 4095;
const TILE_SCALE = 1.375; // arcsec / pixel, all tiles (checked in tools/build-allwise-tiles.mjs)
// Zero-magnitude flux densities, Jarrett et al. 2011, ApJ 735, 112.
const F0 = { W1: 309.54, W2: 171.787 };
const ARCSEC_SR = (Math.PI / 180 / 3600) ** 2;

let indexPromise;
/** The tile index, web/public/data/allwise-tiles.json. */
export function loadTileIndex(base = import.meta.env.BASE_URL) {
  indexPromise ??= fetch(`${base}data/allwise-tiles.json`).then((r) => {
    if (!r.ok) throw new Error(`allwise-tiles.json: HTTP ${r.status}`);
    return r.json();
  });
  return indexPromise;
}

export function tileUrl(index, id, band) {
  const w = band.toLowerCase();
  return `${index.source}${id.slice(0, 2)}/${id.slice(0, 4)}/${id}_ac51/${id}_ac51-${w}-int-3.fits`;
}

/** Sky positions of the grid's corners and edge midpoints (pixel-edge outer bounds). */
function outline(grid) {
  const lo = -0.5;
  const hi = grid.n - 0.5;
  const mid = (grid.n - 1) / 2;
  return [[lo, lo], [lo, hi], [hi, lo], [hi, hi], [mid, lo], [mid, hi], [lo, mid], [hi, mid]].map(([c, r]) => gridToSky(grid, c, r));
}

/**
 * The tile that holds the cutout with the most room to spare. margin is in tile pixels:
 * >= 0 means the whole grid lies inside the tile (with a pixel to spare for interpolation).
 */
export function findTile(index, grid, { exhaustive = false } = {}) {
  const pts = outline(grid);
  let best = null;
  for (const b of index.bands) {
    if (!exhaustive && Math.abs(b.dec - grid.dec0) > 2.5) continue;
    for (let i = 0; i < b.ra.length; i++) {
      if (!exhaustive && angularDistance(b.ra[i], b.dec, grid.ra0, grid.dec0) > 1.5) continue;
      let worst = -Infinity;
      for (const [ra, dec] of pts) {
        const p = sinProject(b.ra[i], b.dec, ra, dec);
        worst = p ? Math.max(worst, Math.abs(p[0]), Math.abs(p[1])) : Infinity;
      }
      const margin = (TILE_PIX - 1) / 2 - 1 - (worst * 3600) / TILE_SCALE;
      if (!best || margin > best.margin) best = { id: b.ras.slice(4 * i, 4 * i + 4) + b.d, ra: b.ra[i], dec: b.dec, margin };
    }
  }
  return best;
}

/** MJy/sr per DN for an AllWISE intensity image with zero point MAGZP and pixel size in arcsec. */
export function dnToMJySr(band, magzp, pixArcsec) {
  return (F0[band] * 10 ** (-0.4 * magzp) * 1e-6) / (pixArcsec * pixArcsec * ARCSEC_SR);
}

const isoToMjd = (iso) => Date.parse(`${iso}Z`) / 86400e3 + 40587;

/**
 * One AllWISE frame on `grid`. band 'W1' | 'W2'. Sky (sigma-clipped median of the cutout) removed.
 * shortcut: one tile only; pixels off the tile are NaN. Stitch neighbours if fields > ~1.5 deg matter.
 */
export async function loadAllwise(grid, band, { signal, index } = {}) {
  if (!F0[band]) throw new Error(`AllWISE band must be W1 or W2, not ${band}`);
  index ??= await loadTileIndex();
  const tile = findTile(index, grid);
  const url = tileUrl(index, tile.id, band);

  let head = await fetchRange(url, 0, 8639, { signal });
  let h = parseHeader(head, 0);
  if (!h) h = parseHeader((head = await fetchRange(url, 0, 28799, { signal })), 0);
  const c = h.cards;
  if (c.CTYPE1 !== 'RA---SIN' || c.CTYPE2 !== 'DEC--SIN' || (c.CROTA2 || 0) !== 0 || c.BITPIX !== -32) {
    throw new Error(`${tile.id}: unexpected WCS or BITPIX`);
  }
  const W = c.NAXIS1;
  const H = c.NAXIS2;

  // Fractional 0-based tile pixel of every grid pixel centre.
  const n = grid.n;
  const fx = new Float64Array(n * n);
  const fy = new Float64Array(n * n);
  let yMin = Infinity;
  let yMax = -Infinity;
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const k = row * n + col;
      const [ra, dec] = gridToSky(grid, col, row);
      const p = sinProject(c.CRVAL1, c.CRVAL2, ra, dec);
      fx[k] = p ? c.CRPIX1 - 1 + p[0] / c.CDELT1 : NaN;
      fy[k] = p ? c.CRPIX2 - 1 + p[1] / c.CDELT2 : NaN;
      if (fy[k] < yMin) yMin = fy[k];
      if (fy[k] > yMax) yMax = fy[k];
    }
  }
  const r0 = Math.max(0, Math.floor(yMin));
  const r1 = Math.min(H - 1, Math.floor(yMax) + 1);
  if (r1 < r0) throw new Error(`${tile.id}: cutout falls outside the tile`);
  // Whole rows in one contiguous read, since S3 has no multi-range requests.
  // shortcut: ~4.4 MB per band for a 6 arcmin field; switch to per-row column ranges if bandwidth matters.
  const start = h.end + r0 * W * 4;
  const pix = beFloat32(await fetchRange(url, start, start + (r1 - r0 + 1) * W * 4 - 1, { signal }));

  const k = dnToMJySr(band, c.MAGZP, c.PXSCAL1 ?? TILE_SCALE);
  const data = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) {
    const x = fx[i];
    const y = fy[i] - r0;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    if (!(x0 >= 0 && x0 + 1 < W && y0 >= 0 && y0 + 1 <= r1 - r0)) {
      data[i] = NaN;
      continue;
    }
    const tx = x - x0;
    const ty = y - y0;
    const a = y0 * W + x0;
    data[i] = k * ((1 - ty) * ((1 - tx) * pix[a] + tx * pix[a + 1]) + ty * ((1 - tx) * pix[a + W] + tx * pix[a + W + 1]));
  }
  const sky = clippedStats(data).median;
  for (let i = 0; i < data.length; i++) data[i] -= sky;

  const mjdRange = [isoToMjd(c.DATEOBS1), isoToMjd(c.DATEOBS2)];
  const year = new Date(Date.parse(`${c.DATEOBS1}Z`)).getUTCFullYear();
  return {
    source: 'allwise',
    band,
    label: `AllWISE ${band}, ${year}`,
    mjd: (mjdRange[0] + mjdRange[1]) / 2,
    mjdRange,
    data,
    unit: 'MJy/sr',
    files: [url],
    tile: tile.id,
    note:
      `AllWISE Atlas tile ${tile.id}: a coadd of ${c.NUMFRMS} frames taken ${c.DATEOBS1.slice(0, 10)} to ${c.DATEOBS2.slice(0, 10)} ` +
      `(middle frame ${String(c.MIDOBS).slice(0, 10)}); mjd is the middle of that range. Atlas images are PSF-smoothed. ` +
      `Calibrated with MAGZP ${c.MAGZP} and ${F0[band]} Jy zero point (Jarrett et al. 2011); local sky ${sky.toPrecision(3)} MJy/sr removed.`,
  };
}
