import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { groupPasses, findVisits, passLabel } from '../src/engine/passes.js';
import { Pointings } from '../src/data/pointings.js';

// Visit stubs: only the time matters for grouping (no sky data involved).
const at = (...mjds) => mjds.map((mjd, k) => ({ mjd, det: 1, k }));

test('passes split on gaps over 12 days and keep time order', () => {
  // 2025-06-01 is MJD 60827; second group 180 days later, third 20 days after that.
  const p = groupPasses(at(60827, 60830.5, 60828, 61007, 61009, 61029));
  assert.equal(p.length, 3);
  assert.deepEqual(p.map((x) => x.visits.length), [3, 2, 1]);
  assert.equal(p[0].start, 60827);
  assert.equal(p[0].end, 60830.5);
  assert.equal(p[0].mjdMean, (60827 + 60828 + 60830.5) / 3);
  assert.equal(p[0].label, 'Jun 2025');
  assert.deepEqual(p.map((x) => x.id), [0, 1, 2]);
});

test('a continuously observed spot splits at the six-month survey boundary', () => {
  // Survey 1 starts MJD 60796, survey 2 at 60978.6: a visit every 5 days across it.
  const mjds = [];
  for (let t = 60940; t < 61020; t += 5) mjds.push(t);
  const p = groupPasses(at(...mjds));
  assert.equal(p.length, 2);
  assert.ok(p[0].end < 60978.6 && p[1].start >= 60978.6);
});

test('fixed time bins give a light curve for continuously observed spots', () => {
  const mjds = [];
  for (let t = 60800; t < 60890; t += 2) mjds.push(t); // 45 visits over 90 days
  const p = groupPasses(at(...mjds), { binDays: 30 });
  assert.deepEqual(p.map((x) => x.visits.length), [15, 15, 15]);
  assert.equal(p[1].start, 60830);
  // Empty bins are not reported.
  assert.equal(groupPasses(at(60800, 60900), { binDays: 30 }).length, 2);
});

test('passLabel is the month of the date', () => {
  assert.equal(passLabel(60796), 'May 2025'); // 2025-05-01
  assert.equal(passLabel(61041.5), 'Jan 2026'); // 2026-01-01T12 (MJD 60796 + 245 days)
});

test('every detector 1-3 hit is also returned on detector d+3, sub-exposures kept', () => {
  const dir = new URL('../public/data/', import.meta.url);
  const meta = JSON.parse(readFileSync(new URL('pointings.json', dir)));
  const bin = readFileSync(new URL('pointings.bin', dir));
  const P = new Pointings(meta, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
  const v = findVisits(P, 248.1675, 66.755, { fovArcmin: 6 });
  assert.ok(v.length > 20, `R Dra has ${v.length} visits`);
  const short = v.filter((x) => x.det <= 3);
  const long = v.filter((x) => x.det >= 4);
  assert.equal(short.length, long.length);
  for (const s of short) assert.ok(long.some((l) => l.i === s.i && l.sub === s.sub && l.det === s.det + 3));
  // More than one sub-exposure of the same pointing survives.
  const perPointing = new Map();
  for (const s of short) perPointing.set(s.i, (perPointing.get(s.i) || 0) + 1);
  assert.ok([...perPointing.values()].some((n) => n > 1));
  assert.ok(v.every((x) => x.url.startsWith('https://nasa-irsa-spherex.s3.amazonaws.com/') && x.url.includes(`/${x.det}/level2_`) && x.url.includes(`D${x.det}_spx_`)));
  // Sorted by time.
  for (let k = 1; k < v.length; k++) assert.ok(v[k].mjd >= v[k - 1].mjd);
});
