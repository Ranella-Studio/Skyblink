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

test('measure, one mark: a bright star that holds still is found in every frame and did not move', async () => {
  const { measure } = await import('../src/app/measure.js');
  const { makeGrid } = await import('../src/engine/grid.js');
  const grid = makeGrid({ ra: 76.95641, dec: 30.40141, fovArcmin: 6, scale: 3 });
  const n = grid.n;
  // A star 3 pixels wide (FWHM ~7 px) at the centre, shifted by under 1 pixel per frame, on gently varying sky.
  const frame = (dx, mjd, peak) => {
    const data = new Float32Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) data[y * n + x] = ((x * 7 + y * 13) % 5) * 0.01 + peak * Math.exp(-((x - 60 - dx) ** 2 + (y - 60) ** 2) / 18);
    return { data, mjd, unit: 'MJy/sr', band: 'W1' };
  };
  const view = [
    { id: 'allwise', source: 'allwise', status: 'ready', frame: frame(0.6, 55400, 900) },
    { id: 's0', source: 'spherex', status: 'ready', frame: frame(0, 60930, 1000) },
    { id: 's1', source: 'spherex', status: 'ready', frame: frame(-0.4, 61110, 900) },
    { id: 's2', source: 'spherex', status: 'ready', frame: frame(0.3, 61300, 650) },
  ];
  const [ra, dec] = [76.95641, 30.40141];
  const app = { tl: { grid }, view, click: { marks: new Map([['s0', { slotId: 's0', mjd: 60930, col: 60, row: 60, ra, dec }]]), positions: [], spectra: new Map() } };
  measure(app);
  assert.equal(app.click.positions.length, 4);
  assert.ok(app.click.still, 'expected "did not move"');
  // The same source 2 pixels (6″) away in one frame: that frame is left out and "did not move" is not claimed.
  view[0].frame = frame(2, 55400, 900);
  measure(app);
  assert.equal(app.click.positions.length, 3);
  assert.equal(app.click.away, 1);
  assert.equal(app.click.still, null);
});

test('trackAt: Barnard’s Star 26 years after J2000 has moved 269.4 arcsec north (10362.4 mas/yr x 26)', async () => {
  const { trackAt } = await import('../src/app/measure.js');
  const t = { ra: 269.45208, dec: 4.69339, epoch: 2000.0, pmra: 0, pmdec: 10362.4 };
  const [ra, dec] = trackAt(t, 51544.5 + 26 * 365.25);
  near(ra, 269.45208, 1e-12);
  near((dec - 4.69339) * 3600, 269.4224, 1e-6);
});
