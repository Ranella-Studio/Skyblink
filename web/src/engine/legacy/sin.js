// SIN (orthographic) projection, as used by the AllWISE Atlas images (CTYPE RA---SIN / DEC--SIN,
// no PV terms). Calabretta & Greisen 2002, A&A 395, 1077, sec. 5.1.5.
import { DEG, RAD } from '../../data/sky-math.js';

/** [x, y] in degrees (east = +x, north = +y) about (ra0, dec0), or null on the far hemisphere. */
export function sinProject(ra0, dec0, ra, dec) {
  const d0 = dec0 * DEG;
  const d = dec * DEG;
  const dr = (ra - ra0) * DEG;
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(dr);
  if (cosc < 0) return null;
  const x = Math.cos(d) * Math.sin(dr);
  const y = Math.sin(d) * Math.cos(d0) - Math.cos(d) * Math.sin(d0) * Math.cos(dr);
  return [x * RAD, y * RAD];
}

/** Inverse of sinProject; x, y in degrees. Returns [ra, dec] or null off the disc. */
export function sinDeproject(ra0, dec0, x, y) {
  const a = x * DEG;
  const b = y * DEG;
  const r2 = a * a + b * b;
  if (r2 > 1) return null;
  const z = Math.sqrt(1 - r2);
  const d0 = dec0 * DEG;
  const dec = Math.asin(b * Math.cos(d0) + z * Math.sin(d0));
  const ra = ra0 + Math.atan2(a, z * Math.cos(d0) - b * Math.sin(d0)) * RAD;
  return [((ra % 360) + 360) % 360, dec * RAD];
}
