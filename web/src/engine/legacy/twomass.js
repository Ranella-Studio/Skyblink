// 2MASS (1997-2001) frames on the shared grid. IRSA sends no CORS headers, so the browser tries:
//   1. a baked real cutout in public/data/2mass/ (tools/bake-2mass.mjs) if the grid centre is within 1 arcmin of one,
//   2. IRSA through a proxy prefix (VITE_IRSA_PROXY), the same SIA + IBE calls Node makes directly,
//   3. CDS hips2fits (unverified: CDS answered 404 to this build machine).
import { angularDistance } from '../../data/sky-math.js';
import { readImage, resample, maybeGunzip } from './fitsimage.js';
import { clippedStats } from './stats.js';

const IRSA = 'https://irsa.ipac.caltech.edu';
// Zero-magnitude flux densities, Cohen, Wheaton & Megeath 2003, AJ 126, 1090.
const F0 = { J: 1594, H: 1024, Ks: 666.7 };
const LETTER = { J: 'j', H: 'h', Ks: 'k' };
const ARCSEC_SR = (Math.PI / 180 / 3600) ** 2;
const env = import.meta.env || {};

/** 'yymmdd' + 'hh:mm:ss.ss' (2MASS headers) -> MJD. */
export function twomassMjd(yymmdd, ut = '00:00:00') {
  const yy = Number(yymmdd.slice(0, 2));
  const iso = `${yy < 50 ? 2000 + yy : 1900 + yy}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}T${ut.trim()}Z`;
  return Date.parse(iso) / 86400e3 + 40587;
}

async function get(url, signal, as = 'arrayBuffer') {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return as === 'text' ? res.text() : new Uint8Array(await res.arrayBuffer());
}

function assertFits(bytes, from) {
  if (String.fromCharCode(...bytes.subarray(0, 6)) !== 'SIMPLE') throw new Error(`${from} did not return FITS`);
  return bytes;
}

/**
 * Ask IRSA's 2MASS SIA which Atlas images cover (ra, dec) in `band`, best-covering first.
 * Returns [{ date, hem, scan, image, magzp, ra, dec, cutoutUrl(sizeArcmin) }]. base = IRSA or a proxy prefix.
 */
export async function irsaTwomassImages(ra, dec, band, { signal, base = IRSA } = {}) {
  const xml = await get(`${base}/cgi-bin/2MASS/IM/nph-im_sia?POS=${ra.toFixed(6)},${dec.toFixed(6)}&SIZE=0.01&FORMAT=image/fits&band=${band[0]}`, signal, 'text');
  const names = [...xml.matchAll(/<FIELD[^>]*name="([^"]+)"/g)].map((m) => m[1]);
  const rows = [...xml.matchAll(/<TR>([\s\S]*?)<\/TR>/g)].map((m) =>
    Object.fromEntries([...m[1].matchAll(/<TD>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/TD>/g)].map((t, i) => [names[i], t[1].trim()])),
  );
  return rows
    .filter((r) => r.band === band[0] && r.dataset === 'asky')
    .map((r) => {
      const [cra, cdec] = r.crval.split(/\s+/).map(Number);
      const scan = r.scan.padStart(3, '0');
      const img = r.image.padStart(4, '0');
      const file = `${r.date}${r.hem}/s${scan}/image/${LETTER[band]}i${scan}${img}.fits.gz`;
      return {
        date: r.date,
        magzp: Number(r.magzp),
        ra: cra,
        dec: cdec,
        // 512 x 1024 arcsec images, long side north-south: rank by room left around the target.
        room: Math.min(256 - Math.abs(((((ra - cra + 540) % 360) - 180) * Math.cos((dec * Math.PI) / 180)) * 3600), 512 - Math.abs(dec - cdec) * 3600),
        cutoutUrl: (size) => `${base}/ibe/data/twomass/allsky/allsky/${file}?center=${ra.toFixed(6)},${dec.toFixed(6)}&size=${size}arcmin&gzip=false`,
      };
    })
    .sort((a, b) => b.room - a.room);
}

/** Build the frame from one or more 2MASS FITS cutouts (DN, MAGZP in each header), first fills, later patch holes. */
export function twomassFrame(grid, band, cutouts) {
  let data = null;
  const dates = [];
  const files = [];
  for (const { bytes, url } of cutouts) {
    const img = readImage(bytes);
    const c = img.cards;
    const pixArcsec = Math.abs(c.CDELT1) * 3600;
    const k = (F0[band] * 10 ** (-0.4 * c.MAGZP) * 1e-6) / (pixArcsec * pixArcsec * ARCSEC_SR);
    const part = resample(grid, img);
    const sky = clippedStats(part).median;
    let used = false;
    if (!data) data = new Float32Array(part.length).fill(NaN);
    for (let i = 0; i < part.length; i++) {
      if (Number.isNaN(data[i]) && Number.isFinite(part[i])) {
        data[i] = k * (part[i] - sky);
        used = true;
      }
    }
    if (used) {
      dates.push(twomassMjd(c.UT_DATE || c.ORDATE, c.UT));
      files.push(url);
    }
  }
  if (!dates.length) throw new Error('2MASS cutouts do not cover the field');
  const first = new Date((dates[0] - 40587) * 86400e3);
  const day = first.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return {
    source: '2mass',
    band,
    label: `2MASS ${band}, ${day}`,
    mjd: dates[0],
    mjdRange: [Math.min(...dates), Math.max(...dates)],
    data,
    unit: 'MJy/sr',
    files,
    note:
      `2MASS All-Sky Atlas image${files.length > 1 ? 's' : ''} observed ${dates.map((d) => new Date((d - 40587) * 86400e3).toISOString().slice(0, 16).replace('T', ' ')).join(', ')} UTC. ` +
      `DN to MJy/sr with each image's MAGZP and ${F0[band]} Jy zero point (Cohen et al. 2003); local sky removed.`,
  };
}

