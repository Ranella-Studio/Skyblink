import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGrid, gridToSky, skyToGrid } from '../src/engine/grid.js';

test('makeGrid picks the odd pixel count nearest the field', () => {
  assert.deepEqual(makeGrid({ ra: 10, dec: 20, fovArcmin: 6 }), { ra0: 10, dec0: 20, n: 121, scale: 3 });
  assert.equal(makeGrid({ ra: 0, dec: 0, fovArcmin: 6, scale: 6.15 }).n, 59); // 58.5 -> 59
  assert.equal(makeGrid({ ra: 0, dec: 0, fovArcmin: 1, scale: 3 }).n, 21); // 20 -> 21 (odd)
});

test('the centre pixel is the grid centre; row 0 is north, col 0 is east', () => {
  const g = makeGrid({ ra: 269.45, dec: 4.69, fovArcmin: 6 });
  const [ra, dec] = gridToSky(g, 60, 60);
  assert.ok(Math.abs(ra - 269.45) < 1e-12 && Math.abs(dec - 4.69) < 1e-12);
  const [, decTop] = gridToSky(g, 60, 0);
  assert.ok(Math.abs(decTop - (4.69 + (60 * 3) / 3600)) < 1e-6, 'row 0 is 180 arcsec north');
  const [raEast] = gridToSky(g, 0, 60);
  assert.ok(raEast > 269.45, 'col 0 has larger RA (east)');
});

test('skyToGrid inverts gridToSky, also near the pole and across RA 0', () => {
  for (const [ra, dec] of [[0.01, 0], [359.99, -30], [248.1675, 66.755], [10, 89.99]]) {
    const g = makeGrid({ ra, dec, fovArcmin: 10, scale: 2 });
    for (const [c, r] of [[0, 0], [g.n - 1, 0], [17.25, 250.5], [g.n - 1, g.n - 1]]) {
      const [c2, r2] = skyToGrid(g, ...gridToSky(g, c, r));
      assert.ok(Math.hypot(c2 - c, r2 - r) < 1e-6, `${ra},${dec} ${c},${r} -> ${c2},${r2}`);
    }
  }
});

test('skyToGrid returns null for the far side of the sky', () => {
  const g = makeGrid({ ra: 0, dec: 0, fovArcmin: 6 });
  assert.equal(skyToGrid(g, 180, 0), null);
});
