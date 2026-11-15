// Ported from Ranella-Studio/Nasa-Challenge (first version): web/src/fits/spherex.js
// Read pieces of a SPHEREx Level 2 spectral image (multi-extension FITS) straight
// from NASA's public S3 bucket with HTTP range requests.
//
// HDUs: PRIMARY, IMAGE (MJy/sr, 2040x2040 float32), FLAGS (int32 bitmask; plain in
// QR2, Rice tile-compressed per row in QR3), VARIANCE, ZODI, PSF/EPSF, WCS-WAVE
// (9x9 lookup table of central wavelength and bandwidth in microns).

import { fetchRange, fetchTail, parseHeader, dataSize, padded, beFloat32, beInt32 } from './fits.js';
import { riceDecompress } from './rice.js';
import { cachedValue, storeValue } from './range-cache.js';
import { SipWcs } from './wcs.js';

export const W = 2040;

// Where the FLAGS header can start: right after the IMAGE data (W*W float32,
// an exact number of 2880-byte blocks) for an IMAGE header of 7 or 8 blocks
// after the primary one, the two lengths seen across QR2 and QR3. The probe
// also covers the 16 KB row index of Rice-compressed FLAGS. Any other layout
// falls back to reading the FLAGS header on its own.
const PROBE_START = 23040 + W * W * 4;
const PROBE_BYTES = 16 * 2880;

// Flag bits used to reject pixels before blinking. Dead, hot and cold pixels
// are always dropped. Cosmic-ray hits, onboard errors, persistence and other
// artifacts are dropped too, except on pixels the pipeline maps to a known
// source (bit 21): bright stars carry those flags around their cores, and
// masking them would punch holes in the stars.
const HARD_FLAGS = (1 << 6) | (1 << 9) | (1 << 10) | (1 << 11);
const SOFT_FLAGS = (1 << 0) | (1 << 1) | (1 << 2) | (1 << 17) | (1 << 25) | (1 << 26) | (1 << 27);
const SOURCE_FLAG = 1 << 21;

export function isBadPixel(flag) {
  return (flag & HARD_FLAGS) !== 0 || ((flag & SOFT_FLAGS) !== 0 && (flag & SOURCE_FLAG) === 0);
}

// What each flag bit means, as the FLAGS header's MP_* keywords define them
// (bit 12, "full sample history available", says nothing about quality).
export const FLAG_BITS = [
  [0, 'transient'],
  [1, 'overflow'],
  [2, 'surError'],
  [4, 'phantom'],
  [5, 'reference'],
  [6, 'nonfunc'],
  [7, 'dichroic'],
  [9, 'missing'],
  [10, 'hot'],
  [11, 'cold'],
  [14, 'phanmiss'],
  [15, 'nonlinear'],
  [17, 'persist'],
  [19, 'outlier'],
  [21, 'source'],
];

/** The names (FLAG_BITS keys) of the bits set in `flag`. */
export const flagNames = (flag) => FLAG_BITS.filter(([b]) => flag & (1 << b)).map(([, k]) => k);

/** How many of `grid`'s pixels carry each flag, most common first: [[key, count], ...]. */
export function flagCounts(grid) {
  const n = new Map();
  for (const f of grid) if (f) for (const [b, k] of FLAG_BITS) if (f & (1 << b)) n.set(k, (n.get(k) || 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]);
}

export class SpherexFile {
  constructor(url, { signal } = {}) {
    this.url = url;
    this.signal = signal;
  }

