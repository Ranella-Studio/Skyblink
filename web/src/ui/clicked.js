// "What you clicked": the source's position on each date, its fitted motion,
// the Gaia DR3 match, and its SPHEREx spectrum per pass.

import { centroid, motionSentence, direction, trackAt, SEARCH_ARCSEC, STILL_ARCSEC } from '../app/measure.js';
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
const MATCH_ARCSEC = 3; // a Gaia star counts as the same source within 3″ at the frame's date
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthYear = (mjd) => {
  const d = new Date((mjd - 40587) * 86400000);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

export { measure } from '../app/measure.js';

/** Mark the source nearest the click in the frame on screen only; a frame keeps one mark. Returns the mark or null. */
export function measureClick(app, hit) {
  const m = centroid(hit.slot.frame.data, app.tl.grid.n, hit.col, hit.row, SEARCH_ARCSEC / app.tl.grid.scale, { core: 9 / app.tl.grid.scale });
  const c = openClick(app);
  c.miss = !m;
  if (m) setMark(app, hit.slot, m, false);
  return m;
}

function openClick(app) {
  $('clicked').hidden = false;
  $('click-hint').hidden = true;
  app.click ??= { marks: new Map(), positions: [], fit: null, still: null, spectra: new Map(), miss: false };
  return app.click;
}

function setMark(app, slot, m, mission) {
  const c = app.click;
  const [ra, dec] = gridToSky(app.tl.grid, m.col, m.row);
  c.marks.set(slot.id, { slotId: slot.id, mjd: slot.frame.mjd, col: m.col, row: m.row, ra, dec, mission });
  const first = [...c.marks.values()][0];
  Object.assign(c, { ra: first.ra, dec: first.dec, mjd: first.mjd });
}

/**
 * A mission marks its own target: centroid the real image within 12″ of where the published track puts it,
 * in the first and the last ready frame (moving inward past frames where nothing is found). A target with
 * no proper motion needs one mark, in the newest frame. Marks nothing unless every needed mark is found.
 */
export function missionMarks(app, track) {
  const grid = app.tl.grid;
  const ready = app.view.filter((s) => s.status === 'ready');
  const find = (s) => {
    const g = skyToGrid(grid, ...trackAt(track, s.frame.mjd));
    return g && centroid(s.frame.data, grid.n, g[0], g[1], SEARCH_ARCSEC / grid.scale, { core: 9 / grid.scale });
  };
  const hits = [];
  for (let j = ready.length - 1; j >= 0 && !hits.length; j--) {
    const m = find(ready[j]);
    if (m) hits.push([ready[j], m]);
  }
  if (track.pmra || track.pmdec) {
    const last = hits.length ? ready.indexOf(hits[0][0]) : 0;
    for (let i = 0; i < last && hits.length < 2; i++) {
      const m = find(ready[i]);
      if (m) hits.push([ready[i], m]);
    }
    if (hits.length < 2) return false;
  } else if (!hits.length) return false;
  openClick(app);
  for (const [s, m] of hits.reverse()) setMark(app, s, m, true);
  return true;
}

function motionText(c) {
  const n = c.readyCount;
  const marks = c.marks.size;
  const miss = c.miss ? `No source within ${SEARCH_ARCSEC}″ of that click. ` : '';
  const k = c.positions.length;
  if (c.still) return `${miss}Did not move: the same source sits within ${STILL_ARCSEC}″ in ${k === n ? 'all' : `${k} of`} ${n} frames (scatter ${c.still.scatter.toFixed(1)}″).`;
  if (marks === 0) return `${miss}Click a star to mark it.`;
  if (marks === 1 && c.away) return `${miss}Found within ${STILL_ARCSEC}″ of the mark in ${k} of ${n} frames but further away in ${c.away}, so it cannot say whether it moved. Step to another date and click it again.`;
  if (marks === 1) return `${miss}Marked in 1 of ${n} frames. Step to another date and click it again.`;
  if (!c.fit) return `${miss}The marks are less than three months apart. Mark a date further away.`;
  const found = c.positions.length - marks;
  return `${miss}${motionSentence(c.fit)} Marked in ${marks}, found in ${found} more, of ${n} frames.`;
}

export function renderClicked(app, st) {
  const c = app.click;
  if (!c) return;
  const byMission = [...c.marks.values()].filter((m) => m.mission).length;
  $('motion').textContent = motionText(c) + (byMission ? ` ${byMission > 1 ? 'Marks' : 'Mark'} placed by the mission at the published position.` : '');
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

/** "Faded 34% between Sep 2025 and Sep 2026", only within one survey and filter. */
function brightSentence(positions) {
  const groups = new Map();
  let partial = 0;
  for (const p of positions) {
    if (!p.found || !Number.isFinite(p.value)) continue;
    // A visit that sampled under 80% of the filter gives a brightness that is not comparable (see timeline.js).
    if (p.slot.frame.bandCoverage < 0.8) {
      partial++;
      continue;
    }
    const k = `${p.slot.source}|${p.slot.frame.band}|${p.unit}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  const best = [...groups.values()].filter((g) => g.length >= 2).sort((a, b) => b.length - a.length)[0];
  if (!best && partial) return 'Brightness is compared only between visits that sampled at least 80% of the filter, and fewer than two did here.';
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
  const measured = c.fit ? `; measured here ${c.fit.speed.toFixed(2)} ± ${c.fit.sigma.toFixed(2)}` : '';
  return `Matches Gaia DR3 (G ${s.g.toFixed(1)}, ${near.sepArcsec.toFixed(1)}″ off at this date). Motion, arcsec/yr: Gaia ${pm.toFixed(2)} toward ${direction(pa)}${measured}.`;
}
