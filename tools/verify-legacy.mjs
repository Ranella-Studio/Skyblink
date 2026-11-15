// Prove the long timeline on real data: AllWISE W1/W2 from S3 and 2MASS J/H/Ks (baked cutouts served by
// server/server.mjs, plus IRSA directly) for the five challenge targets on a 6 arcmin, 3 arcsec/pixel grid.
// Writes docs/targets/<id>/legacy-<band>.png, legacy-sheet.png and legacy.json.
// Run from the repo root: NODE_USE_ENV_PROXY=1 node tools/verify-legacy.mjs
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { writePng, writePngRgb, contactSheet } from './png.mjs';
import { makeGrid, gridToSky, skyToGrid } from '../web/src/engine/grid.js';
import { angularDistance } from '../web/src/data/sky-math.js';
import { loadAllwise } from '../web/src/engine/legacy/allwise.js';
import { loadTwomass, loadTwomassIrsa } from '../web/src/engine/legacy/twomass.js';
import { normalise, toBytes } from '../web/src/engine/legacy/match.js';
import { clippedStats } from '../web/src/engine/legacy/stats.js';
import { createApp } from '../server/server.mjs';

// ICRS position at epoch (Julian year), proper motion mas/yr (pmra includes cos dec): same as tools/verify-targets.mjs.
const TARGETS = [
  { id: 'barnards-star', name: "Barnard's Star", ra: 269.45208, dec: 4.69339, pmra: -801.6, pmdec: 10362.4, epoch: 2000.0 },
  { id: 'eps-indi-b', name: 'Epsilon Indi B', ra: 331.04383, dec: -56.78269, pmra: 3966.7, pmdec: -2536.2, epoch: 2000.0 },
  { id: 'wise-0855', name: 'WISE 0855-0714', ra: 133.795129, dec: -7.245147, pmra: -8118, pmdec: 680, epoch: 2014.3 },
  { id: 'rw-aur', name: 'RW Aurigae', ra: 76.95642, dec: 30.40136, pmra: 0, pmdec: 0, epoch: 2000.0 },
  { id: 'r-dra', name: 'R Draconis', ra: 248.1675, dec: 66.755, pmra: 0, pmdec: 0, epoch: 2000.0 },
];
const F0 = { W1: 309.54, W2: 171.787, J: 1594, H: 1024, Ks: 666.7 };
const SEARCH = 15; // arcsec
const APERTURE = 12; // arcsec radius

const year = (mjd) => 2000 + (mjd - 51544.5) / 365.25;
function positionAt(t, mjd) {
  const dt = year(mjd) - t.epoch;
  const dec = t.dec + (t.pmdec * dt) / 3.6e6;
  return [t.ra + (t.pmra * dt) / 3.6e6 / Math.cos((dec * Math.PI) / 180), dec];
}

/** Brightest pixel within SEARCH of (ra, dec), centroid in a 2-pixel radius, aperture flux (mJy, no aperture correction). */
function measure(grid, frame, ra, dec) {
  const n = grid.n;
  const [c0, r0] = skyToGrid(grid, ra, dec);
  const rad = SEARCH / grid.scale;
  let best = -1;
  for (let r = Math.floor(r0 - rad); r <= Math.ceil(r0 + rad); r++)
    for (let c = Math.floor(c0 - rad); c <= Math.ceil(c0 + rad); c++) {
      if (r < 0 || c < 0 || r >= n || c >= n || Math.hypot(r - r0, c - c0) > rad) continue;
      const k = r * n + c;
      if (Number.isFinite(frame.data[k]) && (best < 0 || frame.data[k] > frame.data[best])) best = k;
    }
  if (best < 0) return null;
  const bc = best % n;
  const br = Math.floor(best / n);
  let sx = 0, sy = 0, sw = 0;
  for (let r = br - 2; r <= br + 2; r++)
    for (let c = bc - 2; c <= bc + 2; c++) {
      const v = frame.data[r * n + c];
      if (Math.hypot(r - br, c - bc) <= 2 && v > 0) { sx += v * c; sy += v * r; sw += v; }
    }
  const [cra, cdec] = gridToSky(grid, sx / sw, sy / sw);
  const pixSr = ((grid.scale / 3600) * (Math.PI / 180)) ** 2;
  let flux = 0;
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      const v = frame.data[r * n + c];
      if (Number.isFinite(v) && Math.hypot(r - sy / sw, c - sx / sw) * grid.scale <= APERTURE) flux += v;
    }
  const mJy = flux * pixSr * 1e6 * 1e3; // MJy/sr * sr -> MJy -> mJy
  const sigma = clippedStats(frame.data).sigma;
  return {
    centroid: [+cra.toFixed(6), +cdec.toFixed(6)],
    offsetArcsec: +(angularDistance(cra, cdec, ra, dec) * 3600).toFixed(2),
    peakSnr: +(frame.data[best] / sigma).toFixed(1),
    apertureMJy: +mJy.toFixed(3),
    apertureVegaMag: mJy > 0 && F0[frame.band] ? +(-2.5 * Math.log10(mJy / 1e3 / F0[frame.band])).toFixed(2) : null,
  };
}

