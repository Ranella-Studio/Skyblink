// "What you clicked": the source's position on each date, its fitted motion,
// the Gaia DR3 match, and its SPHEREx spectrum per pass.

import { centroid, fitMotion, motionSentence, direction, apertureFlux, frameNoise, accepted, scatterArcsec } from '../app/measure.js';
import { angularDistance } from '../data/sky-math.js';
import { matchStar, totalPm } from '../app/gaia.js';
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
const STILL_ARCSEC = 3; // one click: the same source within 3″ on every date means it did not move
const MATCH_ARCSEC = 3; // a Gaia star counts as the same source within 3″ at the frame's date
const APERTURE_ARCSEC = 9; // one aperture for every frame; sky from a ring at 2 to 3 times that
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthYear = (mjd) => {
  const d = new Date((mjd - 40587) * 86400000);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

/** Mark the source nearest the click in the frame on screen only; a frame keeps one mark. Returns the mark or null. */
export function measureClick(app, hit) {
  const grid = app.tl.grid;
  const m = centroid(hit.slot.frame.data, grid.n, hit.col, hit.row, SEARCH_ARCSEC / grid.scale, { core: 9 / grid.scale });
  $('clicked').hidden = false;
  $('click-hint').hidden = true;
  if (!app.click) app.click = { marks: new Map(), positions: [], fit: null, still: null, spectra: new Map(), miss: false };
  const c = app.click;
  c.miss = !m;
  if (!m) return null;
  const [ra, dec] = gridToSky(grid, m.col, m.row);
  c.marks.set(hit.slot.id, { slotId: hit.slot.id, mjd: hit.slot.frame.mjd, col: m.col, row: m.row, ra, dec });
  const first = [...c.marks.values()][0];
  Object.assign(c, { ra: first.ra, dec: first.dec, mjd: first.mjd });
  return m;
}

/** Sky position + brightness of a centroid in one frame. */
function position(slot, m, kind, grid) {
  const [ra, dec] = gridToSky(grid, m.col, m.row);
  const flux = apertureFlux(slot.frame.data, grid.n, grid.n, m.col, m.row, APERTURE_ARCSEC / grid.scale);
  return { slot, mjd: slot.frame.mjd, found: true, kind, col: m.col, row: m.row, ra, dec, flux, ...brightness(flux, slot.frame.unit, grid.scale) };
}

/**
 * Marks -> positions on every ready frame. One mark: if the same source sits within 3″ in every other
 * ready frame it did not move. Two or more: fit a line, look within 12″ of its prediction in each unmarked
 * frame, accept a centroid whose aperture sum is at least 5 times the frame's aperture noise, refit with all.
 */
export function measure(app) {
  const c = app.click;
  if (!c) return;
  const grid = app.tl.grid;
  const ready = app.view.filter((s) => s.status === 'ready');
  for (const id of c.marks.keys()) if (!ready.some((s) => s.id === id)) c.marks.delete(id);
  const look = (slot, ra, dec, radius) => {
    const g = skyToGrid(grid, ra, dec);
    return g && centroid(slot.frame.data, grid.n, g[0], g[1], radius / grid.scale, { core: 9 / grid.scale });
  };
  const marked = ready.filter((s) => c.marks.has(s.id)).map((s) => position(s, c.marks.get(s.id), 'marked', grid));
  c.still = null;
  c.fit = null;
  c.positions = marked;
  if (marked.length === 1) {
    const [m] = marked;
    const others = ready.filter((s) => s.id !== m.slot.id).map((s) => [s, look(s, m.ra, m.dec, STILL_ARCSEC)]);
    if (others.length && others.every(([, f]) => f)) {
      c.positions = [m, ...others.map(([s, f]) => position(s, f, 'found', grid))];
      const near = c.positions.every((p) => angularDistance(p.ra, p.dec, m.ra, m.dec) * 3600 <= STILL_ARCSEC);
      if (near) c.still = { scatter: scatterArcsec(c.positions) };
      else c.positions = marked;
    }
  } else if (marked.length >= 2) {
    const line = fitMotion(marked, { floor: grid.scale / 2 });
    if (line) {
      const npix = Math.PI * (APERTURE_ARCSEC / grid.scale) ** 2;
      const found = [];
      for (const s of ready) {
        if (c.marks.has(s.id)) continue;
        const f = look(s, ...line.at(s.frame.mjd), SEARCH_ARCSEC);
        if (!f) continue;
        const p = position(s, f, 'found', grid);
        s.frame.noise ??= frameNoise(s.frame.data); // shortcut: cached on the frame object, recomputed if the frame is rebuilt
        // A saturated core leaves flagged (NaN) pixels in the aperture: then judge the centroid's core sum instead.
        const ok = Number.isFinite(p.flux) ? accepted(p.flux, s.frame.noise, npix) : accepted(f.flux, s.frame.noise, f.npix);
        if (ok) found.push(p);
      }
      c.positions = [...marked, ...found].sort((x, y) => x.mjd - y.mjd);
    }
    c.fit = fitMotion(c.positions, { floor: grid.scale / 2 });
  }
  c.readyCount = ready.length;
}

function motionText(c) {
  const n = c.readyCount;
  const marks = c.marks.size;
  const miss = c.miss ? `No source within ${SEARCH_ARCSEC}″ of that click. ` : '';
  if (c.still) return `${miss}Did not move: the same source sits within ${STILL_ARCSEC}″ in all ${n} frames (scatter ${c.still.scatter.toFixed(1)}″).`;
  if (marks === 0) return `${miss}Click a star to mark it.`;
  if (marks === 1) return `${miss}Marked in 1 of ${n} frames. Step to another date and click it again.`;
  if (!c.fit) return `${miss}The marks are less than three months apart. Mark a date further away.`;
  const found = c.positions.length - marks;
  return `${miss}${motionSentence(c.fit)} Marked in ${marks}, found in ${found} more, of ${n} frames.`;
}

export function renderClicked(app, st) {
  const c = app.click;
  if (!c) return;
  $('motion').textContent = motionText(c);
  $('gaia-match').textContent = gaiaLine(app, c);
  $('bright').textContent = brightSentence(c.positions);
  const body = $('pos-table').tBodies[0];
  const first = c.positions.find((p) => p.found);
  const cosd = Math.cos((c.dec * Math.PI) / 180);
  body.replaceChildren(
    ...c.positions.map((p) => {
      const tr = el('tr');
      tr.append(el('td', null, `${p.kind === 'marked' ? '● ' : '○ '}${p.slot.source === 'spherex' ? p.slot.label : `${slotYear(p.slot)} ${p.slot.source === '2mass' ? '2MASS' : 'WISE'}`}`));
      if (!p.found) {
        const td = el('td', 'missing', `not found within ${SEARCH_ARCSEC}″`);
        td.colSpan = 3;
        tr.append(td);
      } else {
        let dra = p.ra - first.ra;
        if (dra > 180) dra -= 360;
        if (dra < -180) dra += 360;
        tr.append(el('td', null, signed(dra * cosd * 3600)), el('td', null, signed((p.dec - first.dec) * 3600)), el('td', null, Number.isFinite(p.value) ? `${p.value.toPrecision(3)}\u00a0${p.unit}` : 'flagged'));
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
