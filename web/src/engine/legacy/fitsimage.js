// A whole small FITS image in memory (a cutout service's answer, a 2MASS Atlas image):
// decode any BITPIX, map sky -> pixel for TAN or SIN with CDELT/CROTA2, PC or CD, resample onto a grid.
import { parseHeader, dataSize } from '../../fits/fits.js';
import { tanProject } from '../../data/sky-math.js';
import { gridToSky } from '../grid.js';
import { sinProject } from './sin.js';

/** Primary image of a FITS file -> { cards, width, height, pix } (pix in FITS order: row 0 = FITS row 1). */
export function readImage(bytes) {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) throw new Error('FITS is gzipped; gunzip first');
  const h = parseHeader(bytes, 0);
  if (!h) throw new Error('no FITS header');
  const c = h.cards;
  const width = c.NAXIS1;
  const height = c.NAXIS2;
  const size = width * height;
  if (bytes.length < h.end + dataSize(c)) throw new Error('FITS data truncated');
  const view = new DataView(bytes.buffer, bytes.byteOffset + h.end);
  const read = {
    8: (i) => view.getUint8(i),
    16: (i) => view.getInt16(i * 2),
    32: (i) => view.getInt32(i * 4),
    '-32': (i) => view.getFloat32(i * 4),
    '-64': (i) => view.getFloat64(i * 8),
  }[c.BITPIX];
  if (!read) throw new Error(`BITPIX ${c.BITPIX} not supported`);
  const scale = c.BSCALE ?? 1;
  const zero = c.BZERO ?? 0;
  const blank = c.BITPIX > 0 ? c.BLANK : undefined;
  const pix = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const raw = read(i);
    pix[i] = raw === blank ? NaN : zero + scale * raw;
  }
  return { cards: c, width, height, pix };
}

/** sky -> 0-based fractional pixel [x, y] for a TAN or SIN header, or null. */
export function skyToPixel(c) {
  const proj = { TAN: tanProject, SIN: sinProject }[String(c.CTYPE1).slice(-3)];
  if (!proj || String(c.CTYPE1).slice(0, 4) !== 'RA--' || String(c.CTYPE2).slice(0, 4) !== 'DEC-') {
    throw new Error(`projection ${c.CTYPE1}/${c.CTYPE2} not supported`);
  }
  let m; // CD matrix: [x, y] (deg) = m * (p - crpix)
  if (c.CD1_1 !== undefined) m = [c.CD1_1, c.CD1_2 ?? 0, c.CD2_1 ?? 0, c.CD2_2];
  else if (c.PC1_1 !== undefined) m = [c.CDELT1 * c.PC1_1, c.CDELT1 * (c.PC1_2 ?? 0), c.CDELT2 * (c.PC2_1 ?? 0), c.CDELT2 * c.PC2_2];
  else {
    const r = ((c.CROTA2 ?? 0) * Math.PI) / 180;
    m = [c.CDELT1 * Math.cos(r), -c.CDELT2 * Math.sin(r), c.CDELT1 * Math.sin(r), c.CDELT2 * Math.cos(r)];
  }
  const det = m[0] * m[3] - m[1] * m[2];
  return (ra, dec) => {
    const p = proj(c.CRVAL1, c.CRVAL2, ra, dec);
    if (!p) return null;
    return [c.CRPIX1 - 1 + (m[3] * p[0] - m[1] * p[1]) / det, c.CRPIX2 - 1 + (-m[2] * p[0] + m[0] * p[1]) / det];
  };
}

/** Bilinear resample of an image onto the grid; NaN off the image. */
export function resample(grid, { cards, width, height, pix }) {
  const toPix = skyToPixel(cards);
  const n = grid.n;
  const out = new Float32Array(n * n);
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const p = toPix(...gridToSky(grid, col, row));
      const x0 = p ? Math.floor(p[0]) : -1;
      const y0 = p ? Math.floor(p[1]) : -1;
      if (x0 < 0 || y0 < 0 || x0 + 1 >= width || y0 + 1 >= height) {
        out[row * n + col] = NaN;
        continue;
      }
      const tx = p[0] - x0;
      const ty = p[1] - y0;
      const a = y0 * width + x0;
      out[row * n + col] = (1 - ty) * ((1 - tx) * pix[a] + tx * pix[a + 1]) + ty * ((1 - tx) * pix[a + width] + tx * pix[a + width + 1]);
    }
  }
  return out;
}

/** Gunzip if the bytes are gzipped (works in browsers and Node 18+). */
export async function maybeGunzip(bytes) {
  if (!(bytes[0] === 0x1f && bytes[1] === 0x8b)) return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
