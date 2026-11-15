// "What you clicked": the source's position on each date, its fitted motion,
// the Gaia DR3 match, and its SPHEREx spectrum per pass.

import { centroid, fitMotion, motionSentence, direction } from '../app/measure.js';
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
      return { slot, mjd, found: true, col: m.col, row: m.row, ra, dec };
    });
  c.fit = fitMotion(c.positions.filter((p) => p.found), { floor: grid.scale / 2 });
}

export function renderClicked(app, st) {
  const c = app.click;
  if (!c) return;
  $('motion').textContent = motionSentence(c.fit);
  $('gaia-match').textContent = gaiaLine(app, c);
  const body = $('pos-table').tBodies[0];
  const first = c.positions.find((p) => p.found);
  const cosd = Math.cos((c.dec * Math.PI) / 180);
  body.replaceChildren(
    ...c.positions.map((p) => {
      const tr = el('tr');
      tr.append(el('td', null, `${p.slot.source === 'spherex' ? p.slot.label : `${slotYear(p.slot)} ${p.slot.source === '2mass' ? '2MASS' : 'WISE'}`}`));
      if (!p.found) {
        const td = el('td', 'missing', `not found within ${SEARCH_ARCSEC}″`);
        td.colSpan = 2;
        tr.append(td);
      } else {
        let dra = p.ra - first.ra;
        if (dra > 180) dra -= 360;
        if (dra < -180) dra += 360;
        tr.append(el('td', null, signed(dra * cosd * 3600)), el('td', null, signed((p.dec - first.dec) * 3600)));
      }
      return tr;
    }),
  );
  renderSpectrum(app, st, $('spectrum'));
}

const signed = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`;

function gaiaLine(app, c) {
  if (app.gaiaState === 'loading') return 'Checking Gaia DR3…';
  if (app.gaiaState === 'error') return `Gaia DR3 did not answer (${app.gaiaError}).`;
  if (!app.gaia) return '';
  if (!c.match) return `No Gaia DR3 star within ${SEARCH_ARCSEC}″ (Gaia lists stars to magnitude G 19).`;
  const s = c.match.star;
  const pm = totalPm(s);
  const pa = ((Math.atan2(s.pmra, s.pmdec) * 180) / Math.PI + 360) % 360;
  let line = `Known star: Gaia DR3, G ${s.g.toFixed(1)}, moves ${pm.toFixed(2)} arcsec a year toward ${direction(pa)}.`;
  if (c.fit && c.fit.speed >= 3 * c.fit.sigma) line += ` Measured here: ${c.fit.speed.toFixed(1)} ± ${c.fit.sigma.toFixed(1)}.`;
  return line;
}
