// The clicked source's SPHEREx spectrum: aperture flux of each single frame
// against its wavelength, one series per pass (told apart by marker shape,
// all in the SPHEREx colour), with a table view.

import { apertureFlux } from '../app/measure.js';
import { passFrames, passCounts } from '../app/timeline.js';
import { skyToGrid } from '../engine/grid.js';

const SVG = 'http://www.w3.org/2000/svg';
const SHAPES = ['circle', 'square', 'triangle', 'diamond'];
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

/** Where to put the aperture in a pass: the measured position, else the fitted track or the first mark. */
function positionIn(app, slot) {
  const c = app.click;
  const p = c.positions.find((q) => q.slot.id === slot.id && q.found);
  if (p) return [p.col, p.row];
  const [ra, dec] = c.fit ? c.fit.at(slot.frame.mjd) : [c.ra, c.dec];
  return skyToGrid(app.tl.grid, ra, dec);
}

/** Load (from cache when possible) the single frames of every ready pass, then draw. */
function ensureSpectra(app, st, box, all) {
  const c = app.click;
  for (const slot of app.view) {
    if (slot.source !== 'spherex' || slot.status !== 'ready') continue;
    const key = `${slot.id}|${all ? 'all' : st.band}`;
    if (c.spectra.has(key)) continue;
    const entry = { state: 'loading', frames: [], done: 0, total: 0 };
    c.spectra.set(key, entry);
    passFrames(slot, app.tl.grid, st.band, {
      all,
      signal: app.ctrl.signal,
      onProgress: (d, t) => {
        entry.done = d;
        entry.total = t;
      },
    }).then(
      (frames) => {
        Object.assign(entry, { state: 'ready', frames });
        if (app.click === c) renderSpectrum(app, st, box);
      },
      (err) => Object.assign(entry, { state: 'error', error: err?.message }),
    );
  }
}

export function renderSpectrum(app, st, box) {
  const c = app.click;
  const passes = app.view.filter((s) => s.source === 'spherex' && s.status === 'ready');
  const open = box.querySelector('details')?.open;
  box.replaceChildren(el('h3', null, 'Spectrum, one point per SPHEREx frame'));
  if (!passes.length) {
    box.append(el('p', null, 'No SPHEREx pass has loaded yet.'));
    return;
  }
  const all = !!c.fullSpectrum;
  ensureSpectra(app, st, box, all);
  const grid = app.tl.grid;
  const pixSr = (grid.scale / 206264.806) ** 2;
  const series = passes.map((slot, k) => {
    const entry = c.spectra.get(`${slot.id}|${all ? 'all' : st.band}`);
    const pos = positionIn(app, slot);
    const pts = [];
    if (entry?.state === 'ready' && pos) {
      for (const f of entry.frames) {
        const flux = apertureFlux(f.data, grid.n, grid.n, pos[0], pos[1], 6 / grid.scale);
        // MJy/sr summed over pixels -> mJy.
        if (Number.isFinite(flux)) pts.push({ lambda: f.lambda, mJy: flux * pixSr * 1e9 });
      }
    }
    pts.sort((a, b) => a.lambda - b.lambda);
    return { slot, shape: SHAPES[k % SHAPES.length], entry, pts };
  });
  const loading = series.filter((s) => s.entry?.state === 'loading');
  if (loading.length) box.append(el('p', null, `Measuring ${loading.length} pass${loading.length > 1 ? 'es' : ''}…`));
  const pts = series.flatMap((s) => s.pts);
  if (pts.length) {
    const t = table(series);
    t.open = !!open;
    box.append(chart(series), legend(series), t);
  }
  else if (!loading.length) box.append(el('p', null, 'No frame gave a clean measurement here: the centre of the source is flagged in every frame, usually because it is too bright for SPHEREx.'));

  if (!all) {
    const counts = passes.reduce((s, slot) => s + passCounts(slot, st.band).all - passCounts(slot, st.band).band, 0);
    if (counts > 0) {
      const b = el('button', 'quiet', `Show the full 0.75–5 µm spectrum (downloads ${counts} more frames)`);
      b.type = 'button';
      b.onclick = () => {
        c.fullSpectrum = true;
        renderSpectrum(app, st, box);
      };
      box.append(b);
    }
  }
}

