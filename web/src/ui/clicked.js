// "What you clicked": the source's position on each date, its fitted motion,
// the Gaia DR3 match, and its SPHEREx spectrum per pass.

import { centroid, fitMotion, motionSentence, direction, apertureFlux } from '../app/measure.js';
import { matchStar, starAt, totalPm } from '../app/gaia.js';
import { gridToSky, skyToGrid } from '../engine/grid.js';
import { slotYear } from './strip.js';
import { renderSpectrum } from './spectrum.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const SEARCH_ARCSEC = 12;
const MATCH_ARCSEC = 3; // a Gaia star counts as the same source within 3″ at the frame's date
const APERTURE_ARCSEC = 9; // one aperture for every frame; sky from a ring at 2 to 3 times that
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthYear = (mjd) => {
  const d = new Date((mjd - 40587) * 86400000);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

/** Remember a click; the measurement itself is redone on every render as frames arrive. */
export function measureClick(app, st, ra, dec, mjd) {
  app.click = { ra, dec, mjd, positions: [], fit: null, match: null, spectra: new Map() };
  $('clicked').hidden = false;
  $('click-hint').hidden = true;
}

/** Centroid in every ready frame, searching around the Gaia track when the click matches a Gaia star. */
export function measure(app) {
  const c = app.click;
  if (!c) return;
  const grid = app.tl.grid;
  c.match = app.gaia ? matchStar(app.gaia, c.ra, c.dec, c.mjd, SEARCH_ARCSEC) : null;
  c.positions = app.view
    .filter((s) => s.status === 'ready')
    .map((slot) => {
      const mjd = slot.frame.mjd;
      const [pra, pdec] = c.match ? starAt(c.match.star, mjd) : [c.ra, c.dec];
      const g = skyToGrid(grid, pra, pdec);
      const m = g && centroid(slot.frame.data, grid.n, g[0], g[1], SEARCH_ARCSEC / grid.scale, { core: 9 / grid.scale });
      if (!m) return { slot, mjd, found: false };
      const [ra, dec] = gridToSky(grid, m.col, m.row);
      const flux = apertureFlux(slot.frame.data, grid.n, grid.n, m.col, m.row, APERTURE_ARCSEC / grid.scale);
      return { slot, mjd, found: true, col: m.col, row: m.row, ra, dec, ...brightness(flux, slot.frame.unit, grid.scale) };
    });
  c.fit = fitMotion(c.positions.filter((p) => p.found), { floor: grid.scale / 2 });
}

export function renderClicked(app, st) {
  const c = app.click;
  if (!c) return;
  $('motion').textContent = motionSentence(c.fit);
  $('gaia-match').textContent = gaiaLine(app, c);
  $('bright').textContent = brightSentence(c.positions);
  const body = $('pos-table').tBodies[0];
  const first = c.positions.find((p) => p.found);
  const cosd = Math.cos((c.dec * Math.PI) / 180);
  body.replaceChildren(
    ...c.positions.map((p) => {
      const tr = el('tr');
      tr.append(el('td', null, `${p.slot.source === 'spherex' ? p.slot.label : `${slotYear(p.slot)} ${p.slot.source === '2mass' ? '2MASS' : 'WISE'}`}`));
      if (!p.found) {
        const td = el('td', 'missing', `not found within ${SEARCH_ARCSEC}″`);
        td.colSpan = 3;
        tr.append(td);
      } else {
        let dra = p.ra - first.ra;
        if (dra > 180) dra -= 360;
        if (dra < -180) dra += 360;
        tr.append(el('td', null, signed(dra * cosd * 3600)), el('td', null, signed((p.dec - first.dec) * 3600)), el('td', null, Number.isFinite(p.value) ? `${p.value.toPrecision(3)}\u00a0${p.unit}` : 'flagged pixels in aperture'));
      }
      return tr;
    }),
  );
  renderSpectrum(app, st, $('spectrum'));
}

const signed = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`;

/**
 * Aperture sum -> a value in the frame's own unit. Surface brightness in MJy/sr
 * summed over pixels times the pixel's solid angle is a flux density, given in mJy;
 * any other unit is shown as the plain sum, labelled with that unit.
 */
function brightness(sum, unit, scaleArcsec) {
  if (!Number.isFinite(sum)) return { value: NaN, unit: unit || '' };
  if (unit === 'MJy/sr') return { value: sum * 1e9 * (scaleArcsec / 206264.806) ** 2, unit: 'mJy' };
  return { value: sum, unit: `${unit || 'counts'} summed` };
}

/** "Faded 34% between Sep 2025 and Sep 2026", only within one survey and filter. */
function brightSentence(positions) {
  const groups = new Map();
  for (const p of positions) {
    if (!p.found || !Number.isFinite(p.value)) continue;
    const k = `${p.slot.source}|${p.slot.frame.band}|${p.unit}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  const best = [...groups.values()].filter((g) => g.length >= 2).sort((a, b) => b.length - a.length)[0];
  if (!best) return 'Brightness can only be compared between two dates from the same telescope and filter; this source has fewer than two.';
  const [a, b] = [best[0], best.at(-1)];
  if (!(a.value > 0)) return '';
  const pct = (100 * (b.value - a.value)) / a.value;
  const when = `between ${monthYear(a.mjd)} and ${monthYear(b.mjd)}`;
  const who = `(${a.slot.source === 'spherex' ? 'SPHEREx' : a.slot.source === '2mass' ? '2MASS' : 'WISE'} ${a.slot.frame.band})`;
  if (Math.abs(pct) < 0.5) return `Brightness held within 1% ${when} ${who}.`;
  return `${pct < 0 ? 'Faded' : 'Brightened'} ${Math.abs(pct).toFixed(0)}% ${when} ${who}.`;
}

function gaiaLine(app, c) {
  if (app.gaiaState === 'loading') return 'Checking Gaia DR3…';
  if (app.gaiaState === 'error') return `Gaia DR3 did not answer (${app.gaiaError}).`;
  if (!app.gaia) return '';
  // Compare the measured position in the clicked frame (else the click) with Gaia moved to that date.
  const here = c.positions.find((p) => p.found && p.mjd === c.mjd) || { ra: c.ra, dec: c.dec, mjd: c.mjd };
  const near = matchStar(app.gaia, here.ra, here.dec, here.mjd, SEARCH_ARCSEC);
  if (!near || near.sepArcsec > MATCH_ARCSEC) {
    return `No Gaia DR3 star within ${MATCH_ARCSEC}″ at this date${near ? ` (nearest ${near.sepArcsec.toFixed(1)}″ away)` : ''}. Gaia lists stars to magnitude G 19.`;
  }
  const s = near.star;
  const pm = totalPm(s);
  const pa = ((Math.atan2(s.pmra, s.pmdec) * 180) / Math.PI + 360) % 360;
  const measured = c.fit ? `${c.fit.speed.toFixed(2)} ± ${c.fit.sigma.toFixed(2)}` : 'not measured';
  return `Matches Gaia DR3 (G ${s.g.toFixed(1)}, ${near.sepArcsec.toFixed(1)}″ off at this date). Motion, arcsec/yr: Gaia ${pm.toFixed(2)} toward ${direction(pa)}; measured here ${measured}.`;
}
