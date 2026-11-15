// The stage: the frame(s) on screen, caption, scale bar, compass, overlay.

import { stretch, diverging, addFrames, toRgba } from './render.js';
import { FWHM, blurToFwhm, difference } from '../engine/legacy/match.js';
import { slotStatusText, slotYear } from './strip.js';
import { getBand } from '../engine/bands.js';
import { gridToSky, skyToGrid } from '../engine/grid.js';
import { starAt } from '../app/gaia.js';
import { formatRa, formatDec } from '../data/sky-math.js';

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
let lastShown = null;
export const clearRenderCache = () => (cache = new Map());

function rgbaFor(slot, palette) {
  const key = `${slot.id}|${palette}`;
  if (!cache.has(key)) {
    const n = Math.round(Math.sqrt(slot.frame.data.length));
    cache.set(key, { n, rgba: toRgba(stretch(slot.frame.data, { invert: palette === 'inverted' }), palette === 'heat') });
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

/** Header strip pieces: survey name in its colour, date, filter, frames. */
function captionLines(slot) {
  const f = slot.frame;
  const out = [el('span', `survey s-${slot.source}`, SURVEY[slot.source]), el('span', null, dateText(f)), el('span', null, bandText(slot))];
  if (slot.source === 'spherex' && f.n) out.push(el('span', null, `${f.n}\u00a0frame${f.n === 1 ? '' : 's'}`));
  return out;
}

/** The readout's definition list for the frame on screen. */
function factRows(slot, grid) {
  const f = slot.frame;
  const b = getBand(f.band);
  const flags = Object.entries(f.flagCounts || {}).filter(([, c]) => c > 0).sort((x, y) => y[1] - x[1]).slice(0, 3);
  const wl = f.lambdaRange ? `${f.lambdaRange[0].toFixed(2)}–${f.lambdaRange[1].toFixed(2)}\u00a0µm` : b?.kind === 'detector' ? `${b.lambda[0].toFixed(2)}–${b.lambda.at(-1).toFixed(2)}\u00a0µm` : CENTRAL[f.band] ? `${CENTRAL[f.band]}\u00a0µm (centre)` : '';
  return [
    ['Telescope', SURVEY[slot.source]],
    ['Date', dateText(f)],
    ['Filter', bandText(slot)],
    ['Frames added', slot.source === 'spherex' && f.n ? String(f.n) : 'one atlas image'],
    ['Wavelengths', wl || 'not given'],
    ['Pixel scale', `${grid.scale.toFixed(2)}″ per pixel (resampled)`],
    ['Flags', slot.source !== 'spherex' ? 'not read for this survey' : flags.length ? flags.map(([k, c]) => `${k} ${c}`).join(', ') : 'none in this cut-out'],
  ];
}

function renderFacts(dl, rows) {
  dl.replaceChildren(...rows.flatMap(([k, v]) => [el('dt', null, k), el('dd', 'data', v)]));
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
      return { ra, dec, mjd: p.slot.frame.mjd, col, row, slot: p.slot, grid: p.grid };
    }
    return null;
  },
};

/**
 * Draw whatever the mode asks for. Returns { message, retry, files } where
 * message is set when nothing can be drawn.
 */
