// The stage: the frame(s) on screen, caption, scale bar, compass, overlay.

import { stretch, diverging, addFrames, toRgba } from './render.js';
import { FWHM, blurToFwhm, difference } from '../engine/legacy/match.js';
import { slotStatusText, slotYear } from './strip.js';
import { getBand } from '../engine/bands.js';
import { gridToSky, skyToGrid } from '../engine/grid.js';
import { starAt } from '../app/gaia.js';

const SVG = 'http://www.w3.org/2000/svg';
const SURVEY = { '2mass': '2MASS', allwise: 'WISE', spherex: 'SPHEREx' };
// Published central wavelengths, µm (Cohen et al. 2003; Wright et al. 2010).
const CENTRAL = { J: '1.25', H: '1.65', Ks: '2.17', W1: '3.4', W2: '4.6' };
const LEGACY_BAND = { J: '2MASS J', H: '2MASS H', Ks: '2MASS Ks', W1: 'WISE W1', W2: 'WISE W2' };
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const svgEl = (tag, attrs) => {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};
const fwhm = (s) => (s.source === '2mass' ? FWHM['2mass'] : s.source === 'allwise' ? FWHM[s.frame.band] : FWHM.spherex);
export const GAIA_RING_G = 15; // rings for stars to G 15; fainter ones would bury the image in crowded fields
const iso = (mjd) => new Date((mjd - 40587) * 86400000).toISOString().slice(0, 10);

let cache = new Map();
export const clearRenderCache = () => (cache = new Map());

function rgbaFor(slot, invert) {
  const key = `${slot.id}|${invert}`;
  if (!cache.has(key)) {
    const n = Math.round(Math.sqrt(slot.frame.data.length));
    cache.set(key, { n, rgba: toRgba(stretch(slot.frame.data, { invert })) });
  }
  return cache.get(key);
}

function paint(canvas, { rgba, n }) {
  canvas.width = canvas.height = n;
  canvas.getContext('2d').putImageData(new ImageData(rgba, n, n), 0, 0);
}

/** "as 2MASS Ks, 2.16 µm" / "WISE W2, 4.6 µm" / "SPHEREx D3, 1.62–2.42 µm". */
function bandText(slot) {
  const b = getBand(slot.frame?.band ?? slot.band);
  if (!b) return '';
  const lo = b.lambda[0];
  const hi = b.lambda.at(-1);
  if (b.kind === 'detector') return `SPHEREx ${b.id}, ${lo.toFixed(2)}–${hi.toFixed(2)} µm`;
  const mid = CENTRAL[b.id] ?? ((lo + hi) / 2).toFixed(2);
  return `${slot.source === 'spherex' ? 'as ' : ''}${LEGACY_BAND[b.id]}, ${mid} µm`;
}

function dateText(f) {
  if (f.mjdRange && f.mjdRange[1] - f.mjdRange[0] >= 1) return `${iso(f.mjdRange[0])} to ${iso(f.mjdRange[1])}`;
  return iso(f.mjd);
}

/** What the frame is not, in plain words. */
function notText(slot) {
  const f = slot.frame;
  const b = getBand(f.band);
  if (slot.source === '2mass') return '2MASS dates run 1997 to 2001; this tile’s own date is shown.';
  if (slot.source === 'allwise') return 'WISE Atlas images add up every 2010 pass over this spot, smoothed by the telescope’s blur.';
  if (b?.kind === 'tophat') return `${b.id} imitated with a flat ${b.lambda[0]}–${b.lambda.at(-1)} µm range, not the exact filter curve.`;
  return '';
}

function captionLines(slot) {
  const f = slot.frame;
  const head = el('span');
  head.append(el('span', `survey s-${slot.source}`, SURVEY[slot.source]), ` ${dateText(f)} · ${bandText(slot)}`);
  const out = [head];
  if (slot.source === 'spherex' && f.n) out.push(el('span', null, `${f.n} frame${f.n === 1 ? '' : 's'} added`));
  const not = notText(slot);
  if (not) out.push(el('span', 'note', not));
  return out;
}

function shortName(slot) {
  return `${SURVEY[slot.source]} ${slot.source === 'spherex' ? slot.label : slotYear(slot)}`;
}

// Panels on screen, in overlay (viewBox) units, for clicks and drawing.
let panels = [];
let viewN = 1;
export const stagePanels = {
  /** A click on the stage -> { ra, dec, mjd } on the grid, or null. */
  hit(e, stage) {
    const r = stage.getBoundingClientRect();
    const u = ((e.clientX - r.left) / r.width) * viewN;
    const v = ((e.clientY - r.top) / r.height) * viewN;
    for (const p of panels) {
      const col = (u - p.x) * (p.grid.n / p.size) - 0.5;
      const row = (v - p.y) * (p.grid.n / p.size) - 0.5;
      if (col < -0.5 || row < -0.5 || col > p.grid.n - 0.5 || row > p.grid.n - 0.5) continue;
      const [ra, dec] = gridToSky(p.grid, col, row);
      return { ra, dec, mjd: p.slot.frame.mjd };
    }
    return null;
  },
};

