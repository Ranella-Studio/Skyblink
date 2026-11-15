// Build web/public/data/allwise-tiles.json: every AllWISE Atlas tile id, grouped by Dec band,
// with every tile's exact centre read from its real FITS header.
// Run: node tools/build-allwise-tiles.mjs   (lists the public S3 bucket, then 18k small range reads)
import { writeFileSync } from 'node:fs';

const BUCKET = 'https://nasa-irsa-wise.s3.us-west-2.amazonaws.com';
const ROOT = 'wise/allwise/images/p3am_cdd/';

async function list(prefix, delimiter) {
  const out = [];
  let token = '';
  for (;;) {
    const q = `list-type=2&prefix=${encodeURIComponent(prefix)}&delimiter=${encodeURIComponent(delimiter)}` +
      (token ? `&continuation-token=${encodeURIComponent(token)}` : '');
    const xml = await (await fetch(`${BUCKET}/?${q}`)).text();
    for (const m of xml.matchAll(/<Prefix>([^<]*)<\/Prefix>/g)) if (m[1] !== prefix) out.push(m[1]);
    const next = xml.match(/<NextContinuationToken>([^<]*)</);
    if (!next) return out;
    token = next[1];
  }
}

async function headerCards(url) {
  const res = await fetch(url, { headers: { Range: 'bytes=0-1599' } });
  if (res.status !== 206) throw new Error(`HTTP ${res.status} for ${url}`);
  const txt = Buffer.from(await res.arrayBuffer()).toString('latin1');
  const get = (k) => Number(txt.match(new RegExp(`${k.padEnd(8)}= *([-0-9.E+]+)`))[1]);
  return { ra: get('CRVAL1'), dec: get('CRVAL2'), cd: get('CDELT1'), rot: get('CROTA2') };
}

const groups = await list(ROOT, '/');
const ids = (await Promise.all(groups.map((g) => list(g, '_ac51/'))))
  .flat()
  .map((p) => p.match(/\/(\d{4}[pm]\d{3})_ac51\/$/)[1]);
console.log(`${groups.length} groups, ${ids.length} tiles`);

const byBand = new Map();
for (const id of ids) {
  const d = id.slice(4);
  if (!byBand.has(d)) byBand.set(d, []);
  byBand.get(d).push(id.slice(0, 4));
}

// Tile centres are not exactly on the grid the ids suggest (near the poles RA is offset), so read
// CRVAL1/2 from every tile's header (first 1600 bytes each, ~18k small requests).
const bands = [];
let done = 0;
async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (next < items.length) { const k = next++; await fn(items[k]); } }));
}
for (const [d, ras] of byBand) bands.push({ d, ids: ras.sort().map((r) => r + d), ra: [], dec: [] });
const jobs = bands.flatMap((b) => b.ids.map((id, i) => [b, id, i]));
await pool(jobs, 64, async ([b, id, i]) => {
  const h = await headerCards(`${BUCKET}/${ROOT}${id.slice(0, 2)}/${id.slice(0, 4)}/${id}_ac51/${id}_ac51-w1-int-3.fits`);
  if (h.rot !== 0 || Math.abs(h.cd + 0.0003819444391411) > 1e-12) throw new Error(`unexpected WCS in ${id}`);
  b.ra[i] = h.ra;
  b.dec[i] = h.dec;
  if (++done % 2000 === 0) console.log(done);
});
for (const b of bands) {
  if (b.dec.some((x) => Math.abs(x - b.dec[0]) > 1e-6)) throw new Error(`Dec varies within band ${b.d}`);
  b.dec = b.dec[0];
  b.ras = b.ids.map((id) => id.slice(0, 4)).join('');
  b.ra = b.ra.map((x) => Math.round(x * 1e5) / 1e5);
  delete b.ids;
}
bands.sort((a, b) => a.dec - b.dec);
const total = bands.reduce((s, b) => s + b.ras.length / 4, 0);
if (total !== ids.length) throw new Error('tile count mismatch');
const out = new URL('../web/public/data/allwise-tiles.json', import.meta.url);
writeFileSync(out, JSON.stringify({ source: `${BUCKET}/${ROOT}`, built: new Date().toISOString().slice(0, 10), tiles: total, bands }));
console.log(`wrote ${bands.length} bands, ${total} tiles -> ${out.pathname}`);
