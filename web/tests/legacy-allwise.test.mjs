import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeGrid, skyToGrid } from '../src/engine/grid.js';
import { findTile, tileUrl, dnToMJySr, loadAllwise } from '../src/engine/legacy/allwise.js';
import { angularDistance } from '../src/data/sky-math.js';

const index = JSON.parse(readFileSync(new URL('../public/data/allwise-tiles.json', import.meta.url)));

test('the index lists all 18,240 AllWISE Atlas tiles', () => {
  assert.equal(index.tiles, 18240);
  assert.equal(index.bands.reduce((s, b) => s + b.ra.length, 0), 18240);
});

test('findTile picks the tile with the target in it; centre values from the real FITS header', () => {
  // 0015m016 header: CRVAL1 = 1.512611, CRVAL2 = -1.514444 (read from the S3 file).
  const t = findTile(index, makeGrid({ ra: 1.5, dec: -1.5, fovArcmin: 6 }));
  assert.equal(t.id, '0015m016');
  assert.ok(Math.abs(t.ra - 1.512611) < 1e-5 && Math.abs(t.dec - -1.514444) < 1e-6);
  assert.equal(
    tileUrl(index, t.id, 'W2'),
    'https://nasa-irsa-wise.s3.us-west-2.amazonaws.com/wise/allwise/images/p3am_cdd/00/0015/0015m016_ac51/0015m016_ac51-w2-int-3.fits',
  );
});

test('near tile edges, findTile returns a tile containing the whole cutout whenever any tile does', () => {
  // Brute force over every tile in the index (no pruning), on a spread of real tile-edge positions.
  let checked = 0;
  let insideAny = 0;
  for (const b of index.bands.filter((_, i) => i % 7 === 3)) {
    for (let i = 0; i < b.ra.length; i += 11) {
      for (const [dra, ddec] of [[0.76, 0.0], [0.0, 0.765], [0.74, 0.74], [-0.77, -0.3]]) {
        const ra = (b.ra[i] + dra / Math.cos(b.dec * Math.PI / 180) + 360) % 360;
        const dec = b.dec + ddec;
        if (Math.abs(dec) > 89) continue;
        const grid = makeGrid({ ra, dec, fovArcmin: 3 });
        const t = findTile(index, grid);
        const all = findTile(index, grid, { exhaustive: true });
        checked++;
        if (all.margin >= 0) {
          insideAny++;
          assert.ok(t.margin >= 0, `(${ra.toFixed(3)}, ${dec.toFixed(3)}): picked ${t.id} margin ${t.margin}, ${all.id} fits`);
        }
        assert.ok(angularDistance(t.ra, t.dec, ra, dec) < 1.2);
      }
    }
  }
  assert.ok(checked > 100 && insideAny > 10, `${checked} checked, ${insideAny} fit in a tile`);
});

test('DN to MJy/sr: W1 MAGZP 20.5 (0015m016 header), 309.54 Jy zero point, 1.375 arcsec pixels', () => {
  // 309.54 * 10^(-0.4*20.5) Jy = 1.95307e-6 Jy per DN; pixel = (1.375/206264.806)^2 sr = 4.44376e-11 sr.
  // 1.95307e-6 / 4.44376e-11 = 43951 Jy/sr = 0.043951 MJy/sr per DN.
  assert.ok(Math.abs(dnToMJySr('W1', 20.5, 1.375) - 0.043951) < 2e-6);
  // W2: 171.787 * 10^(-0.4*19.5) = 2.72266e-6 Jy -> 0.061269 MJy/sr.
  assert.ok(Math.abs(dnToMJySr('W2', 19.5, 1.375) - 0.061269) < 2e-6);
});

test("real data: Barnard's Star in AllWISE W1 lands within 2 arcsec of its epoch-2010 position", async () => {
  // Hipparcos/Gaia-independent: J2000 position 269.45208 +4.69339, proper motion -801.6, +10362.4 mas/yr.
  // It moves 104 arcsec north in ten years, so centre the 3 arcmin field on roughly 2010.
  const grid = makeGrid({ ra: 269.4502, dec: 4.7226, fovArcmin: 3, scale: 1 });
  const f = await loadAllwise(grid, 'W1', { index });
  assert.equal(f.unit, 'MJy/sr');
  assert.ok(f.mjdRange[0] > 55197 && f.mjdRange[1] < 55562, 'observed in 2010');
  const years = (f.mjd - 51544.5) / 365.25;
  const dec = 4.69339 + (10362.4e-3 * years) / 3600;
  const ra = 269.45208 + (-801.6e-3 * years) / 3600 / Math.cos((dec * Math.PI) / 180);
  let best = 0;
  for (let i = 1; i < f.data.length; i++) if (f.data[i] > f.data[best]) best = i;
  const [cx, cy] = skyToGrid(grid, ra, dec);
  const off = Math.hypot((best % grid.n) - cx, Math.floor(best / grid.n) - cy) * grid.scale;
  assert.ok(off < 2, `brightest pixel ${off.toFixed(2)} arcsec from the 2010 position`);
  console.log(`Barnard W1 peak ${off.toFixed(2)} arcsec from the position at MJD ${f.mjd.toFixed(1)}`);
});
