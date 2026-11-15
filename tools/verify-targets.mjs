// Run the SPHEREx engine on the challenge's five test targets with real data
// from NASA's archive, and write a contact sheet and measurements for each:
//   node tools/verify-targets.mjs [targetId ...]
// Output: docs/targets/<id>/sheet.png (one row per pass, columns = bands),
// sheet-bins.png (30-day bins, only where a pass is longer than 30 days) and result.json.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { Pointings } from '../web/src/data/pointings.js';
import { findVisits, groupPasses } from '../web/src/engine/passes.js';
import { makeGrid, gridToSky, skyToGrid } from '../web/src/engine/grid.js';
import { passStack, add } from '../web/src/engine/stack.js';
import { BANDS } from '../web/src/engine/bands.js';
import { writePngRgb, contactSheet, drawText } from './png.mjs';

const ROOT = new URL('../', import.meta.url);
const FOV = 6;
const SCALE = 3;

// ICRS position at epoch (Julian year), proper motion in mas/yr (pmra includes cos dec).
const TARGETS = [
  { id: 'barnards-star', name: "Barnard's Star", ra: 269.45208, dec: 4.69339, pmra: -801.6, pmdec: 10362.4, epoch: 2000.0 },
  { id: 'eps-indi-b', name: 'Epsilon Indi B', ra: 331.04383, dec: -56.78269, pmra: 3966.7, pmdec: -2536.2, epoch: 2000.0 },
  { id: 'wise-0855', name: 'WISE 0855-0714', ra: 133.795129, dec: -7.245147, pmra: -8118, pmdec: 680, epoch: 2014.3 },
  { id: 'rw-aur', name: 'RW Aurigae', ra: 76.95642, dec: 30.40136, pmra: 0, pmdec: 0, epoch: 2000.0 },
  { id: 'r-dra', name: 'R Draconis', ra: 248.1675, dec: 66.755, pmra: 0, pmdec: 0, epoch: 2000.0 },
];

const mjdToYear = (mjd) => 2000 + (mjd - 51544.5) / 365.25;
function positionAt(t, mjd) {
  const dt = mjdToYear(mjd) - t.epoch;
  const dec = t.dec + (t.pmdec * dt) / 3.6e6;
  const ra = t.ra + (t.pmra * dt) / 3.6e6 / Math.cos((((t.dec + dec) / 2) * Math.PI) / 180);
  return [ra, dec];
}
const isoDate = (mjd) => new Date((mjd - 40587) * 86400000).toISOString().slice(0, 10);

// Count real bytes downloaded.
let bytes = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (...a) => {
  const r = await realFetch(...a);
  const b = await r.arrayBuffer();
  bytes += b.byteLength;
  return new Response(b, { status: r.status, statusText: r.statusText, headers: r.headers });
};

