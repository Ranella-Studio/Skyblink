// Bake real 2MASS J/H/Ks Atlas cutouts (IRSA SIA + IBE) for the challenge targets into web/public/data/2mass/,
// because IRSA sends no CORS headers and CDS hips2fits is down. Run: NODE_USE_ENV_PROXY=1 node tools/bake-2mass.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { makeGrid } from '../web/src/engine/grid.js';
import { irsaTwomassImages, twomassFrame, twomassMjd } from '../web/src/engine/legacy/twomass.js';
import { readImage } from '../web/src/engine/legacy/fitsimage.js';
import { TARGETS } from '../web/src/app/state.js'; // the same field centres the missions open on

const SIZE = 10; // arcmin: a 6 arcmin view (half-diagonal 4.24') fits with 0.76' to spare for small pans

const dir = new URL('../web/public/data/2mass/', import.meta.url);
mkdirSync(dir, { recursive: true });
const entries = [];
for (const t of TARGETS) {
  const grid = makeGrid({ ra: t.ra, dec: t.dec, fovArcmin: t.fov, scale: 3 });
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
    console.log(`${t.id} ${band}: ${f.label}, ${files.length} file(s), ${holes} empty pixels on the ${t.fov}' grid`);
  }
}
writeFileSync(
  new URL('index.json', dir),
  JSON.stringify({ about: 'Real 2MASS All-Sky Atlas cutouts from IRSA (SIA + IBE), baked by tools/bake-2mass.mjs', built: new Date().toISOString().slice(0, 10), entries }, null, 1),
);
