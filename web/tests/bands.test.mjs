import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BANDS, getBand, bandWeight, bandResponse, visitsForBand } from '../src/engine/bands.js';

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

test('bandWeight is response at the frame wavelength times its bandwidth', () => {
  const t = { id: 'T', kind: 'tophat', lambda: [1.154, 1.316], response: [1, 1] };
  assert.equal(bandWeight(t, 1.2, 0.03), 0.03);
  assert.equal(bandWeight(t, 1.4, 0.03), 0);
  assert.ok(Math.abs(bandWeight('Ks', 2.099, 0.05) - 0.8228 * 0.05) < 1e-6);
});

test('an rsr band interpolates linearly and is zero outside its table', () => {
  const b = { id: 'X', kind: 'rsr', lambda: [1, 2, 3], response: [0, 1, 0.5] };
  assert.equal(bandResponse(b, 1.5), 0.5);
  assert.equal(bandResponse(b, 2.5), 0.75);
  assert.equal(bandResponse(b, 3.5), 0);
  assert.equal(bandWeight(b, 1.25, 0.1), 0.025);
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
