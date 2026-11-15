// WISE 0855 cross-check: is the SPHEREx detection the brown dwarf, or a background source that was
// already there in 2010? Measures the WISE 2010 and SPHEREx W2 images at both the old and new positions.
//   NODE_USE_ENV_PROXY=1 node tools/check-wise0855.mjs   (reads NASA S3; takes about a minute)
import { readFileSync } from 'node:fs';
const R = new URL('../', import.meta.url).pathname;
const { Pointings } = await import(R + 'web/src/data/pointings.js');
const { findVisits, groupPasses } = await import(R + 'web/src/engine/passes.js');
const { makeGrid, skyToGrid } = await import(R + 'web/src/engine/grid.js');
const { passStack } = await import(R + 'web/src/engine/stack.js');
const { loadAllwise } = await import(R + 'web/src/engine/legacy/allwise.js');

const grid = makeGrid({ ra: 133.778068, dec: -7.243744, fovArcmin: 6, scale: 3 });
const t = { ra: 133.795129, dec: -7.245147, pmra: -8123.7, pmdec: 673.3, epoch: 2010.5 };
const yr = (mjd) => 2000 + (mjd - 51544.5) / 365.25;
const at = (mjd) => {
  const dt = yr(mjd) - t.epoch;
  const dec = t.dec + (t.pmdec * dt) / 3.6e6;
  return [t.ra + (t.pmra * dt) / 3.6e6 / Math.cos((t.dec * Math.PI) / 180), dec];
};
function aper(data, n, ra, dec) {
  const [c, r] = skyToGrid(grid, ra, dec);
  const rad = 12 / grid.scale, r1 = 18 / grid.scale, r2 = 30 / grid.scale;
  let sum = 0, np = 0; const ring = [];
  for (let y = Math.floor(r - r2); y <= Math.ceil(r + r2); y++) for (let x = Math.floor(c - r2); x <= Math.ceil(c + r2); x++) {
    if (x < 0 || y < 0 || x >= n || y >= n) continue;
    const d = Math.hypot(x - c, y - r), v = data[y * n + x];
    if (!Number.isFinite(v)) continue;
    if (d <= rad) { sum += v; np++; } else if (d >= r1 && d <= r2) ring.push(v);
  }
  ring.sort((a, b) => a - b);
  const bg = ring[ring.length >> 1];
  const mad = ring.map((v) => Math.abs(v - bg)).sort((a, b) => a - b)[ring.length >> 1] * 1.4826;
  const sr = (grid.scale / 206265) ** 2;
  return { mJy: +((sum - bg * np) * sr * 1e9).toFixed(3), noise_mJy: +(mad * Math.sqrt(np) * sr * 1e9).toFixed(3), col: +c.toFixed(1), row: +r.toFixed(1) };
}

const index = JSON.parse(readFileSync(R + 'web/public/data/allwise-tiles.json', 'utf8'));
const wise = await loadAllwise(grid, 'W2', { index });
const meta = JSON.parse(readFileSync(R + 'web/public/data/pointings.json', 'utf8'));
const bin = readFileSync(R + 'web/public/data/pointings.bin');
const pts = new Pointings(meta, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
const passes = groupPasses(findVisits(pts, grid.ra0, grid.dec0, { fovArcmin: 6 }));
console.log('passes', passes.map((p) => [p.label, p.visits.length]));
const p2010 = at(wise.mjd);
console.log('WISE 2010 W2 at its own (2010) position', aper(wise.data, grid.n, ...p2010));
for (const pass of passes) {
  const s = await passStack(pass, 'W2', grid);
  if (!s || !s.data) { console.log('pass empty'); continue; }
  const p = at(s.mjd);
  console.log(`\nSPHEREx pass mjd ${s.mjd.toFixed(0)} (${yr(s.mjd).toFixed(2)}), frames ${s.n}, coverage ${s.bandCoverage?.toFixed(2)}`);
  console.log('  SPHEREx at the predicted (moved) position  ', aper(s.data, grid.n, ...p));
  console.log('  WISE 2010 at that same sky position         ', aper(wise.data, grid.n, ...p));
  console.log('  SPHEREx at the 2010 position (should be empty)', aper(s.data, grid.n, ...p2010));
}