export function drawStage({ app, st, canvasA, canvasB, wrap, caption, overlay, axes, files, facts, footNote }) {
  const view = app.view;
  const grid = app.tl.grid;
  const n = grid.n;
  caption.replaceChildren();
  overlay.replaceChildren();
  files.replaceChildren();
  facts.replaceChildren();
  footNote.textContent = '';
  canvasA.classList.remove('dim');
  drawAxes(axes, grid);
  const ready = view.filter((s) => s.status === 'ready');
  const frameOf = (s) => el('span', 'frame-of', `frame ${ready.indexOf(s) + 1} of ${ready.length}`);
  panels = [];
  const side = st.mode === 'side';
  wrap.classList.toggle('side', side);
  canvasB.hidden = !side;
  const cur = view.find((s) => s.id === st.curId);
  const A = view[st.a];
  const B = view[st.b];
  // While a date loads, keep the last ready frame on screen, dimmed, rather than a black square.
  const blank = () => {
    canvasB.hidden = true;
    const last = view.find((s) => s.id === lastShown && s.status === 'ready') || ready[0];
    if (last) {
      paint(canvasA, rgbaFor(last, st.palette));
      canvasA.classList.add('dim');
    } else canvasA.getContext('2d').clearRect(0, 0, canvasA.width, canvasA.height);
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
      const { done = 0, total = 0 } = cur.progress || {};
      return { message: total > 1 ? `Adding ${done} of ${total} frames` : `${label}: loading`, data: true };
    }
    if (st.mode !== 'blink') footNote.textContent = 'Compare needs two dates that have loaded; showing the blink.';
    paint(canvasA, rgbaFor(cur, st.palette));
    lastShown = cur.id;
    caption.prepend(...captionLines(cur), frameOf(cur));
    footNote.textContent = notText(cur);
    renderFacts(facts, factRows(cur, grid));
    listFiles(cur);
    viewN = n;
    panels = [{ slot: cur, grid, x: 0, y: 0, size: n }];
  } else if (side) {
    paint(canvasA, rgbaFor(A, st.palette));
    paint(canvasB, rgbaFor(B, st.palette));
    caption.append(el('span', `survey s-${A.source}`, shortName(A)), el('span', null, 'beside'), el('span', `survey s-${B.source}`, shortName(B)), el('span', null, bandText(B)));
    renderFacts(facts, factRows(B, grid));
    listFiles(A);
    listFiles(B);
    viewN = 2 * n;
    panels = [
      { slot: A, grid, x: 0, y: n / 2, size: n },
      { slot: B, grid, x: n, y: n / 2, size: n },
    ];
    overlay.append(svgEl('line', { x1: n, x2: n, y1: n / 2, y2: 1.5 * n, stroke: 'var(--paper)', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' }));
  } else {
    const key = `${st.mode}|${A.id}|${B.id}|${st.palette}`;
    if (!cache.has(key)) {
      let img;
      let note = '';
      if (st.mode === 'subtract') {
        // Blur the sharper frame to the blurrier one's resolution, scale A's brightness to B's, subtract.
        const to = Math.max(fwhm(A), fwhm(B));
        const a = blurToFwhm(A.frame, fwhm(A), to, grid.scale);
        const b = blurToFwhm(B.frame, fwhm(B), to, grid.scale);
        const d = difference(b, a);
        img = diverging(d.data, { invert: st.palette === 'inverted' });
        note = Number.isFinite(d.fluxScale) ? `Earlier date scaled ×${d.fluxScale.toPrecision(3)} and both blurred to ${to.toFixed(1)}″ before subtracting.` : 'No star bright in both dates, so the brightness could not be matched.';
      } else img = stretch(addFrames([A.frame.data, B.frame.data]), { invert: st.palette === 'inverted' });
      // A difference stays grey: its white/black/grey carry meaning that a heat ramp would hide.
      cache.set(key, { n, rgba: toRgba(img, st.palette === 'heat' && st.mode !== 'subtract'), note });
    }
    paint(canvasA, cache.get(key));
    const word = st.mode === 'subtract' ? 'minus' : 'plus';
    caption.append(el('span', `survey s-${B.source}`, shortName(B)), el('span', null, word), el('span', `survey s-${A.source}`, shortName(A)), el('span', null, bandText(B)));
    if (st.mode === 'subtract') footNote.textContent = `White: brighter in ${shortName(B)}. Black: brighter in ${shortName(A)}. Grey: no change. ${cache.get(key).note}`;
    renderFacts(facts, factRows(B, grid));
    listFiles(A);
    listFiles(B);
    viewN = n;
    panels = [{ slot: B, grid, x: 0, y: 0, size: n }];
  }

  overlay.setAttribute('viewBox', `0 0 ${viewN} ${viewN}`);
  for (const p of panels) drawMarks(overlay, p, app, st);
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

/**
 * Real axes around the image: ticks every arcmin (every 5 above 12 arcmin),
 * labelled as offsets from the centre. East is left, north up. The SVG is laid
 * over the stage with overflow visible, so ticks and labels sit outside the image.
 */
function drawAxes(svg, grid) {
  const W = svg.clientWidth || 400; // the image's size in CSS px (square)
  const fov = (grid.n * grid.scale) / 60;
  const stepA = fov > 12 ? 5 : 1;
  const half = fov / 2;
  const nodes = [];
  const t = (tag, attrs, text) => {
    const e = svgEl(tag, attrs);
    if (text != null) e.textContent = text;
    nodes.push(e);
  };
  for (let a = -Math.floor(half / stepA) * stepA; a <= half + 1e-9; a += stepA) {
    const p = W / 2 - (a / fov) * W; // east (positive) to the left; north (positive) up
    const lab = a === 0 ? '0' : `${a > 0 ? '+' : '−'}${Math.abs(a)}′`;
    t('line', { class: 'tick', x1: p, x2: p, y1: W, y2: W + 5 });
    t('line', { class: 'tick', x1: -5, x2: 0, y1: p, y2: p });
    t('text', { x: p, y: W + 17, 'text-anchor': 'middle' }, lab);
    t('text', { x: -8, y: p + 4, 'text-anchor': 'end' }, lab);
  }
  t('text', { x: -8, y: W + 17, 'text-anchor': 'end', class: 'dir' }, 'E');
  t('text', { x: -8, y: -6, 'text-anchor': 'end', class: 'dir' }, 'N');
  svg.replaceChildren(...nodes);
}

/** Sexagesimal centre for the footer strip. */
export const centreText = (ra, dec) => `${formatRa(ra)}  ${formatDec(dec)}`;

drawStage.rgbaFor = rgbaFor;