/** Straight from IRSA (Node, or a browser through a CORS proxy prefix). */
export async function loadTwomassIrsa(grid, band, { signal, base = IRSA } = {}) {
  const fov = (grid.n * grid.scale) / 60;
  const size = Math.ceil(fov * 1.42 + 1); // the diagonal, so a rotated scan still covers the corners
  const images = await irsaTwomassImages(grid.ra0, grid.dec0, band, { signal, base });
  if (!images.length) throw new Error('IRSA has no 2MASS image here');
  const cutouts = [];
  for (const im of images.slice(0, 3)) {
    const url = im.cutoutUrl(size);
    cutouts.push({ url, bytes: assertFits(await maybeGunzip(await get(url, signal)), 'IRSA') });
    const f = twomassFrame(grid, band, cutouts);
    if (!f.data.some(Number.isNaN)) return f;
  }
  return twomassFrame(grid, band, cutouts);
}

/** CDS hips2fits cutout on exactly this grid (TAN, north up). hips e.g. 'CDS/P/2MASS/J', 'CDS/P/allWISE/W1'. */
export async function loadHips(grid, hips, { signal } = {}) {
  const fov = (grid.n * grid.scale) / 3600;
  const url =
    `https://alasky.cds.unistra.fr/hips-image-services/hips2fits?hips=${encodeURIComponent(hips)}` +
    `&width=${grid.n}&height=${grid.n}&fov=${fov}&projection=TAN&coordsys=icrs&ra=${grid.ra0}&dec=${grid.dec0}&rotation_angle=0&format=fits`;
  const img = readImage(assertFits(await get(url, signal), 'CDS hips2fits'));
  const data = resample(grid, img);
  const sky = clippedStats(data).median;
  for (let i = 0; i < data.length; i++) data[i] -= sky;
  return { data, url, cards: img.cards };
}

/** AllWISE via hips2fits: a cross-check path for loadAllwise (relative units, epoch from the survey). */
export async function loadAllwiseHips(grid, band, { signal } = {}) {
  const { data, url } = await loadHips(grid, `CDS/P/allWISE/${band}`, { signal });
  return { source: 'allwise', band, label: `AllWISE ${band}, 2010 (HiPS)`, mjd: 55400, mjdRange: [55197, 55562], data, unit: 'relative', files: [url],
    note: 'CDS HiPS of the AllWISE Atlas; not flux calibrated here; epoch is the 2010 survey year, not this tile\'s dates.' };
}

const bakedIndex = new Map();
async function baked(grid, band, signal, base) {
  if (!bakedIndex.has(base)) {
    const p = fetch(`${base}data/2mass/index.json`).then((r) => (r.ok ? r.json() : { entries: [] }));
    p.catch(() => bakedIndex.delete(base)); // a network failure is retried next time
    bakedIndex.set(base, p);
  }
  const hit = (await bakedIndex.get(base)).entries.find((e) => e.band === band && angularDistance(e.ra, e.dec, grid.ra0, grid.dec0) < 1 / 60);
  if (!hit) return null;
  const cutouts = await Promise.all(hit.files.map(async (f) => ({ url: f.source, bytes: assertFits(await get(`${base}data/2mass/${f.file}`, signal), 'baked 2MASS') })));
  return twomassFrame(grid, band, cutouts);
}

/** 2MASS J, H or Ks on the grid: baked cutout, then IRSA proxy, then CDS hips2fits. */
export async function loadTwomass(grid, band, { signal, base = env.BASE_URL ?? '/', proxy = env.VITE_IRSA_PROXY } = {}) {
  if (!F0[band]) throw new Error(`2MASS band must be J, H or Ks, not ${band}`);
  const errors = [];
  try {
    const f = await baked(grid, band, signal, base);
    if (f) return f;
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    errors.push(`baked: ${e.message}`);
  }
  if (proxy) {
    try {
      return await loadTwomassIrsa(grid, band, { signal, base: proxy.replace(/\/$/, '') });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      errors.push(`IRSA proxy: ${e.message}`);
    }
  }
  try {
    const { data, url } = await loadHips(grid, `CDS/P/2MASS/${band[0]}`, { signal });
    return { source: '2mass', band, label: '2MASS, 1997 to 2001', mjd: 51360, mjdRange: [50600, 51955], data, unit: 'relative', files: [url],
      note: 'CDS HiPS of 2MASS: the exact observation date is not in the cutout (2MASS observed 1997 to 2001; mjd is mid-1999). Not flux calibrated.' };
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    errors.push(`CDS: ${e.message}`);
  }
  throw Object.assign(new Error('2MASS did not answer'), { details: errors });
}

