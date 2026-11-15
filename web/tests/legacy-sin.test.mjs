import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sinProject, sinDeproject } from '../src/engine/legacy/sin.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) < tol, `${msg}: ${a} vs ${b}`);

test('SIN (orthographic) gives direction cosines, not tangents', () => {
  // About (0, 0): a point 30 deg east projects to sin(30 deg) = 0.5 rad = 28.6479 deg (TAN would give 33.08).
  const [x, y] = sinProject(0, 0, 30, 0);
  close(x, 28.64788976, 1e-7, 'x');
  close(y, 0, 1e-12, 'y');
  // 90 deg east lands on the rim: 1 rad = 57.29578 deg.
  close(sinProject(0, 0, 90, 0)[0], 57.29577951, 1e-7, 'rim');
  // North is +y.
  close(sinProject(0, 0, 0, 30)[1], 28.64788976, 1e-7, 'north');
});

test('off-equator: a point on the reference meridian 1 deg north', () => {
  // y = sin(d)cos(d0) - cos(d)sin(d0) = sin(d - d0) = sin(1 deg) -> 0.99994923 deg; x = 0.
  const [x, y] = sinProject(120, 60, 120, 61);
  close(x, 0, 1e-12, 'x');
  close(y, 0.99994923, 1e-8, 'y');
});

test('project then deproject returns the start, near and far from the reference, across RA 0', () => {
  for (const [ra0, dec0, ra, dec] of [
    [1.512611, -1.514444, 0.9, -2.2],
    [359.6, 4.69, 0.3, 5.4],
    [269.45, 4.69, 269.45208, 4.69339],
    [10, 89.35, 190, 88.9],
    [331.04, -56.78, 333.0, -57.5],
  ]) {
    const [x, y] = sinProject(ra0, dec0, ra, dec);
    const [r, d] = sinDeproject(ra0, dec0, x, y);
    close(((r - ra + 540) % 360) - 180, 0, 1e-9, 'ra');
    close(d, dec, 1e-9, 'dec');
  }
});

test('the far hemisphere and points off the disc have no projection', () => {
  assert.equal(sinProject(0, 0, 180, 0), null);
  assert.equal(sinDeproject(0, 0, 60, 0), null); // 60 deg > 1 rad radius
});
