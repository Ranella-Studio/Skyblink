// Visits and survey passes for a sky position.
//
// SPHEREx's linear variable filter puts a different wavelength on every
// detector row, so the frames of one spot within one six-month pass are all at
// different wavelengths. Frames are therefore grouped into passes (or fixed
// time bins for spots seen continuously near the ecliptic poles) and each pass
// is stacked into a band before anything is compared over time.

import { surveyNumber } from '../data/survey.js';
import { DET_SIZE } from '../data/pointings.js';

const NATIVE = 6.15; // SPHEREx pixel, arcsec
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'May 2025' for an MJD. */
export function passLabel(mjd) {
  const d = new Date((mjd - 40587) * 86400000);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * Every sub-exposure, on all six detectors, whose detector holds the whole
 * fovArcmin field around (ra, dec). `track(mjd) -> [ra, dec]` follows a moving
 * target. Returns [{ i, det, sub, x, y, mjd, ra, dec, url, urls, obsId }]
 * sorted by time; `urls` lists where the file may be, most likely first.
 */
export function findVisits(pointings, ra, dec, { fovArcmin = 6, track = null } = {}) {
  // Half-diagonal of the field in detector pixels, plus slack for the index's
  // approximate (no SIP, ~1-3 px) geometry.
  const margin = Math.ceil(((fovArcmin * 30 * Math.SQRT2) / NATIVE) + 8);
  if (2 * margin >= DET_SIZE) throw new Error('field larger than a SPHEREx detector');
  const hits = pointings.findVisits(ra, dec, { margin, track });
  const out = [];
  for (const h of hits) {
    for (const det of [h.det, h.det + 3]) {
      // Detectors 4-6 see the same sky as 1-3 through the dichroic.
      const urls = pointings.fileUrls(h.i, det, h.sub);
      out.push({ ...h, det, url: urls[0], urls, obsId: pointings.obsId(h.i, h.sub) });
    }
  }
  return out.sort((a, b) => a.mjd - b.mjd || a.det - b.det || a.sub - b.sub);
}

/**
 * Group visits into passes. Default: a new pass when SPHEREx was away for more
 * than `gap` days; a pass longer than `maxLength` days (spots near the ecliptic
 * poles, seen continuously) is then cut into equal chunks of at most `chunk`
 * days. With `binDays`, fixed bins of that many days from the first visit
 * instead (for light curves); empty bins are skipped.
 * Returns [{ id, label, start, end, mjdMean, survey, visits }].
 */
export function groupPasses(visits, { gap = 30, maxLength = 75, chunk = 60, binDays = null } = {}) {
  const sorted = [...visits].sort((a, b) => a.mjd - b.mjd);
  const groups = [];
  if (binDays) {
    const t0 = sorted[0]?.mjd;
    const bins = new Map();
    for (const v of sorted) {
      const k = Math.floor((v.mjd - t0) / binDays);
      if (!bins.has(k)) bins.set(k, []);
      bins.get(k).push(v);
    }
    groups.push(...bins.values());
  } else {
    let last = null;
    const runs = [];
    for (const v of sorted) {
      if (!last || v.mjd - last.at(-1).mjd > gap) runs.push((last = []));
      last.push(v);
    }
    for (const r of runs) {
      const span = r.at(-1).mjd - r[0].mjd;
      if (span <= maxLength) {
        groups.push(r);
        continue;
      }
      const parts = Math.ceil(span / chunk);
      const len = span / parts;
      const out = Array.from({ length: parts }, () => []);
      for (const v of r) out[Math.min(parts - 1, Math.floor((v.mjd - r[0].mjd) / len))].push(v);
      groups.push(...out.filter((g) => g.length));
    }
  }
  return groups.map((g, id) => {
    const mjdMean = g.reduce((s, v) => s + v.mjd, 0) / g.length;
    return {
      id,
      label: passLabel(mjdMean),
      start: g[0].mjd,
      end: g.at(-1).mjd,
      mjdMean,
      survey: surveyNumber(g[0].mjd),
      visits: g,
    };
  });
}

/** Visits grouped into passes in one call: findVisits + groupPasses. */
export function findPasses(pointings, ra, dec, { fovArcmin = 6, track = null, ...group } = {}) {
  return groupPasses(findVisits(pointings, ra, dec, { fovArcmin, track }), group);
}