function loadIndex() {
  const dir = new URL('web/public/data/', ROOT);
  const meta = JSON.parse(readFileSync(new URL('pointings.json', dir)));
  const bin = readFileSync(new URL('pointings.bin', dir));
  return new Pointings(meta, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
}

const med = (a) => {
  const s = Float64Array.from(a).sort();
  const m = s.length >> 1;
  return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : NaN;
};

/** Centroid, aperture flux and empty-aperture noise at the predicted position. */
function measure(stack, grid, [pc, pr]) {
  const { n, scale } = grid;
  const d = stack.data;
  const R = 12 / scale; // centroid and aperture radius, 12 arcsec
  const pixSr = (scale / 206264.806) ** 2;
  const ring = (c, r, r0, r1) => {
    const out = [];
    for (let y = Math.floor(r - r1); y <= Math.ceil(r + r1); y++)
      for (let x = Math.floor(c - r1); x <= Math.ceil(c + r1); x++) {
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        const q = Math.hypot(x - c, y - r);
        if (q >= r0 && q <= r1) out.push([x, y, d[y * n + x]]);
      }
    return out;
  };
  const aperture = (c, r) => {
    const bg = med(ring(c, r, 18 / scale, 30 / scale).map((p) => p[2]).filter((v) => v === v));
    const px = ring(c, r, 0, R);
    const good = px.filter((p) => p[2] === p[2]);
    return { bg, px, good, sum: good.reduce((s, p) => s + p[2] - bg, 0) * (px.length / Math.max(1, good.length)) };
  };
  const a = aperture(pc, pr);
  if (a.good.length < 0.7 * a.px.length) return { ok: false, reason: `aperture ${Math.round((100 * a.good.length) / a.px.length)}% covered` };
  let sw = 0;
  let sx = 0;
  let sy = 0;
  let peak = -Infinity;
  for (const [x, y, v] of a.good) {
    const w = v - a.bg;
    peak = Math.max(peak, w);
    if (w > 0) {
      sw += w;
      sx += w * x;
      sy += w * y;
    }
  }
  // Noise from empty apertures across the field, at least 36 arcsec from the target.
  const sums = [];
  const step = Math.round(24 / scale);
  for (let r = Math.ceil(30 / scale); r < n - 30 / scale; r += step)
    for (let c = Math.ceil(30 / scale); c < n - 30 / scale; c += step) {
      if (Math.hypot(c - pc, r - pr) < 36 / scale) continue;
      const e = aperture(c, r);
      if (e.good.length === e.px.length && e.bg === e.bg) sums.push(e.sum);
    }
  const m = med(sums);
  const noise = 1.4826 * med(sums.map((s) => Math.abs(s - m)));
  const toMJy = 1e9 * pixSr; // MJy/sr summed over pixels -> mJy
  const cc = sw > 0 ? sx / sw : NaN;
  const cr = sw > 0 ? sy / sw : NaN;
  return {
    ok: true,
    fluxMilliJy: +(a.sum * toMJy).toPrecision(5),
    noiseMilliJy: +(noise * toMJy).toPrecision(3),
    snr: +(a.sum / noise).toFixed(1),
    emptyApertures: sums.length,
    peakMJySr: +peak.toPrecision(4),
    apertureCovered: +(a.good.length / a.px.length).toFixed(2),
    centroid: sw > 0 ? gridToSky(grid, cc, cr).map((v) => +v.toFixed(6)) : null,
    // Centroid offset from the predicted position, arcsec (east +, north +).
    offsetArcsec: sw > 0 ? [+((pc - cc) * scale).toFixed(2), +((pr - cr) * scale).toFixed(2)] : null,
  };
}

function tileRgb(stack, grid, mark) {
  const { n } = grid;
  const finite = stack.data.filter((v) => v === v);
  const rgb = new Uint8Array(n * n * 3);
  if (finite.length < 10) {
    for (let k = 0; k < n * n; k++) rgb.set([60, 20, 20], 3 * k);
  } else {
    const m = med(finite);
    const s = Math.max(1e-6, 1.4826 * med(finite.map((v) => Math.abs(v - m))));
    const top = Math.asinh(300);
    for (let k = 0; k < n * n; k++) {
      const v = stack.data[k];
      if (v !== v) rgb.set([60, 20, 20], 3 * k);
      else {
        const g = Math.round(255 * Math.min(1, Math.max(0, (Math.asinh((v - m) / (2 * s)) + 1) / (top + 1))));
        rgb.set([g, g, g], 3 * k);
      }
    }
  }
  // Ticks at the predicted position (gap of 15 arcsec around it).
  if (mark) {
    const [c, r] = mark.map(Math.round);
    for (let q = 5; q <= 9; q++)
      for (const [x, y] of [[c - q, r], [c + q, r], [c, r - q], [c, r + q]])
        if (x >= 0 && y >= 0 && x < n && y < n) rgb.set([0, 220, 90], 3 * (y * n + x));
  }
  drawText(rgb, n, 2, 2, String(stack.n), 1, [255, 200, 0]);
  return { width: n, height: n, rgb };
}

async function runRows(target, passes, grid, kind) {
  const rows = [];
  const tiles = [];
  const all = Object.fromEntries(BANDS.map((b) => [b.id, []]));
  for (const pass of passes) {
    const row = { id: pass.id, label: pass.label, start: isoDate(pass.start), end: isoDate(pass.end), visits: pass.visits.length, bands: {} };
    for (const band of BANDS) {
      const t0 = Date.now();
      const b0 = bytes;
      const s = await passStack(pass, band.id, grid);
      const pos = s.n ? positionAt(target, s.mjd) : positionAt(target, pass.mjdMean);
      const at = skyToGrid(grid, ...pos);
      row.bands[band.id] = {
        frames: s.n,
        requested: s.requested,
        failed: s.errors.length,
        dates: s.mjdRange ? s.mjdRange.map(isoDate) : null,
        lambdaRange: s.lambdaRange?.map((l) => +l.toFixed(4)) ?? null,
        predicted: pos.map((v) => +v.toFixed(6)),
        seconds: +((Date.now() - t0) / 1000).toFixed(1),
        megabytes: +((bytes - b0) / 1e6).toFixed(1),
        ...(s.n ? measure(s, grid, at) : { ok: false, reason: 'no frames' }),
        errors: s.errors.length ? s.errors.slice(0, 3) : undefined,
      };
      tiles.push(s.n ? tileRgb(s, grid, at) : null);
      if (s.n) all[band.id].push(s);
      const r = row.bands[band.id];
      console.log(`${target.id} ${kind} ${pass.label} ${band.id}: n=${s.n}/${s.requested} ${r.ok ? `flux=${r.fluxMilliJy}mJy snr=${r.snr} off=${r.offsetArcsec}` : r.reason} ${r.seconds}s ${r.megabytes}MB`);
    }
    rows.push(row);
  }
  // Every pass combined: the deepest image, for faint targets (position at the mean date).
  const deep = { id: 'all', label: 'all passes', bands: {} };
  for (const band of BANDS) {
    if (!all[band.id].length) {
      tiles.push(null);
      continue;
    }
    const s = add(all[band.id]);
    const mjd = all[band.id].reduce((a, f) => a + f.mjd * f.n, 0) / s.n;
    const pos = positionAt(target, mjd);
    const at = skyToGrid(grid, ...pos);
    deep.bands[band.id] = { frames: s.n, predicted: pos.map((v) => +v.toFixed(6)), ...measure(s, grid, at) };
    tiles.push(tileRgb(s, grid, at));
    const r = deep.bands[band.id];
    console.log(`${target.id} ${kind} ALL ${band.id}: n=${s.n} ${r.ok ? `flux=${r.fluxMilliJy}mJy snr=${r.snr} off=${r.offsetArcsec}` : r.reason}`);
  }
  rows.push(deep);
  return { rows, tiles };
}

async function runTarget(P, target) {
  const dir = new URL(`docs/targets/${target.id}/`, ROOT);
  mkdirSync(dir, { recursive: true });
  // One fixed grid for every pass, centred where the target is in early 2026.
  const [ra, dec] = positionAt(target, 61041);
  const grid = makeGrid({ ra, dec, fovArcmin: FOV, scale: SCALE });
  const visits = findVisits(P, ra, dec, { fovArcmin: FOV });
  const passes = groupPasses(visits);
  console.log(`${target.name}: ${visits.length} visits, ${passes.length} passes`);
  const t0 = Date.now();
  const b0 = bytes;
  const main = await runRows(target, passes, grid, 'pass');
  const labels = { cols: BANDS.map((b) => b.id), rows: [...passes.map((p) => `${isoDate(p.start)} ${p.visits.length}`), 'ALL'] };
  const sheet = contactSheet(main.tiles, { cols: BANDS.length, labels });
  writePngRgb(new URL('sheet.png', dir), sheet);
  const out = {
    target,
    grid,
    generatedAt: new Date().toISOString(),
    notes:
      'Fluxes are 12-arcsec-radius aperture sums minus an 18-30 arcsec annulus median, with no aperture correction: compare them between passes, not with catalogues. noise is the robust spread of the same aperture placed on empty sky across the field.',
    offsetSign: 'offsetArcsec = measured centroid minus predicted position, [east, north] in arcsec',
    passes: main.rows,
  };
  // Long passes (spots seen continuously near the ecliptic poles): 30-day bins too.
  if (passes.some((p) => p.end - p.start > 30)) {
    const bins = groupPasses(visits, { binDays: 30 });
    const b = await runRows(target, bins, grid, 'bin');
    writePngRgb(new URL('sheet-bins.png', dir), contactSheet(b.tiles, { cols: BANDS.length, labels: { cols: labels.cols, rows: [...bins.map((p) => `${isoDate(p.start)} ${p.visits.length}`), 'ALL'] } }));
    out.bins30d = b.rows;
  }
  out.totalSeconds = Math.round((Date.now() - t0) / 1000);
  out.totalMegabytes = Math.round((bytes - b0) / 1e6);
  writeFileSync(new URL('result.json', dir), JSON.stringify(out, null, 1));
  console.log(`${target.name}: done in ${out.totalSeconds}s, ${out.totalMegabytes} MB`);
}

const want = process.argv.slice(2);
const P = loadIndex();
for (const t of TARGETS) if (!want.length || want.includes(t.id)) await runTarget(P, t);