/**
 * Draw whatever the mode asks for. Returns { message, retry, files } where
 * message is set when nothing can be drawn.
 */
export function drawStage({ app, st, canvasA, canvasB, wrap, caption, overlay, scalebar, files }) {
  const view = app.view;
  const grid = app.tl.grid;
  const n = grid.n;
  caption.replaceChildren();
  overlay.replaceChildren();
  files.replaceChildren();
  panels = [];
  const side = st.mode === 'side';
  wrap.classList.toggle('side', side);
  canvasB.hidden = !side;
  const cur = view.find((s) => s.id === st.curId);
  const A = view[st.a];
  const B = view[st.b];
  const blank = () => {
    canvasA.getContext('2d').clearRect(0, 0, canvasA.width, canvasA.height);
    canvasB.hidden = true;
  };
  const listFiles = (slot) => {
    for (const url of slot.frame.files || []) {
      const li = el('li');
      if (/^https:\/\//.test(url)) {
        const a = el('a', null, url);
        a.href = url;
        a.rel = 'noopener';
        li.append(a);
      } else li.textContent = url;
      files.append(li);
    }
    if (slot.frame.note) files.append(el('li', 'note', slot.frame.note));
  };

  if (st.mode === 'blink' || !(A?.status === 'ready' && B?.status === 'ready')) {
    if (!cur) {
      blank();
      return { message: view.length ? '' : 'Finding every date for this spot…' };
    }
    if (cur.status !== 'ready') {
      blank();
      const label = `${SURVEY[cur.source]} ${slotYear(cur)}`;
      if (cur.status === 'error') return { message: `${label}: ${slotStatusText(cur)}. ${cur.error ? `(${cur.error})` : ''} The movie plays without it.`, retry: () => cur.retry() };
      if (cur.status === 'empty') return { message: `${label}: ${slotStatusText(cur)}.` };
      return { message: `${label}: loading ${slotStatusText(cur)}` };
    }
    if (st.mode !== 'blink') caption.append(el('span', 'note', 'Compare needs two dates that have loaded; showing the blink.'));
    paint(canvasA, rgbaFor(cur, st.invert));
    caption.prepend(...captionLines(cur));
    listFiles(cur);
    viewN = n;
    panels = [{ slot: cur, grid, x: 0, y: 0, size: n }];
  } else if (side) {
    paint(canvasA, rgbaFor(A, st.invert));
    paint(canvasB, rgbaFor(B, st.invert));
    const left = el('span', null, '');
    left.append(el('span', `survey s-${A.source}`, SURVEY[A.source]), ` ${A.source === 'spherex' ? A.label : slotYear(A)}`);
    const right = el('span', 'side-b');
    right.append(el('span', `survey s-${B.source}`, SURVEY[B.source]), ` ${B.source === 'spherex' ? B.label : slotYear(B)}`);
    caption.append(left, right, el('br'), el('span', null, bandText(B)));
    listFiles(A);
    listFiles(B);
    viewN = 2 * n;
    panels = [
      { slot: A, grid, x: 0, y: n / 2, size: n },
      { slot: B, grid, x: n, y: n / 2, size: n },
    ];
    overlay.append(svgEl('line', { x1: n, x2: n, y1: n / 2, y2: 1.5 * n, stroke: 'var(--paper)', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' }));
  } else {
    const key = `${st.mode}|${A.id}|${B.id}|${st.invert}`;
    if (!cache.has(key)) {
      let img;
      let note = '';
      if (st.mode === 'subtract') {
        // Blur the sharper frame to the blurrier one's resolution, scale A's brightness to B's, subtract.
        const to = Math.max(fwhm(A), fwhm(B));
        const a = blurToFwhm(A.frame, fwhm(A), to, grid.scale);
        const b = blurToFwhm(B.frame, fwhm(B), to, grid.scale);
        const d = difference(b, a);
        img = diverging(d.data, { invert: st.invert });
        note = Number.isFinite(d.fluxScale) ? `Earlier date scaled ×${d.fluxScale.toPrecision(3)} and both blurred to ${to.toFixed(1)}″ before subtracting.` : 'No star bright in both dates, so the brightness could not be matched.';
      } else img = stretch(addFrames([A.frame.data, B.frame.data]), { invert: st.invert });
      cache.set(key, { n, rgba: toRgba(img), note });
    }
    paint(canvasA, cache.get(key));
    const line = el('span');
    const word = st.mode === 'subtract' ? 'minus' : 'plus';
    line.append(el('span', `survey s-${B.source}`, shortName(B)), ` ${word} `, el('span', `survey s-${A.source}`, shortName(A)));
    caption.append(line, el('br'), el('span', null, bandText(B)));
    if (st.mode === 'subtract') caption.append(el('br'), el('span', 'note', `White: brighter in ${shortName(B)}. Black: brighter in ${shortName(A)}. Grey: no change.`), el('br'), el('span', 'note', cache.get(key).note));
    listFiles(A);
    listFiles(B);
    viewN = n;
    panels = [{ slot: B, grid, x: 0, y: 0, size: n }];
  }

  overlay.setAttribute('viewBox', `0 0 ${viewN} ${viewN}`);
  for (const p of panels) drawMarks(overlay, p, app, st);
  drawScale(scalebar, grid, panels[0].size / viewN);
  return { files: files.children.length > 0 };
}

/** Gaia rings and measured positions for one panel. */
function drawMarks(svg, p, app, st) {
  const k = p.size / p.grid.n;
  const at = (col, row) => [p.x + (col + 0.5) * k, p.y + (row + 0.5) * k];
  const inside = (c, r) => c > -1 && r > -1 && c < p.grid.n && r < p.grid.n;
  if (st.gaia && app.gaia) {
    for (const s of app.gaia) {
      if (!(s.g <= GAIA_RING_G)) continue;
      const g = skyToGrid(p.grid, ...starAt(s, p.slot.frame.mjd));
      if (!g || !inside(...g)) continue;
      const [x, y] = at(...g);
      svg.append(svgEl('circle', { cx: x, cy: y, r: 2.6 * k, fill: 'none', stroke: 'var(--gaia)', 'stroke-width': 1.25, 'vector-effect': 'non-scaling-stroke', opacity: 0.85 }));
    }
  }
  const m = app.click?.positions?.find((q) => q.slot.id === p.slot.id && q.found);
  if (m) {
    const [x, y] = at(m.col, m.row);
    const r = 3.5 * k;
    const attrs = { stroke: 'var(--ink)', 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke' };
    svg.append(
      svgEl('line', { x1: x - 2 * r, x2: x - r, y1: y, y2: y, ...attrs }),
      svgEl('line', { x1: x + r, x2: x + 2 * r, y1: y, y2: y, ...attrs }),
      svgEl('line', { x1: x, x2: x, y1: y - 2 * r, y2: y - r, ...attrs }),
      svgEl('line', { x1: x, x2: x, y1: y + r, y2: y + 2 * r, ...attrs }),
    );
  } else if (app.click) {
    const g = skyToGrid(p.grid, app.click.ra, app.click.dec);
    if (g && inside(...g)) {
      const [x, y] = at(...g);
      svg.append(svgEl('circle', { cx: x, cy: y, r: 4 * k, fill: 'none', stroke: 'var(--ink-muted)', 'stroke-dasharray': '3 3', 'stroke-width': 1.25, 'vector-effect': 'non-scaling-stroke' }));
    }
  }
}

/** Scale bar (1 or 5 arcmin) and the N/E compass. frac: panel width / stage width. */
function drawScale(box, grid, frac) {
  const fov = (grid.n * grid.scale) / 60;
  const arcmin = fov > 10 ? 5 : 1;
  const pct = ((arcmin * 60) / grid.scale / grid.n) * frac * 100;
  const bar = el('div', 'bar', `${arcmin} arcmin`);
  bar.style.width = `calc(var(--size) * ${(pct / 100).toFixed(4)})`;
  // Compass: north up, east left (row 0 = north, col 0 = east).
  const c = svgEl('svg', { width: 40, height: 40, viewBox: '-4 -4 44 44', 'aria-hidden': 'true' });
  const s = { stroke: 'var(--ink)', 'stroke-width': 1.5 };
  c.append(svgEl('line', { x1: 32, y1: 32, x2: 32, y2: 8, ...s }), svgEl('line', { x1: 32, y1: 32, x2: 8, y2: 32, ...s }));
  const tN = svgEl('text', { x: 32, y: 4, 'text-anchor': 'middle', fill: 'var(--ink)', 'font-size': 12 });
  tN.textContent = 'N';
  const tE = svgEl('text', { x: 1, y: 36, 'text-anchor': 'middle', fill: 'var(--ink)', 'font-size': 12 });
  tE.textContent = 'E';
  c.append(tN, tE);
  box.replaceChildren(c, bar);
}

drawStage.rgbaFor = rgbaFor;
