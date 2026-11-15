// Stacking maths on hand-worked numbers (no sky images).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stackFrames, subtract, add, skyStats, spreadPick } from '../src/engine/stack.js';

const F = (...v) => Float32Array.from(v);

test('weighted mean per pixel, ignoring NaN', () => {
  const s = stackFrames([F(1, NaN, 2), F(3, 5, NaN)], [1, 3]);
  assert.deepEqual([...s.data], [2.5, 5, 2]);
  assert.deepEqual([...s.coverage], [2, 1, 1]);
  assert.equal(s.n, 2);
});

test('no data anywhere gives NaN and zero coverage', () => {
  const s = stackFrames([F(NaN), F(NaN)], [1, 1]);
  assert.ok(Number.isNaN(s.data[0]));
  assert.equal(s.coverage[0], 0);
});

test('with 5 or more frames one outlier (a cosmic ray) is clipped', () => {
  const s = stackFrames([F(1), F(1.2), F(0.8), F(1.1), F(0.9), F(100)], [1, 1, 1, 1, 1, 1]);
  assert.ok(Math.abs(s.data[0] - 1) < 1e-6, String(s.data[0]));
  assert.equal(s.coverage[0], 5);
});

test('with fewer than 5 frames nothing is clipped', () => {
  const s = stackFrames([F(1), F(1), F(1), F(101)], [1, 1, 1, 1]);
  assert.equal(s.data[0], 26);
});

test('frames with zero weight do not count', () => {
  const s = stackFrames([F(1), F(9)], [1, 0]);
  assert.equal(s.data[0], 1);
  assert.equal(s.n, 1);
});

test('subtract and add work pixel by pixel on the common grid', () => {
  const a = { data: F(3, NaN, 5), weight: F(1, 1, 1) };
  const b = { data: F(1, 2, NaN), weight: F(3, 1, 1) };
  assert.deepEqual([...subtract(a, b).data].map((v) => (Number.isNaN(v) ? 'nan' : v)), [2, 'nan', 'nan']);
  // add: weight-weighted mean of the stacks.
  const c = add([a, b]);
  assert.deepEqual([...c.data], [1.5, 2, 5]);
  assert.deepEqual([...c.weight], [4, 1, 1]);
});

test('skyStats: sigma-clipped median and MAD noise', () => {
  // 1..9 plus one wild value: median 5, MAD 2 -> sigma 2.9652; 1000 is clipped.
  const s = skyStats(F(1, 2, 3, 4, 5, 6, 7, 8, 9, 1000, NaN));
  assert.equal(s.median, 5);
  assert.ok(Math.abs(s.sigma - 2 * 1.4826) < 1e-9, String(s.sigma));
});

test('spreadPick keeps the subset spread most evenly in its key', () => {
  // 30 values crowded in 0..0.29 plus 10 at 1..10: 4 picks near 0, 3.3, 6.7 and 10.
  const xs = [...Array.from({ length: 30 }, (_, k) => k / 100), 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.deepEqual(spreadPick(xs, (x) => x, 4), [0, 3, 7, 10]);
  assert.equal(spreadPick(xs, (x) => x, 100), xs);
});