function marker(shape, x, y, r) {
  const a = { class: 'mk' };
  if (shape === 'circle') return svgEl('circle', { cx: x, cy: y, r, ...a });
  if (shape === 'square') return svgEl('rect', { x: x - r * 0.9, y: y - r * 0.9, width: r * 1.8, height: r * 1.8, ...a });
  if (shape === 'triangle') return svgEl('path', { d: `M${x},${y - r * 1.15}L${x + r},${y + r * 0.75}L${x - r},${y + r * 0.75}Z`, ...a });
  return svgEl('path', { d: `M${x},${y - r * 1.2}L${x + r * 1.2},${y}L${x},${y + r * 1.2}L${x - r * 1.2},${y}Z`, ...a });
}

function niceTicks(lo, hi, count = 4) {
  const span = hi - lo || Math.abs(hi) || 1;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9 * step; v += step) out.push(+v.toPrecision(10));
  return out;
}

function chart(series) {
  const W = 312;
  const H = 180;
  const m = { l: 44, r: 8, t: 8, b: 30 };
  const pts = series.flatMap((s) => s.pts);
  let [x0, x1] = [Math.min(...pts.map((p) => p.lambda)), Math.max(...pts.map((p) => p.lambda))];
  if (x1 - x0 < 0.05) [x0, x1] = [x0 - 0.05, x1 + 0.05];
  let [y0, y1] = [Math.min(0, ...pts.map((p) => p.mJy)), Math.max(...pts.map((p) => p.mJy))];
  if (y1 <= y0) y1 = y0 + 1;
  y1 += (y1 - y0) * 0.08;
  const X = (v) => m.l + ((v - x0) / (x1 - x0)) * (W - m.l - m.r);
  const Y = (v) => H - m.b - ((v - y0) / (y1 - y0)) * (H - m.t - m.b);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Spectrum: flux in millijansky against wavelength from ${x0.toFixed(2)} to ${x1.toFixed(2)} microns, ${pts.length} frames. The table below lists every point.` });
  const g = svgEl('g', { 'aria-hidden': 'true' });
  for (const t of niceTicks(y0, y1)) {
    g.append(svgEl('line', { x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t), stroke: 'var(--hairline)' }));
    const tx = svgEl('text', { x: m.l - 6, y: Y(t) + 4, 'text-anchor': 'end', class: 'tick' });
    tx.textContent = fmt(t);
    g.append(tx);
  }
  for (const t of niceTicks(x0, x1)) {
    const tx = svgEl('text', { x: X(t), y: H - m.b + 16, 'text-anchor': 'middle', class: 'tick' });
    tx.textContent = t;
    g.append(tx);
  }
  g.append(svgEl('line', { x1: m.l, x2: W - m.r, y1: Y(0), y2: Y(0), stroke: 'var(--ink-faint)' }));
  const xl = svgEl('text', { x: W - m.r, y: H - 2, 'text-anchor': 'end', class: 'tick' });
  xl.textContent = 'wavelength, µm';
  const yl = svgEl('text', { x: 0, y: m.t + 2, class: 'tick' });
  yl.textContent = 'mJy';
  g.append(xl, yl);
  for (const s of series)
    for (const p of s.pts) {
      const mk = marker(s.shape, X(p.lambda), Y(p.mJy), 4);
      const title = svgEl('title', {});
      title.textContent = `${s.slot.label}: ${p.lambda.toFixed(3)} µm, ${fmt(p.mJy)} mJy`;
      mk.append(title);
      g.append(mk);
    }
  svg.append(g);
  return svg;
}

const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(1) : v.toPrecision(2));

function legend(series) {
  const ul = el('ul', 'legend');
  for (const s of series) {
    if (!s.pts.length) continue;
    const li = el('li');
    const svg = svgEl('svg', { width: 14, height: 14, viewBox: '-7 -7 14 14', 'aria-hidden': 'true' });
    svg.append(marker(s.shape, 0, 0, 4.5));
    li.append(svg, `${s.slot.label} (${s.pts.length})`);
    ul.append(li);
  }
  return ul;
}

function table(series) {
  const d = el('details', 'spec-table');
  d.append(el('summary', null, 'Show as a table'));
  const t = el('table', 'pos');
  const head = el('tr');
  for (const h of ['Pass', 'µm', 'mJy']) {
    const th = el('th', null, h);
    th.scope = 'col';
    head.append(th);
  }
  t.append(el('thead'), el('tbody'));
  t.tHead.append(head);
  for (const s of series) for (const p of s.pts) {
    const tr = el('tr');
    tr.append(el('td', null, s.slot.label), el('td', null, p.lambda.toFixed(3)), el('td', null, fmt(p.mJy)));
    t.tBodies[0].append(tr);
  }
  d.append(t);
  return d;
}
