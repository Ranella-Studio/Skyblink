import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitMotion, accepted, frameNoise, scatterArcsec } from '../src/app/measure.js';

const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);

test('fitMotion: 10 arcsec/yr due north over 25 years, and the line predicts an unmarked date', () => {
  const mjd0 = 51692; // 28 May 2000
  const pts = [0, 25].map((y) => ({ mjd: mjd0 + y * 365.25, ra: 269.45, dec: 4.7 + (10 * y) / 3600 }));
  const f = fitMotion(pts);
  near(f.speed, 10, 1e-9);
  near(f.pa, 0, 1e-6);
  const [ra, dec] = f.at(mjd0 + 12 * 365.25);
  near(ra, 269.45, 1e-12);
  near(dec, 4.7 + 120 / 3600, 1e-12);
});

test('fitMotion: 3 arcsec/yr due east, at Dec 60 the RA step is twice the sky step', () => {
  const pts = [0, 1, 2].map((y) => ({ mjd: 60000 + y * 365.25, ra: 100 + (6 * y) / 3600, dec: 60 }));
  const f = fitMotion(pts);
  near(f.speed, 3, 1e-6);
  near(f.pa, 90, 1e-6);
});

test('accept rule: aperture sum at least 5 times the aperture noise (pixel noise x sqrt(pixels))', () => {
  assert.equal(accepted(50, 1, 100), true); // 5 x 1 x 10 = 50
  assert.equal(accepted(49.9, 1, 100), false);
  assert.equal(accepted(NaN, 1, 100), false);
  assert.equal(accepted(30, 2, 9), true); // 5 x 2 x 3 = 30
});

test('frameNoise: MAD-based sigma ignores NaN and one bright star', () => {
  // values -1, 0, 1 repeated: median 0, MAD 1 -> 1.4826
  const d = Float32Array.from([-1, 0, 1, -1, 0, 1, -1, 0, 1, 1000, NaN]);
  near(frameNoise(d), 1.4826, 1e-6);
});

test('scatterArcsec: two points 2 arcsec apart in Dec scatter 1 arcsec about their mean', () => {
  near(scatterArcsec([{ ra: 10, dec: 0 }, { ra: 10, dec: 2 / 3600 }]), 1, 1e-9);
});