  async open() {
    // The FLAGS header (and its row index) sits right after the 16.6 MB IMAGE
    // block, so its place depends only on how long the IMAGE header is. Ask
    // for it now, alongside the header, instead of one round trip later.
    this._probe = fetchRange(this.url, PROBE_START, PROBE_START + PROBE_BYTES - 1, { signal: this.signal }).catch(() => null);
    // The first file of each detector also reads its wavelength table (at the
    // end of the file) now, instead of after the header.
    if (!waveTables.has(waveKey(this.url))) this.waveTable().catch(() => {});
    // Primary (2880 B) + IMAGE header (8-10 blocks). Grow until END is found.
    let n = 34560;
    let bytes = await fetchRange(this.url, 0, n - 1, { signal: this.signal });
    let primary = parseHeader(bytes, 0);
    let image = primary && parseHeader(bytes, primary.end);
    while (!image && n < 200000) {
      n *= 2;
      bytes = await fetchRange(this.url, 0, n - 1, { signal: this.signal });
      primary = parseHeader(bytes, 0);
      image = primary && parseHeader(bytes, primary.end);
    }
    if (!image) throw new Error('could not parse FITS header');
    this.header = image.cards;
    this.imageStart = image.end;
    this.flagsHeaderStart = image.end + padded(dataSize(image.cards));
    this.wcs = new SipWcs(image.cards);
    this.mjd = image.cards['MJD-AVG'];
    this.dateObs = image.cards['DATE-AVG'] || image.cards['DATE-OBS'];
    this.detector = image.cards.DETECTOR;
    this.obsId = image.cards.OBSID;
    this.psfFwhm = image.cards.PSF_FWHM;
    return this;
  }

  /** IMAGE rows y0..y1 (1-based, inclusive) as Float32Array of (y1-y0+1)*W. */
  async readRows(y0, y1) {
    const a = this.imageStart + (y0 - 1) * W * 4;
    const b = this.imageStart + y1 * W * 4 - 1;
    return beFloat32(await fetchRange(this.url, a, b, { signal: this.signal }));
  }

  async flagsHeader() {
    if (!this._flags) this._flags = this._readFlagsHeader();
    return this._flags;
  }

  async _readFlagsHeader() {
    const probe = await this._probe;
    this._probe = null; // keep only what is needed below, not the whole probe
    const at = this.flagsHeaderStart - PROBE_START;
    const h = probe && at >= 0 && parseHeader(probe, at);
    if (h) {
      const flags = { cards: h.cards, dataStart: PROBE_START + h.end };
      // Rice-compressed FLAGS start with one (count, offset) pair per row:
      // 16 KB for the whole image, usually inside the probe too.
      const descEnd = h.end + (h.cards.NAXIS1 || 0) * (h.cards.NAXIS2 || 0);
      if (h.cards.ZIMAGE && descEnd <= probe.length) flags.desc = probe.slice(h.end, descEnd);
      return flags;
    }
    const bytes = await fetchRange(this.url, this.flagsHeaderStart, this.flagsHeaderStart + 23039, { signal: this.signal });
    const g = parseHeader(bytes, 0);
    if (!g) throw new Error('FLAGS header too long');
    return { cards: g.cards, dataStart: this.flagsHeaderStart + g.end };
  }

  /** FLAGS rows y0..y1 (1-based, inclusive) as Int32Array. */
  async readFlagRows(y0, y1) {
    const { cards, dataStart, desc: allDesc } = await this.flagsHeader();
    const rows = y1 - y0 + 1;
    if (!cards.ZIMAGE) {
      const a = dataStart + (y0 - 1) * W * 4;
      return beInt32(await fetchRange(this.url, a, a + rows * W * 4 - 1, { signal: this.signal }));
    }
    if (cards.ZCMPTYPE !== 'RICE_1' || cards.ZTILE2 !== 1) throw new Error(`unsupported compression ${cards.ZCMPTYPE}`);
    // Binary table of variable-length descriptors (count, heap offset), one per row.
    const rowLen = cards.NAXIS1;
    const desc = allDesc
      ? allDesc.subarray((y0 - 1) * rowLen, y1 * rowLen)
      : await fetchRange(this.url, dataStart + (y0 - 1) * rowLen, dataStart + y1 * rowLen - 1, { signal: this.signal });
    const dv = new DataView(desc.buffer, desc.byteOffset, desc.byteLength);
    const heapStart = dataStart + (cards.THEAP ?? cards.NAXIS1 * cards.NAXIS2);
    const spans = [];
    let lo = Infinity;
    let hi = -Infinity;
    for (let r = 0; r < rows; r++) {
      const count = dv.getInt32(r * rowLen, false);
      const off = dv.getInt32(r * rowLen + 4, false);
      spans.push([off, count]);
      lo = Math.min(lo, off);
      hi = Math.max(hi, off + count);
    }
    const heap = await fetchRange(this.url, heapStart + lo, heapStart + hi - 1, { signal: this.signal });
    const blocksize = cards.ZVAL1 ?? 32;
    const out = new Int32Array(rows * W);
    spans.forEach(([off, count], r) => {
      out.set(riceDecompress(heap.subarray(off - lo, off - lo + count), W, blocksize), r * W);
    });
    return out;
  }

