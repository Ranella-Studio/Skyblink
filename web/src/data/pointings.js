// Ported from Ranella-Studio/Nasa-Challenge (first version): web/src/data/pointings.js
// SPHEREx pointing index: one row per pointing, built by pipeline/build_index.py
// from the FITS headers of NASA's public Level 2 images (IRSA S3 archive).
//
// Geometry model: each pointing stores the detector-1 TAN WCS of its first
// sub-exposure. Detectors 2 and 3 sit at fixed offsets in detector-1 pixel
// coordinates (rigid focal plane), and each later sub-exposure is shifted by
// SUB_STEP pixels. Detectors 4-6 see the same sky as 1-3 through a dichroic.

import { DEG, RAD, tanProject, tanDeproject, radecToVec } from './sky-math.js';

export const S3 = 'https://nasa-irsa-spherex.s3.amazonaws.com/';
export const DET_SIZE = 2040;
export const CRPIX = 1020.5;
// Measured from real headers: sub-exposure s is offset by (s-1) * SUB_STEP in D1 pixels.
export const SUB_STEP = [2.5, 115.2];

let cache;

export async function loadPointings(base = import.meta.env.BASE_URL) {
  if (cache) return cache;
  // Nothing shows before the index is in, so it goes ahead of other downloads
  // (index.html preloads the same two requests with the same priority).
  const get = (url, kind) =>
    fetch(url, { priority: 'high' }).then((r) => {
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return r[kind]();
    });
  cache = (async () => {
    // The packed copy is about half the size; the plain one is the fallback
    // (an older deploy, or a browser without DecompressionStream).
    const bin = () => get(`${base}data/pointings.bin`, 'arrayBuffer');
    const packed = typeof DecompressionStream === 'function' ? get(`${base}data/pointings.pack`, 'arrayBuffer').catch(() => null) : null;
    const plain = packed ? null : bin();
    const meta = await get(`${base}data/pointings.json`, 'json');
    const pack = await packed;
    if (pack) {
      try {
        return new Pointings(meta, await unpack(pack, meta));
      } catch {
        // Damaged or from another deploy: read the plain copy instead.
      }
    }
    return new Pointings(meta, await (plain || bin()));
  })();
  // A failed load (offline, mid-deploy) can be retried later.
  cache.catch(() => (cache = null));
  return cache;
}

const WIDTH = { f4: 4, 'i2x4': 2, u2: 2, u1: 1 };

/**
 * pointings.pack -> the bytes of pointings.bin. The pack is gzip over the
 * same columns with each column byte-shuffled (byte 0 of every value, then
 * byte 1, ...), which pipeline/build_index.py writes.
 */
