// Bake real 2MASS J/H/Ks Atlas cutouts (IRSA SIA + IBE) for the challenge targets into web/public/data/2mass/,
// because IRSA sends no CORS headers and CDS hips2fits is down. Run: NODE_USE_ENV_PROXY=1 node tools/bake-2mass.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { makeGrid } from '../web/src/engine/grid.js';
import { irsaTwomassImages, twomassFrame, twomassMjd } from '../web/src/engine/legacy/twomass.js';
import { readImage } from '../web/src/engine/legacy/fitsimage.js';

const TARGETS = [
  { id: 'barnards-star', ra: 269.45208, dec: 4.69339 },
  { id: 'eps-indi-b', ra: 331.04383, dec: -56.78269 },
  { id: 'wise-0855', ra: 133.795129, dec: -7.245147 },
  { id: 'rw-aur', ra: 76.95642, dec: 30.40136 },
  { id: 'r-dra', ra: 248.1675, dec: 66.755 },
];
const SIZE = 8; // arcmin, so a 6 arcmin view at any position angle is covered

const dir = new URL('../web/public/data/2mass/', import.meta.url);
mkdirSync(dir, { recursive: true });
const entries = [];
for (const t of TARGETS) {
  const grid = makeGrid({ ra: t.ra, dec: t.dec, fovArcmin: 6, scale: 3 });
  for (const band of ['J', 'H', 'Ks']) {
    const images = await irsaTwomassImages(t.ra, t.dec, band);
    const cutouts = [];
    let holes = grid.n * grid.n;
    // Keep an image only if it fills pixels the earlier ones left empty (scan edges, clipped cutouts).
    for (const im of images.slice(0, 8)) {
      const url = im.cutoutUrl(SIZE);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      const next = [...cutouts, { url, bytes: new Uint8Array(await res.arrayBuffer()) }];
      const left = twomassFrame(grid, band, next).data.filter(Number.isNaN).length;
      if (left < holes) {
        cutouts.push(next.at(-1));
        holes = left;
      }
      if (!holes) break;
    }
    const files = cutouts.map((c, k) => {
      const file = `${t.id}-${band}-${k}.fits`;
      writeFileSync(new URL(file, dir), c.bytes);
      const h = readImage(c.bytes).cards;
      return { file, source: c.url, date: h.UT_DATE.trim(), ut: h.UT, mjd: twomassMjd(h.UT_DATE, h.UT), magzp: h.MAGZP };
    });
    const f = twomassFrame(grid, band, cutouts);
    entries.push({ id: t.id, ra: t.ra, dec: t.dec, band, sizeArcmin: SIZE, mjd: f.mjd, label: f.label, files });
    console.log(`${t.id} ${band}: ${f.label}, ${files.length} file(s), ${holes} empty pixels on the 6' grid`);
  }
}
writeFileSync(
  new URL('index.json', dir),
  JSON.stringify({ about: 'Real 2MASS All-Sky Atlas cutouts from IRSA (SIA + IBE), baked by tools/bake-2mass.mjs', built: new Date().toISOString().slice(0, 10), entries }, null, 1),
);