  /** Central wavelength and bandwidth (microns) at pixel (x, y), from WCS-WAVE. */
  async wavelength(x, y) {
    this._wave = await this.waveTable();
    return lookupWave(this._wave, x, y);
  }

  /** The WCS-WAVE lookup table, read once per detector and release. */
  waveTable() {
    if (!this._wavePromise) {
      const key = waveKey(this.url);
      const shared = key && waveTables.get(key);
      if (shared) {
        // Another file's read failing (say, cancelled) is no reason to give up.
        this._wavePromise = shared.catch(() => this._readWave());
      } else {
        const own = key ? this._keptWave(key) : this._readWave();
        if (key) {
          waveTables.set(key, own);
          own.catch(() => waveTables.get(key) === own && waveTables.delete(key));
        }
        this._wavePromise = own;
      }
    }
    return this._wavePromise;
  }

  // The table as kept from an earlier visit, or read from this file and kept.
  async _keptWave(key) {
    const kept = await cachedValue(`wave/${key}`);
    if (kept?.vals?.length) return { ...kept, vals: Float32Array.from(kept.vals) };
    const table = await this._readWave();
    storeValue(`wave/${key}`, { ...table, vals: Array.from(table.vals) });
    return table;
  }

  async _readWave() {
    // The lookup table is the last HDU; its grid size differs per detector
    // (9x9 up to 13x20), but header and data each fit in one 2880-byte block.
    const tail = await fetchTail(this.url, 5760, { signal: this.signal });
    const h = parseHeader(tail, 0);
    if (!h || h.cards.EXTNAME !== 'WCS-WAVE') throw new Error('WCS-WAVE not found');
    const count = (form) => parseInt(form, 10) || 1;
    const nx = count(h.cards.TFORM1);
    const ny = count(h.cards.TFORM2);
    const dv = new DataView(tail.buffer, tail.byteOffset + h.end, h.cards.NAXIS1);
    const gx = [];
    const gy = [];
    for (let i = 0; i < nx; i++) gx.push(dv.getInt32(4 * i, false));
    for (let i = 0; i < ny; i++) gy.push(dv.getInt32(4 * (nx + i), false));
    const vals = new Float32Array(2 * nx * ny);
    for (let i = 0; i < vals.length; i++) vals[i] = dv.getFloat32(4 * (nx + ny + i), false);
    return { gx, gy, vals, nx };
  }
}

// The wavelength table is a property of the detector's filter: in 240 files
// sampled across QR2 and QR3 it was the same for every file of one detector
// in one release and pipeline version. So one table per (release, pipeline
// version, detector) is read once and shared, which saves a request (and a
// CORS preflight, since a suffix range is not a "simple" header) per frame.
const waveTables = new Map();
export function waveKey(url) {
  const m = url.match(/\/([a-z]+\d+)\/level2\/[^/]+\/[^/]*?(v\d+)[^/]*\/(\d)\//);
  return m ? `${m[1]}/${m[2]}/D${m[3]}` : null;
}

/** Central wavelength and bandwidth at (x, y) from a loaded WCS-WAVE table. */
export function lookupWave(table, x, y) {
  const { gx, gy, vals, nx } = table;
  const locate = (g, v) => {
    let i = 0;
    while (i < g.length - 2 && v > g[i + 1]) i++;
    return [i, Math.min(1, Math.max(0, (v - g[i]) / (g[i + 1] - g[i])))];
  };
  const [ix, fx] = locate(gx, x);
  const [iy, fy] = locate(gy, y);
  // VALUES has FITS dims (2, nx, ny): pair index fastest, then X, then Y.
  const at = (i, j, m) => vals[m + 2 * (i + nx * j)];
  const lerp = (m) =>
    (1 - fy) * ((1 - fx) * at(ix, iy, m) + fx * at(ix + 1, iy, m)) + fy * ((1 - fx) * at(ix, iy + 1, m) + fx * at(ix + 1, iy + 1, m));
  return { lambda: lerp(0), bandwidth: lerp(1) };
}
