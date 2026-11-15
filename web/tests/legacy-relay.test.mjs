import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { relayTarget, staticFile, createApp } from '../../server/server.mjs';
import { makeGrid } from '../src/engine/grid.js';
import { loadTwomass } from '../src/engine/legacy/twomass.js';

const SIA = '/irsa/cgi-bin/2MASS/IM/nph-im_sia';
const IBE = '/irsa/ibe/data/twomass/allsky/allsky/000528n/s101/image/ji1010209.fits.gz';

test('relay allows the SIA query and rebuilds it from validated values', () => {
  assert.equal(
    relayTarget(`${SIA}?POS=269.452080,4.693390&SIZE=0.01&FORMAT=image/fits&band=J`),
    'https://irsa.ipac.caltech.edu/cgi-bin/2MASS/IM/nph-im_sia?POS=269.45208,4.69339&SIZE=0.01&FORMAT=image/fits&band=J',
  );
  assert.ok(relayTarget(`${SIA}?POS=331.043830,-56.782690&SIZE=0.5&FORMAT=image/fits&band=K`));
});

test('relay allows the IBE cutout', () => {
  assert.equal(
    relayTarget(`${IBE}?center=269.452080,4.693390&size=8arcmin&gzip=false`),
    'https://irsa.ipac.caltech.edu/ibe/data/twomass/allsky/allsky/000528n/s101/image/ji1010209.fits.gz?center=269.45208,4.69339&size=8arcmin&gzip=false',
  );
});

test('relay refuses everything else', () => {
  for (const bad of [
    `${SIA}?POS=269.45,4.69&SIZE=0.6&FORMAT=image/fits&band=J`, // too large
    `${SIA}?POS=269.45,4.69&SIZE=0&FORMAT=image/fits&band=J`,
    `${SIA}?POS=369.45,4.69&SIZE=0.01&FORMAT=image/fits&band=J`, // RA out of range
    `${SIA}?POS=269.45,94.69&SIZE=0.01&FORMAT=image/fits&band=J`,
    `${SIA}?POS=1e2,4&SIZE=0.01&FORMAT=image/fits&band=J`, // exponent form
    `${SIA}?POS=269.45,4.69&SIZE=0.01&FORMAT=image/fits&band=Ks`,
    `${SIA}?POS=269.45,4.69&SIZE=0.01&FORMAT=text/html&band=J`,
    `${SIA}?POS=269.45,4.69&SIZE=0.01&FORMAT=image/fits&band=J&band=H`, // repeated key
    `${SIA}?POS=269.45,4.69&SIZE=0.01&FORMAT=image/fits&band=J&x=1`, // extra key
    `${SIA}?POS=269.45,4.69&SIZE=0.01&FORMAT=image/fits`, // missing key
    `${IBE}?center=269.45,4.69&size=31arcmin&gzip=false`,
    `${IBE}?center=269.45,4.69&size=8deg&gzip=false`,
    `${IBE}?center=269.45,4.69&size=8arcmin&gzip=true`,
    `${IBE}?center=269.45,4.69&size=8arcmin`,
    '/irsa/ibe/data/twomass/allsky/allsky/000528n/s101/image/../../../etc/passwd?center=1,1&size=8arcmin&gzip=false',
    '/irsa/ibe/data/twomass/allsky/allsky/000528n/s101/image/ji101020.fits.gz?center=1,1&size=8arcmin&gzip=false', // 6 digits
    '/irsa/ibe/data/twomass/allsky/allsky/000528x/s101/image/ji1010209.fits.gz?center=1,1&size=8arcmin&gzip=false',
    '/irsa/ibe/data/twomass/allsky/allsky/000528n/s101/image/ji1010209.fits.gz%2F?center=1,1&size=8arcmin&gzip=false',
    '/irsa/cgi-bin/2MASS/IM/nph-im?ds=asky&name=ji1010209.fits',
    '/irsa/cgi-bin/Atlas/nph-atlas?mission=COSMOS',
    '/irsa//cgi-bin/2MASS/IM/nph-im_sia?POS=1,1&SIZE=0.01&FORMAT=image/fits&band=J',
    '/other',
  ]) {
    assert.equal(relayTarget(bad), null, bad);
  }
});

test('static files stay inside the root', () => {
  const root = fileURLToPath(new URL('../public', import.meta.url));
  assert.ok(staticFile(root, '/data/allwise-tiles.json'));
  for (const bad of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/package.json', '/data/../../package.json', '/data', '/nope.js', '/%E0%A4%A']) {
    assert.equal(staticFile(root, bad), null, bad);
  }
});

test('live: 2MASS for Barnard\'s Star through the relay on localhost, and from the baked cutouts', { skip: process.env.SKYBLINK_LIVE !== '1' && 'needs the network: set SKYBLINK_LIVE=1' }, async (t) => {
  const app = createApp({ root: fileURLToPath(new URL('../public', import.meta.url)) });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  t.after(() => app.close());
  const host = `http://127.0.0.1:${app.address().port}`;

  const health = await fetch(`${host}/health`);
  assert.equal(await health.text(), 'ok');
  assert.equal((await fetch(`${host}/irsa/cgi-bin/2MASS/IM/nph-im?x=1`)).status, 404);
  assert.equal((await fetch(`${host}/health`, { method: 'POST' })).status, 405);

  // Relay: 30 arcsec off the baked position, so the baked layer does not answer and the relay must.
  const grid = makeGrid({ ra: 269.45208, dec: 4.69339 + 30 / 3600, fovArcmin: 3 });
  const viaRelay = await loadTwomass(grid, 'J', { base: `${host}/nothing-baked-here/`, proxy: `${host}/irsa` });
  assert.ok(viaRelay.files[0].startsWith(`${host}/irsa/ibe/`), viaRelay.files[0]);
  assert.match(viaRelay.label, /^2MASS J, 28 May 2000$/);
  assert.equal(viaRelay.unit, 'MJy/sr');
  assert.ok(viaRelay.data.filter(Number.isFinite).length > 0.99 * viaRelay.data.length);

  // Baked: the shipped cutouts, served as static files, no IRSA call.
  const viaBaked = await loadTwomass(makeGrid({ ra: 269.45208, dec: 4.69339, fovArcmin: 6 }), 'Ks', { base: `${host}/`, proxy: '' });
  assert.ok(viaBaked.files[0].startsWith('https://irsa.ipac.caltech.edu/ibe/'), 'baked frame names its IRSA source');
  assert.match(viaBaked.label, /^2MASS Ks, 28 May 2000$/);
});
