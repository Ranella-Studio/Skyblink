// Gaia DR3 stars for the field, moved to any date by their proper motions.

import { gaiaCone } from './gaia-cone.js';
import { angularDistance } from '../data/sky-math.js';

const GAIA_EPOCH_MJD = 57388.5; // 2016.0 (TCB, close enough at this scale)

/** Stars around the field: [{ ra, dec, pmra, pmdec, g }] at 2016.0, pm in mas/yr. */
export async function loadGaia(ra, dec, fovArcmin, { signal, gmax = 19 } = {}) {
  // Half-diagonal of the field plus 5 arcmin, so fast stars that are in the field at some date are kept.
  const radius = (fovArcmin * Math.SQRT2) / 120 + 5 / 60;
  const cone = await gaiaCone(ra, dec, radius, { gmax, signal });
  const out = [];
  for (let i = 0; i < cone.n; i++) {
    const [r, d, pmra, pmdec, g] = cone.stars.subarray(i * 5, i * 5 + 5);
    out.push({ ra: r, dec: d, pmra, pmdec, g });
  }
  return out;
}

/** [ra, dec] of a star at an MJD (linear, fine for a few decades). */
export function starAt(s, mjd) {
  const yr = (mjd - GAIA_EPOCH_MJD) / 365.25;
  const dec = s.dec + (s.pmdec * yr) / 3.6e6;
  return [s.ra + (s.pmra * yr) / 3.6e6 / Math.cos((s.dec * Math.PI) / 180), dec];
}

/** Total proper motion in arcsec/yr. */
export const totalPm = (s) => Math.hypot(s.pmra, s.pmdec) / 1000;

/** The Gaia star nearest (ra, dec) at `mjd` within `maxArcsec`, or null. */
export function matchStar(stars, ra, dec, mjd, maxArcsec = 12) {
  let best = null;
  let bd = maxArcsec / 3600;
  for (const s of stars) {
    const [r, d] = starAt(s, mjd);
    const sep = angularDistance(ra, dec, r, d);
    if (sep < bd) [best, bd] = [s, sep];
  }
  return best && { star: best, sepArcsec: bd * 3600 };
}
