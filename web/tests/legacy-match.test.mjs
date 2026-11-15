// Pure-maths inputs only (delta functions, Gaussians drawn from their formula, constants): no sky data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blurToFwhm, fluxScale, difference, normalise, toBytes } from '../src/engine/legacy/match.js';
import { clippedStats } from '../src/engine/legacy/stats.js';

const n = 41;
const frame = (data, extra = {}) => ({ source: 'allwise', band: 'W1', label: 'x', mjd: 0, mjdRange: [0, 0], data, unit: 'MJy/sr', files: [], note: '', ...extra });
const delta = () => {
  const d = new Float32Array(n * n);
  d[20 * n + 20] = 1;
  return d;
};
// FWHM of a row profile through the centre, by linear interpolation at half maximum.
function fwhmPix(data) {
  const row = Array.from({ length: n }, (_, c) => data[20 * n + c]);
  const half = row[20] / 2;
  let c = 20;
  while (row[c + 1] > half) c++;
  return 2 * (c - 20 + (row[c] - half) / (row[c] - row[c + 1]));
}

test('blurToFwhm turns a 0-width source into the requested FWHM and keeps the total flux', () => {
  // from 0 to 12 arcsec at 3 arcsec/pixel: a 4-pixel-FWHM Gaussian.
  const out = blurToFwhm(frame(delta()), 0, 12, 3);
  const total = out.data.reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(total - 1) < 1e-4, `flux ${total}`);
  const w = fwhmPix(out.data);
  assert.ok(Math.abs(w - 4) < 0.15, `fwhm ${w}`);
});

test('blurToFwhm adds in quadrature: 6.1 arcsec -> 6.5 arcsec needs only a sqrt(6.5^2-6.1^2) = 2.245 arcsec kernel', () => {
  // A Gaussian of FWHM 9 arcsec (3 pixels) drawn from its formula, taken to 15 arcsec (5 pixels).
  const s = 3 / 2.354820045;
  const g = new Float32Array(n * n).map((_, i) => Math.exp(-(((i % n) - 20) ** 2 + (Math.floor(i / n) - 20) ** 2) / (2 * s * s)));
  const w = fwhmPix(blurToFwhm(frame(g), 9, 15, 3).data);
  assert.ok(Math.abs(w - 5) < 0.15, `fwhm ${w}`);
  // Already as blurred as asked: unchanged.
  assert.deepEqual(blurToFwhm(frame(g), 9, 9, 3).data, g);
});

test('blurToFwhm ignores NaN pixels instead of spreading them', () => {
  const d = new Float32Array(n * n).fill(2);
  d[5 * n + 5] = NaN;
  const out = blurToFwhm(frame(d), 0, 9, 3).data;
  assert.ok(Number.isNaN(out[5 * n + 5]), 'no-data pixel stays no-data');
  assert.ok(Math.abs(out[5 * n + 6] - 2) < 1e-6 && Math.abs(out[0] - 2) < 1e-6, 'neighbours and edges keep the level');
});

test('fluxScale finds the ratio between two frames from pixels bright in both, ignoring outliers', () => {
  // b = 2.5 * a on a ramp of "sources", plus a pixel bright only in b (a moving object) and NaNs.
  const a = new Float32Array(n * n);
  for (let i = 0; i < a.length; i++) a[i] = i % 97 === 0 ? 10 + (i % 13) : ((i * 7919) % 101) / 1000 - 0.05;
  const b = a.map((v) => v * 2.5);
  b[3] = 500;
  a[7] = NaN;
  const s = fluxScale(frame(b), frame(a));
  assert.ok(Math.abs(s - 2.5) < 1e-3, `scale ${s}`);
  const diff = difference(frame(b), frame(a));
  assert.ok(Math.abs(diff.data[97 * 3]) < 1e-3, 'shared source cancels');
  // a[3] = (3*7919 % 101)/1000 - 0.05 = -0.028, so 500 - 2.5 * -0.028 = 500.07.
  assert.ok(Math.abs(diff.data[3] - 500.07) < 1e-3, 'object only in b remains');
  assert.ok(Number.isNaN(diff.data[7]), 'NaN in either -> NaN');
});

test('normalise gives zero median and unit MAD', () => {
  const d = Float32Array.from([1, 2, 3, 4, 100, NaN, 5, 6, 7]);
  const out = normalise(frame(d)).data;
  // median 4.5, MAD = median(|x-4.5|) = median(3.5,2.5,1.5,0.5,95.5,0.5,1.5,2.5) = 2.0
  assert.deepEqual(Array.from(out.slice(0, 5)), [-1.75, -1.25, -0.75, -0.25, 47.75]);
  assert.ok(Number.isNaN(out[5]));
});

test('toBytes: asinh stretch, 0 at or below zero, 255 at max, NaN -> 0, monotonic', () => {
  const d = Float32Array.from([-5, 0, 1, 10, 100, 1000, NaN]);
  const b = toBytes(frame(d), { soft: 1, max: 100 });
  assert.ok(b instanceof Uint8ClampedArray);
  assert.equal(b[0], 0);
  assert.equal(b[1], 0);
  // asinh(1)/asinh(100) = 0.88137/5.29834 = 0.16635 -> 42.4 -> 42
  assert.equal(b[2], 42);
  // asinh(10)/asinh(100) = 2.99822/5.29834 = 0.56588 -> 144.3 -> 144
  assert.equal(b[3], 144);
  assert.equal(b[4], 255);
  assert.equal(b[5], 255);
  assert.equal(b[6], 0);
});

test('clippedStats ignores a bright source when measuring the sky', () => {
  const d = Float32Array.from({ length: 1000 }, (_, i) => (i < 30 ? 1000 : 5 + ((i % 11) - 5) * 0.1));
  const s = clippedStats(d);
  assert.ok(Math.abs(s.median - 5) < 1e-9, `${s.median}`);
});
