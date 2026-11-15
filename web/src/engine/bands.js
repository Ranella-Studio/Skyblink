// Ported from Ranella-Studio/Nasa-Challenge (first version): web/src/lab/visits.js (DET_LAMBDA and estimateLambda only; the rest is new)
// The bands a user can pick, and how much one SPHEREx frame counts toward each.
// Band definitions live in filters.json as wavelength/response tables, so real
// response curves can replace the top-hats without code changes.

import filters from './filters.json' with { type: 'json' };

export const BANDS = filters.bands;

// Approximate wavelength (microns) along each detector's y axis, [at y = 1, at y = 2040],
// measured from the WCS-WAVE tables; only used to choose which files to download.
export const DET_LAMBDA = {
  1: [1.126, 0.735],
  2: [1.65, 1.086],
  3: [2.419, 1.616],
  4: [3.818, 2.398],
  5: [4.418, 3.792],
  6: [4.999, 4.395],
};

export function estimateLambda(det, y) {
  const [a, b] = DET_LAMBDA[det];
  return a * (b / a) ** ((Math.min(2040, Math.max(1, y)) - 1) / 2039);
}

export const getBand = (id) => (typeof id === 'string' ? BANDS.find((b) => b.id === id) : id);

/** Relative response of a band at a wavelength (microns). */
export function bandResponse(band, lambda) {
  const b = getBand(band);
  const { lambda: x, response: r } = b;
  if (!(lambda >= x[0] && lambda <= x.at(-1))) return 0;
  if (b.kind !== 'rsr') return 1;
  let k = 0;
  while (k < x.length - 2 && lambda > x[k + 1]) k++;
  const f = (lambda - x[k]) / (x[k + 1] - x[k]);
  return r[k] + f * (r[k + 1] - r[k]);
}

/** Weight of one frame in a band: response at its wavelength times its bandwidth. */
export const bandWeight = (band, lambda, bandwidth) => bandResponse(band, lambda) * bandwidth;

/**
 * The visits a band needs, chosen before download from each visit's detector
 * and estimated wavelength. The weight from the file's own WCS-WAVE table
 * decides the rest after loading.
 */
export function visitsForBand(band, visits) {
  const b = getBand(band);
  if (b.kind === 'detector') return visits.filter((v) => v.det === b.det);
  const lo = b.lambda[0];
  const hi = b.lambda.at(-1);
  return visits.filter((v) => {
    const l = estimateLambda(v.det, v.y);
    const slack = l / 40; // about one SPHEREx resolution element
    return l + slack >= lo && l - slack <= hi;
  });
}
