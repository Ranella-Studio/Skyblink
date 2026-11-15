// Ported from Ranella-Studio/Nasa-Challenge (first version): web/src/lab/gaia-cone.js (adapted: also reads proper motions)
// Gaia DR3 stars around any spot on the sky, read in the browser from the
// copy MAST (NASA's archive at STScI) hosts on AWS Open Data: the HATS
// catalogue at s3://stpubdata/gaia/gaia_dr3/public/hats/gaia, the same files
// pipeline/bake_gaia.py reads. That bucket sends CORS headers; MAST's and
// ESA's query services do not.
//
// The catalogue is split into HEALPix partitions of Parquet files, each sorted
// by a fine HEALPix index (_healpix_29) and cut into row groups of 200,000
// stars. Only the footer of each file the cone touches, and three columns of
// the row groups whose index range holds part of the cone, are read with HTTP
// range requests: about 4.4 MB a row group.
//
// Proper motions are read too (about 3 MB more a row group), so each star can
// be moved from its Gaia 2016.0 position to the date of any frame.
import { parquetMetadataAsync, parquetRead } from 'hyparquet';
import { decompress } from 'fzstd';
import { angularDistance } from '../data/sky-math.js';

export const HATS = 'https://stpubdata.s3.amazonaws.com/gaia/gaia_dr3/public/hats/gaia';
const COLS = ['ra', 'dec', 'phot_g_mean_mag', 'pmra', 'pmdec'];
const CONE_ORDER = 10; // 3.4′ pixels, to find which row groups hold the cone
const SHIFT = BigInt(2 * (29 - CONE_ORDER)); // order-10 pixel → order-29 index range
const FOOTER = 1 << 19; // the files' footers are about 0.5 MB (153 columns)
const compressors = { ZSTD: (input, outputLength) => decompress(input, new Uint8Array(outputLength)) };

/** HEALPix NESTED pixel of (ra, dec) in degrees (Gorski et al. 2005), as bake_gaia.py. */
export function ang2pixNest(order, ra, dec) {
  const nside = 2 ** order;
  const z = Math.sin((dec * Math.PI) / 180);
  const za = Math.abs(z);
  const tt = ((((ra * Math.PI) / 180 / (Math.PI / 2)) % 4) + 4) % 4;
  let face;
  let ix;
  let iy;
  if (za <= 2 / 3) {
    const t1 = nside * (0.5 + tt);
    const t2 = nside * z * 0.75;
    const jp = Math.floor(t1 - t2);
    const jm = Math.floor(t1 + t2);
    const ifp = Math.floor(jp / nside);
    const ifm = Math.floor(jm / nside);
    face = ifp === ifm ? ifp | 4 : ifp < ifm ? ifp : ifm + 8;
    ix = jm & (nside - 1);
    iy = nside - (jp & (nside - 1)) - 1;
  } else {
    const ntt = Math.min(3, Math.floor(tt));
    const tp = tt - ntt;
    const tmp = nside * Math.sqrt(3 * (1 - za));
    const jp = Math.min(nside - 1, Math.floor(tp * tmp));
    const jm = Math.min(nside - 1, Math.floor((1 - tp) * tmp));
    if (z >= 0) [face, ix, iy] = [ntt, nside - jm - 1, nside - jp - 1];
    else [face, ix, iy] = [ntt + 8, jp, jm];
  }
  let pix = 0;
  for (let b = 0; b < order; b++) pix += (((ix >> b) & 1) * 2 ** (2 * b)) + (((iy >> b) & 1) * 2 ** (2 * b + 1));
  return face * nside * nside + pix;
}

/** The point `dist` degrees from (ra, dec) towards position angle `angle` (degrees east of north). */
function offset(ra, dec, dist, angle) {
  const R = Math.PI / 180;
  const [d, a, r0, d0] = [dist * R, angle * R, ra * R, dec * R];
  const sd = Math.sin(d0) * Math.cos(d) + Math.cos(d0) * Math.sin(d) * Math.cos(a);
  const ra2 = r0 + Math.atan2(Math.sin(a) * Math.sin(d) * Math.cos(d0), Math.cos(d) - Math.sin(d0) * sd);
  return [(((ra2 / R) % 360) + 360) % 360, Math.asin(sd) / R];
}

/** Every partition (`order/npix`) a cone touches, found by sampling its middle and edge. */
export function partitionsFor(parts, ra, dec, radius) {
  const points = [[ra, dec]];
  for (const f of [0.5, 1]) for (let a = 0; a < 360; a += 15) points.push(offset(ra, dec, radius * f, a));
  const hit = new Set();
  for (const [r, d] of points) {
    for (let order = 2; order <= 9; order++) {
      const key = `${order}/${ang2pixNest(order, r, d)}`;
      if (parts.has(key)) {
        hit.add(key);
        break;
      }
    }
  }
  return [...hit];
}

/**
 * The cone as sorted [lo, hi) ranges of _healpix_29 indices: every order-10
 * pixel holding a sample point of the cone, sampled every 1′ (a third of a
 * pixel) inside it and along its edge.
 */
