import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BANDS, getBand, bandResponse, synthWeights, visitsForBand } from '../src/engine/bands.js';

test('the eleven bands are there, in order', () => {
  assert.deepEqual(BANDS.map((b) => b.id), ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'J', 'H', 'Ks', 'W1', 'W2']);
  for (const b of BANDS) assert.ok(b.source.length > 10 && b.lambda.length === b.response.length);
});

test('matched bands use the SVO response curves (values from tools/svo/*.dat)', () => {
  for (const id of ['J', 'H', 'Ks', 'W1', 'W2']) assert.equal(getBand(id).kind, 'rsr');
  const ks = getBand('Ks'); // peak 1.0 at 22630 A; 0.8228 at 20990 A, 0.8633 at 21060 A
  assert.equal(bandResponse(ks, 2.263), 1);
  assert.ok(Math.abs(bandResponse(ks, 2.099) - 0.8228) < 1e-4);
  assert.ok(Math.abs(bandResponse(ks, 2.1025) - (0.8228 + 0.8633) / 2) < 1e-4);
  assert.equal(bandResponse(ks, 1.85), 0);
  assert.equal(bandResponse(ks, 2.45), 0);
  // W2: peak at 49300 A, 0.97512 at 46000 A (normalised by the file's peak, which is 1).
  assert.equal(bandResponse('W2', 4.93), 1);
  assert.ok(Math.abs(bandResponse('W2', 4.6) - 0.97512) < 1e-5);
  for (const b of ['J', 'H', 'Ks', 'W1', 'W2']) assert.match(getBand(b).source, /SVO Filter Profile Service/);
});

test('a tophat band is 1 inside its edges and 0 outside', () => {
  const b = { id: 'T', kind: 'tophat', lambda: [2.028, 2.29], response: [1, 1] };
  assert.equal(bandResponse(b, 2.0285), 1);
  assert.equal(bandResponse(b, 2.0275), 0);
  assert.equal(bandResponse(b, 2.2905), 0);
});

test('an rsr band interpolates linearly and is zero outside its table', () => {
  const b = { id: 'X', kind: 'rsr', lambda: [1, 2, 3], response: [0, 1, 0.5] };
  assert.equal(bandResponse(b, 1.5), 0.5);
  assert.equal(bandResponse(b, 2.5), 0.75);
  assert.equal(bandResponse(b, 3.5), 0);
});

test('detector bands take every frame of their detector only', () => {
  const visits = [1, 2, 3, 4, 5, 6].map((det) => ({ det, y: 1020 }));
  assert.deepEqual(visitsForBand('D5', visits).map((v) => v.det), [5]);
  // J's curve spans 1.062-1.45 um. D2 runs 1.65 um (y=1) to 1.086 um (y=2040): about 1.24 um at
  // y=1400 and 1.53 um at y=300 (more than one resolution element, ~lambda/40, past the edge).
  // D1 is 0.735 um at y=2040; D3 starts at 1.616 um.
  const pick = (det, y) => visitsForBand('J', [{ det, y }]).length;
  assert.equal(pick(2, 1400), 1);
  assert.equal(pick(2, 300), 0);
  assert.equal(pick(1, 2040), 0);
  assert.equal(pick(3, 1400), 0);
});

// Synthetic photometry on made-up wavelength lists (pure maths, no sky data).
const flat = { id: 'F', kind: 'tophat', lambda: [1, 2], response: [1, 1] };
const peaked = { id: 'P', kind: 'rsr', lambda: [1, 2, 3], response: [0, 1, 0.5] };
const grid = (lo, hi, step) => {
  const out = [];
  for (let l = lo + step / 2; l < hi; l += step) out.push({ lambda: l, bandwidth: 0.06 });
  return out;
};
const photometry = (band, frames, spectrum) => {
  const { weights } = synthWeights(band, frames);
  const sw = weights.reduce((a, b) => a + b, 0);
  return weights.reduce((s, w, k) => s + w * spectrum(frames[k].lambda), 0) / sw;
};

test('synthWeights: even sampling of a flat band gives equal weights and full coverage', () => {
  const frames = grid(1, 2, 0.05).reverse(); // order must not matter
  const { weights, coverage } = synthWeights(flat, frames);
  for (const w of weights) assert.ok(Math.abs(w - 0.05) < 1e-9, `weight ${w}`);
  assert.ok(Math.abs(coverage - 1) < 1e-3);
});

test('synthWeights: doubling the sampling density in half the band does not bias the result', () => {
  for (const band of [flat, peaked]) {
    const [lo, hi] = [band.lambda[0], band.lambda.at(-1)];
    const mid = (lo + hi) / 2;
    const even = grid(lo, hi, 0.05);
    const dense = [...grid(lo, mid, 0.025), ...grid(mid, hi, 0.05)];
    for (const spectrum of [() => 3, (l) => l]) {
      const a = photometry(band, even, spectrum);
      const b = photometry(band, dense, spectrum);
      assert.ok(Math.abs(b / a - 1) < 0.02, `${band.id}: ${a} vs ${b}`);
    }
  }
  // Linear spectrum through a flat band: the mean of lambda over 1..2 um is 1.5.
  assert.ok(Math.abs(photometry(flat, [...grid(1, 1.5, 0.025), ...grid(1.5, 2, 0.05)], (l) => l) - 1.5) < 0.01);
});

test('synthWeights: a band sampled over half its width reports about half coverage', () => {
  const { coverage } = synthWeights(flat, grid(1, 1.5, 0.05));
  assert.ok(Math.abs(coverage - 0.5) < 0.05, `coverage ${coverage}`);
});

test('synthWeights: a hole in the sampling is not papered over and out-of-band frames weigh 0', () => {
  // Two frames 0.6 um apart with 0.06 um bandwidth: each cell is capped at 0.12 um.
  const { weights, coverage } = synthWeights(flat, [{ lambda: 1.2, bandwidth: 0.06 }, { lambda: 1.8, bandwidth: 0.06 }, { lambda: 2.5, bandwidth: 0.06 }]);
  assert.deepEqual(weights.map((w) => +w.toFixed(9)), [0.12, 0.12, 0]);
  assert.ok(Math.abs(coverage - 0.24) < 1e-3);
});