const app = createApp({ root: fileURLToPath(new URL('../web/public', import.meta.url)) });
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.address().port}/`;
const index = JSON.parse(readFileSync(new URL('../web/public/data/allwise-tiles.json', import.meta.url)));

for (const t of TARGETS) {
  const grid = makeGrid({ ra: t.ra, dec: t.dec, fovArcmin: 6, scale: 3 });
  const dir = new URL(`../docs/targets/${t.id}/`, import.meta.url);
  mkdirSync(dir, { recursive: true });
  const out = { target: t.name, grid, aperture: `${APERTURE} arcsec radius, sky-subtracted, no aperture correction`, frames: [] };
  const tiles = [];
  for (const band of ['W1', 'W2', 'J', 'H', 'Ks']) {
    const t0 = performance.now();
    let frame;
    try {
      frame = band[0] === 'W' ? await loadAllwise(grid, band, { index }) : await loadTwomass(grid, band, { base, proxy: '' });
    } catch (e) {
      out.frames.push({ band, error: e.message });
      tiles.push(null);
      continue;
    }
    const ms = Math.round(performance.now() - t0);
    const gray = toBytes(normalise(frame), { soft: 3 });
    writePng(fileURLToPath(new URL(`legacy-${band}.png`, dir)), { width: grid.n, height: grid.n, gray });
    tiles.push({ width: grid.n, height: grid.n, rgb: Uint8Array.from({ length: gray.length * 3 }, (_, i) => gray[Math.floor(i / 3)]) });
    const at = positionAt(t, frame.mjd);
    const entry = {
      band,
      label: frame.label,
      tile: frame.tile,
      epoch: +year(frame.mjd).toFixed(3),
      mjd: +frame.mjd.toFixed(3),
      mjdRange: frame.mjdRange.map((m) => +m.toFixed(3)),
      unit: frame.unit,
      files: frame.files,
      ms,
      emptyPixels: frame.data.filter(Number.isNaN).length,
      atCataloguePosition: measure(grid, frame, t.ra, t.dec),
      predictedPosition: [+at[0].toFixed(6), +at[1].toFixed(6)],
      atPredictedPosition: t.pmra || t.pmdec ? measure(grid, frame, ...at) : undefined,
    };
    out.frames.push(entry);
    const m = entry.atPredictedPosition ?? entry.atCataloguePosition;
    console.log(`${t.id.padEnd(14)} ${band.padEnd(2)} ${frame.label.padEnd(24)} ${String(ms).padStart(5)} ms  offset ${m.offsetArcsec}"  snr ${m.peakSnr}  ${m.apertureMJy} mJy (${m.apertureVegaMag} mag)`);
  }
  // Barnard's Star also straight from IRSA (the Node path), to check the baked layer against it.
  if (t.id === 'barnards-star') {
    const f = await loadTwomassIrsa(makeGrid({ ra: t.ra, dec: t.dec, fovArcmin: 2, scale: 1 }), 'J');
    const g = makeGrid({ ra: t.ra, dec: t.dec, fovArcmin: 2, scale: 1 });
    out.irsaDirectJ = { label: f.label, files: f.files, ...measure(g, f, ...positionAt(t, f.mjd)) };
    console.log(`  IRSA direct J at 1"/px: ${f.label}, centroid ${out.irsaDirectJ.offsetArcsec}" from predicted`);
  }
  writeFileSync(new URL('legacy.json', dir), JSON.stringify(out, null, 1));
  const sheet = contactSheet(tiles, { cols: 5, labels: { cols: ['W1 2010', 'W2 2010', 'J', 'H', 'KS'] } });
  writePngRgb(fileURLToPath(new URL('legacy-sheet.png', dir)), sheet);
}
app.close();