export function coneRanges(ra, dec, radius) {
  const pix = new Set();
  const step = 1 / 60;
  for (let r = 0; r <= radius + 1e-9; r += step) {
    const n = Math.max(1, Math.ceil((2 * Math.PI * r) / step));
    for (let i = 0; i < n; i++) pix.add(ang2pixNest(CONE_ORDER, ...offset(ra, dec, r, (360 * i) / n)));
  }
  for (let i = 0; i < 360; i++) pix.add(ang2pixNest(CONE_ORDER, ...offset(ra, dec, radius, i)));
  const sorted = [...pix].sort((a, b) => a - b);
  const out = [];
  for (const p of sorted) {
    const lo = BigInt(p) << SHIFT;
    const hi = BigInt(p + 1) << SHIFT;
    if (out.length && out.at(-1)[1] === lo) out.at(-1)[1] = hi;
    else out.push([lo, hi]);
  }
  return out;
}

/** Whether any range overlaps the closed interval [min, max]. */
function overlaps(ranges, min, max) {
  return ranges.some(([lo, hi]) => lo <= max && hi > min);
}

/**
 * An AsyncBuffer for hyparquet that only ever makes range requests, and fails
 * rather than download a whole file (these are 100–300 MB) if the server
 * ignores the Range header.
 */
function rangeFile(url, byteLength, fetchFn, count) {
  return {
    byteLength,
    async slice(start, end = byteLength) {
      const res = await fetchFn(url, { headers: { Range: `bytes=${start}-${end - 1}` } });
      if (res.status !== 206) throw new Error(`Gaia: HTTP ${res.status} for a range request`);
      const buf = await res.arrayBuffer();
      count(buf.byteLength);
      return buf;
    },
  };
}

const sizeCache = new Map();
let partsPromise = null;

/**
 * Gaia DR3 stars (G ≤ gmax) within `radius` degrees of (ra, dec), as a set
 * { ra, dec, radius, gmax, n, stars, bytes }, stars being rows of
 * [ra, dec, pmra, pmdec, G] at epoch 2016.0 (pm in mas/yr, pmra includes cos dec; 0 where Gaia has none).
 * Errors (network, HTTP, malformed files) are thrown, never read as "no stars".
 */
export async function gaiaCone(ra, dec, radius, { gmax = 19, fetch: fetchFn = globalThis.fetch.bind(globalThis), signal } = {}) {
  let bytes = 0;
  const count = (n) => (bytes += n);
  const get = (url, init = {}) => fetchFn(url, { ...init, signal });
  if (!partsPromise) {
    partsPromise = get(`${HATS}/partition_info.csv`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`Gaia: HTTP ${r.status} for the partition list`))))
      .then((text) => new Set(text.trim().split(/\r?\n/).slice(1).map((l) => l.trim().split(',').map(Number).join('/'))))
      .catch((err) => {
        partsPromise = null;
        throw err;
      });
  }
  const parts = await partsPromise;
  const ranges = coneRanges(ra, dec, radius);
  const rows = [];
  // Partitions are read side by side; row groups within one, in turn.
  const readPartition = async (key) => {
    const [order, npix] = key.split('/').map(Number);
    const url = `${HATS}/dataset/Norder=${order}/Dir=${Math.floor(npix / 10000) * 10000}/Npix=${npix}.parquet`;
    if (!sizeCache.has(url)) {
      const head = await get(url, { method: 'HEAD' });
      const len = Number(head.headers.get('content-length'));
      if (!head.ok || !(len > 0)) throw new Error(`Gaia: HTTP ${head.status} for ${key}`);
      sizeCache.set(url, len);
    }
    const file = rangeFile(url, sizeCache.get(url), get, count);
    const metadata = await parquetMetadataAsync(file, { initialFetchSize: FOOTER });
    const names = metadata.row_groups[0].columns.map((c) => c.meta_data.path_in_schema.join('.'));
    const hp = names.indexOf('_healpix_29');
    if (hp < 0) throw new Error(`Gaia: no _healpix_29 column in ${key}`);
    let start = 0;
    for (const g of metadata.row_groups) {
      const end = start + Number(g.num_rows);
      const s = g.columns[hp].meta_data.statistics;
      const min = BigInt(s.min_value ?? s.min);
      const max = BigInt(s.max_value ?? s.max);
      if (overlaps(ranges, min, max)) {
        await parquetRead({
          file,
          metadata,
          columns: COLS,
          rowStart: start,
          rowEnd: end,
          compressors,
          onComplete: (data) => {
            for (const r of data) {
              const g = r[2];
              if (!(g <= gmax)) continue;
              if (angularDistance(ra, dec, r[0], r[1]) > radius) continue;
              rows.push([r[0], r[1], r[3] ?? 0, r[4] ?? 0, g]);
            }
          },
        });
      }
      start = end;
    }
  };
  await Promise.all(partitionsFor(parts, ra, dec, radius).map(readPartition));
  rows.sort((a, b) => a[4] - b[4]);
  const stars = new Float64Array(rows.length * 5);
  rows.forEach((r, i) => stars.set(r, i * 5));
  return { ra, dec, radius, gmax, n: rows.length, stars, bytes };
}
