import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGrid, gridToSky } from '../src/engine/grid.js';
import { skyToPixel, readImage } from '../src/engine/legacy/fitsimage.js';
import { twomassMjd, loadTwomassIrsa, loadTwomass } from '../src/engine/legacy/twomass.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) < tol, `${msg}: ${a} vs ${b}`);

test('2MASS dates: yymmdd + UT -> MJD', () => {
  close(twomassMjd('000528', '10:16:50.08'), 51692 + (10 * 3600 + 16 * 60 + 50.08) / 86400, 1e-8, '2000-05-28 is MJD 51692');
  close(twomassMjd('971031'), 50752, 1e-9, '1997-10-31 is MJD 50752');
});

test('TAN header: reference pixel maps to CRVAL, CROTA2 = 90 turns north into -x', () => {
  const c = { CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', CRVAL1: 10, CRVAL2: 20, CRPIX1: 51, CRPIX2: 51, CDELT1: -1 / 3600, CDELT2: 1 / 3600 };
  const [x, y] = skyToPixel(c)(10, 20);
  close(x, 50, 1e-9, 'x');
  close(y, 50, 1e-9, 'y');
  // 10 arcsec north is 10 pixels up (+y, FITS rows run south to north).
  close(skyToPixel(c)(10, 20 + 10 / 3600)[1], 60, 1e-6, 'north = +y');
  // 10 arcsec east is 10 pixels toward -x (CDELT1 < 0).
  close(skyToPixel(c)(10 + 10 / 3600 / Math.cos((20 * Math.PI) / 180), 20)[0], 40, 1e-4, 'east = -x');
  const r = skyToPixel({ ...c, CROTA2: 90 })(10, 20 + 10 / 3600);
  close(r[0], 40, 1e-6, 'rotated x');
  close(r[1], 50, 1e-6, 'rotated y');
  // the same rotation as a CD matrix
  const cd = { ...c, CD1_1: 0, CD1_2: 1 / 3600, CD2_1: -1 / 3600, CD2_2: 0 };
  delete cd.CDELT1;
  const q = skyToPixel(cd)(10, 20 + 10 / 3600);
  close(q[0], 40, 1e-6, 'CD x');
  close(q[1], 50, 1e-6, 'CD y');
});

test('readImage decodes 16-bit integers with BSCALE, BZERO and BLANK', () => {
  const card = (s) => s.padEnd(80, ' ');
  const head = ['SIMPLE  =                    T', 'BITPIX  =                   16', 'NAXIS   =                    2', 'NAXIS1  =                    2',
    'NAXIS2  =                    1', 'BSCALE  =                  0.5', 'BZERO   =                  100', 'BLANK   =                   -1', 'END'].map(card).join('').padEnd(2880, ' ');
  const bytes = new Uint8Array(2880 * 2);
  bytes.set(new TextEncoder().encode(head));
  bytes.set([0x00, 0x08, 0xff, 0xff], 2880); // 8, -1
  const img = readImage(bytes);
  assert.equal(img.pix[0], 104);
  assert.ok(Number.isNaN(img.pix[1]));
});

test("real data: Barnard's Star in a 2MASS J cutout from IRSA sits where its proper motion puts it on that night", { skip: process.env.SKYBLINK_LIVE !== '1' && 'needs the network: set SKYBLINK_LIVE=1' }, async () => {
  // J2000 269.45208 +4.69339, proper motion -801.6, +10362.4 mas/yr; 2MASS saw it near 2000.4, ~4 arcsec north of J2000.
  const grid = makeGrid({ ra: 269.45208, dec: 4.69339, fovArcmin: 2, scale: 1 });
  const f = await loadTwomassIrsa(grid, 'J');
  assert.equal(f.unit, 'MJy/sr');
  assert.ok(f.mjd > 50600 && f.mjd < 51955, `2MASS epoch ${f.mjd}`);
  const years = (f.mjd - 51544.5) / 365.25;
  const dec = 4.69339 + (10.3624 * years) / 3600;
  const ra = 269.45208 + (-0.8016 * years) / 3600 / Math.cos((dec * Math.PI) / 180);
  const n = grid.n;
  let best = 0;
  for (let i = 1; i < f.data.length; i++) if (f.data[i] > f.data[best]) best = i;
  let sx = 0, sy = 0, sw = 0;
  // The core is saturated (J ~ 5 mag, flat top), so centroid over a 6-pixel box, not the brightest pixel.
  for (let r = -6; r <= 6; r++) for (let c = -6; c <= 6; c++) {
    const v = f.data[best + r * n + c];
    sx += v * ((best % n) + c); sy += v * (Math.floor(best / n) + r); sw += v;
  }
  const [cra, cdec] = gridToSky(grid, sx / sw, sy / sw);
  const off = Math.hypot((cra - ra) * Math.cos((dec * Math.PI) / 180), cdec - dec) * 3600;
  console.log(`Barnard 2MASS J ${f.label}: centroid ${off.toFixed(2)} arcsec from predicted`);
  assert.ok(off < 1, `centroid ${off.toFixed(2)} arcsec from predicted`);
});

test('loadTwomass gives the UI a plain message when nothing answers', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404 }); // network boundary only
  try {
    await assert.rejects(loadTwomass(makeGrid({ ra: 1, dec: 1, fovArcmin: 6 }), 'J', { base: '/', proxy: '' }), /2MASS did not answer/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