export async function unpack(pack, meta) {
  const head = new Uint8Array(pack, 0, 2);
  // A server that already decoded it (Content-Encoding) hands over raw bytes.
  const bytes =
    head[0] === 0x1f && head[1] === 0x8b
      ? new Uint8Array(await new Response(new Blob([pack]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
      : new Uint8Array(pack);
  const n = meta.count;
  if (bytes.length !== 25 * n) throw new Error('pointings.pack does not match pointings.json');
  const out = new Uint8Array(bytes.length);
  for (const c of meta.columns) {
    const w = WIDTH[c.type];
    const count = c.type === 'i2x4' ? 4 * n : n;
    for (let k = 0; k < w; k++) {
      const src = c.offset + k * count;
      for (let i = 0, d = c.offset + k; i < count; i++, d += w) out[d] = bytes[src + i];
    }
  }
  return out.buffer;
}

/** The archive release a folder or file URL belongs to, e.g. 'DR1' or 'QR3' ('' when it names none). */
export function releaseName(path) {
  const m = /(?:^|\/)([a-z]+\d+)\/level2\//.exec(path);
  return m ? m[1].toUpperCase() : '';
}

// Archive folder names become file URLs: accept only the archive's own shape
// (any release: qr2, qr3, and later ones the index builder finds).
const FOLDER_RE = /^[a-z]+\d+\/level2\/\d{4}W\d{2}_\w{2}\/[\w.-]+$/;

export class Pointings {
  constructor(meta, buf) {
    const n = meta?.count;
    const ok =
      Number.isInteger(n) &&
      n > 0 &&
      buf.byteLength === 25 * n &&
      Array.isArray(meta.folders) &&
      meta.folders.every((f) => typeof f === 'string' && FOLDER_RE.test(f)) &&
      meta.detectors?.['2'] &&
      meta.detectors?.['3'] &&
      meta.columns?.every((c) => Number.isInteger(c.offset) && c.offset >= 0 && c.offset <= buf.byteLength);
    if (!ok) throw new Error('The SPHEREx pointing index is damaged.');
    this.meta = meta;
    this.count = n;
    const col = Object.fromEntries(meta.columns.map((c) => [c.name, c.offset]));
    const f32 = (o) => new Float32Array(buf.slice(o, o + 4 * n));
    this.t = f32(col.t); // days since meta.mjd0
    this.ra = f32(col.ra);
    this.dec = f32(col.dec);
    const pc = new Int16Array(buf.slice(col.pc, col.pc + 8 * n));
    this.pc = new Float32Array(4 * n);
    for (let i = 0; i < 4 * n; i++) this.pc[i] = pc[i] * meta.pcScale;
    this.folder = new Uint16Array(buf.slice(col.folder, col.folder + 2 * n));
    if (this.folder.some((k) => k >= meta.folders.length)) throw new Error('The SPHEREx pointing index is damaged.');
    this.exp = new Uint16Array(buf.slice(col.exp, col.exp + 2 * n));
    this.mask = new Uint8Array(buf.slice(col.mask, col.mask + n));
    this.mjd0 = meta.mjd0;
    // Detector centers in D1 pixel coordinates (1-based FITS convention).
    this.detCenter = {
      1: [CRPIX, CRPIX],
      2: [meta.detectors['2'].x, meta.detectors['2'].y],
      3: [meta.detectors['3'].x, meta.detectors['3'].y],
    };
    // Unit vectors of pointing centers, for fast angular prefilters.
    this.vec = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) {
      const v = radecToVec(this.ra[i], this.dec[i]);
      this.vec.set(v, 3 * i);
    }
  }

  mjd(i) {
    return this.t[i] + this.mjd0;
  }

  date(i) {
    return mjdToDate(this.mjd(i));
  }

  /** D1 pixel (1-based) -> [ra, dec] using the stored TAN WCS (no SIP; ~1 px). */
  pixelToSky(i, x, y) {
    const p = this.pc.subarray(4 * i, 4 * i + 4);
    const dx = x - CRPIX;
    const dy = y - CRPIX;
    const xi = p[0] * dx + p[1] * dy;
    const eta = p[2] * dx + p[3] * dy;
    return tanDeproject(this.ra[i], this.dec[i], xi, eta);
  }

  /** [ra, dec] -> D1 pixel (1-based), or null if on the far hemisphere. */
  skyToPixel(i, ra, dec) {
    const pr = tanProject(this.ra[i], this.dec[i], ra, dec);
    if (!pr) return null;
    const [xi, eta] = pr;
    const p = this.pc.subarray(4 * i, 4 * i + 4);
    const det = p[0] * p[3] - p[1] * p[2];
    return [(p[3] * xi - p[1] * eta) / det + CRPIX, (-p[2] * xi + p[0] * eta) / det + CRPIX];
  }

  /**
   * The index stores the WCS of the first sub-exposure that exists for each
   * pointing (the lowest bit of its mask), not always sub-exposure 1.
   */
  firstSub(i) {
    const m = this.mask[i];
    return m ? 32 - Math.clz32(m & -m) : 1;
  }

  /** Sky corners [[ra,dec] x4] of detector d (1-3) for sub-exposure s (1-4). */
  corners(i, d = 1, s = this.firstSub(i)) {
    const [cx, cy] = this.detCenter[d];
    const s0 = this.firstSub(i);
    const ox = cx + (s - s0) * SUB_STEP[0];
    const oy = cy + (s - s0) * SUB_STEP[1];
    const h = DET_SIZE / 2;
    return [
      [ox - h, oy - h],
      [ox + h, oy - h],
      [ox + h, oy + h],
      [ox - h, oy + h],
    ].map(([x, y]) => this.pixelToSky(i, x, y));
  }

  /** The releases the index's pointings come from, most pointings first: ['DR1', 'QR3', 'QR2']. */
  releases() {
    const n = new Map();
    for (let i = 0; i < this.count; i++) n.set(this.folder[i], (n.get(this.folder[i]) || 0) + 1);
    const by = new Map();
    for (const [k, c] of n) {
      const r = releaseName(this.meta.folders[k]);
      if (r) by.set(r, (by.get(r) || 0) + c);
    }
    return [...by].sort((a, b) => b[1] - a[1]).map(([r]) => r);
  }

  /** S3 key of the Level 2 file for pointing i, detector det (1-6), sub-exposure s. */
  fileKey(i, det, s, folder = this.meta.folders[this.folder[i]]) {
    const parts = folder.split('/');
    const weekseg = parts[2];
    const ver = parts[3];
    const exp = String(this.exp[i]).padStart(4, '0');
    return `${folder}/${det}/level2_${weekseg}_${exp}_${s}D${det}_spx_${ver}.fits`;
  }

  /**
   * Where the file may be, most likely first. The index records the folder of
   * each pointing's detector 1 file, but NASA sometimes files the other
   * detectors of the same exposure under a sibling processing folder of the
   * same week (2025W39_2A exposure 0219: D1 in l2b-v20-2025-274, D2 and D3 in
   * -273), so those folders come next.
   */
  fileUrls(i, det, s) {
    const own = this.meta.folders[this.folder[i]];
    const week = own.slice(0, own.lastIndexOf('/') + 1);
    const siblings = this.meta.folders.filter((f) => f !== own && f.startsWith(week));
    // Last, the same week in the archive's other releases: an exposure NASA
    // reprocessed for a data release (DR1) is still there as its quick-release
    // copy (QR2) for a while, so a file missing from one may be in the other.
    const [release, , weekseg] = own.split('/');
    const elsewhere = this.meta.folders.filter((f) => !f.startsWith(`${release}/`) && f.split('/')[2] === weekseg);
    return [own, ...siblings, ...elsewhere].map((f) => S3 + this.fileKey(i, det, s, f));
  }

  obsId(i, s = 1) {
    const weekseg = this.meta.folders[this.folder[i]].split('/')[2];
    return `${weekseg}_${String(this.exp[i]).padStart(4, '0')}_${s}`;
  }

  /**
   * Every sub-exposure whose detector footprint contains (ra, dec).
   * `track` optionally maps mjd -> [ra, dec] for moving targets.
   * Returns [{i, det, sub, x, y, mjd}] with approximate D(det) pixel coords.
   */
  findVisits(ra, dec, { margin = 24, track = null, tMin = -Infinity, tMax = Infinity } = {}) {
    const out = [];
    const cosLimit = Math.cos(11 * DEG);
    let v = radecToVec(ra, dec);
    for (let i = 0; i < this.count; i++) {
      const mjd = this.t[i] + this.mjd0;
      if (mjd < tMin || mjd > tMax) continue;
      let tra = ra;
      let tdec = dec;
      if (track) {
        const p = track(mjd);
        if (!p) continue;
        [tra, tdec] = p;
        v = radecToVec(tra, tdec);
      }
      const dot = v[0] * this.vec[3 * i] + v[1] * this.vec[3 * i + 1] + v[2] * this.vec[3 * i + 2];
      if (dot < cosLimit) continue;
      const px = this.skyToPixel(i, tra, tdec);
      if (!px) continue;
      const s0 = this.firstSub(i);
      for (let d = 1; d <= 3; d++) {
        const [cx, cy] = this.detCenter[d];
        for (let s = 1; s <= 4; s++) {
          if (!(this.mask[i] & (1 << (s - 1)))) continue;
          const x = px[0] - (cx - CRPIX) - (s - s0) * SUB_STEP[0];
          const y = px[1] - (cy - CRPIX) - (s - s0) * SUB_STEP[1];
          if (x > margin && x < DET_SIZE - margin && y > margin && y < DET_SIZE - margin) {
            out.push({ i, det: d, sub: s, x, y, mjd, ra: tra, dec: tdec });
          }
        }
      }
    }
    return out;
  }
}

export function mjdToDate(mjd) {
  return new Date((mjd - 40587) * 86400000);
}

export function dateToMjd(date) {
  return date.getTime() / 86400000 + 40587;
}

export { DEG, RAD };
