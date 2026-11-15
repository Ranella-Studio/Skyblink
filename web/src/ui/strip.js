// The film strip: one thumbnail per date, and a ruler drawn to true time
// with a leader line from each thumbnail to its real date.

const SVG = 'http://www.w3.org/2000/svg';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const RULER_START = 50449; // 1997-01-01
const mjdDate = (mjd) => new Date((mjd - 40587) * 86400000);
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

const SURVEY = { '2mass': '2MASS', allwise: 'WISE', spherex: 'SPHEREx' };

/** Plain words for a slot's state, for the thumbnail and the stage. */
export function slotStatusText(slot) {
  if (slot.status === 'error') return `${SURVEY[slot.source]} did not answer`;
  if (slot.status === 'empty') return slot.source === 'spherex' ? 'No usable pixels here' : `No ${SURVEY[slot.source]} image here`;
  if (slot.status === 'loading') {
    const { done, total } = slot.progress || {};
    return total > 1 ? `${done} of ${total}` : 'Loading';
  }
  return '';
}

export function slotYear(slot) {
  if (slot.mjd != null && (slot.source === 'spherex' || slot.status === 'ready')) return String(mjdDate(slot.mjd).getUTCFullYear());
  return `${mjdDate(slot.span[0]).getUTCFullYear()}–${String(mjdDate(slot.span[1]).getUTCFullYear()).slice(2)}`;
}
export function slotMonth(slot) {
  const label = SURVEY[slot.source];
  if (slot.mjd == null || (slot.source !== 'spherex' && slot.status !== 'ready')) return label;
  return `${label} · ${MONTHS[mjdDate(slot.mjd).getUTCMonth()]}`;
}

/**
 * Rebuild or update the strip. thumbs: <ol>, ruler: <svg>.
 * view: sorted slots; cur: index on screen; onPick(i); onRetry(slot); draw(slot, canvas).
 */
export function renderStrip({ thumbs, ruler, view, cur, onPick, onRetry, draw }) {
  // Reuse thumbnails by slot id so canvases are not redrawn needlessly.
  const old = new Map([...thumbs.children].map((li) => [li.dataset.id, li]));
  const items = view.map((slot, i) => {
    let li = old.get(slot.id);
    if (!li) {
      li = el('li');
      li.dataset.id = slot.id;
      const b = el('button', 'thumb');
      b.type = 'button';
      b.dataset.source = slot.source;
      const c = document.createElement('canvas');
      c.setAttribute('aria-hidden', 'true');
      const state = el('span', 'state');
      const fill = el('span', 'fill');
      fill.append(el('i'));
      const lab = el('span', 'lab');
      lab.append(el('span', 'yr num'), el('span', 'mo'));
      b.append(c, state, fill, lab);
      li.append(b);
    }
    const b = li.firstChild;
    b.onclick = () => onPick(i);
    b.classList.toggle('current', i === cur);
    b.classList.toggle('error', slot.status === 'error');
    b.classList.toggle('empty', slot.status === 'empty');
    b.setAttribute('aria-current', i === cur ? 'true' : 'false');
    const status = slotStatusText(slot);
    b.querySelector('.yr').textContent = slotYear(slot);
    b.querySelector('.mo').textContent = slotMonth(slot);
    b.querySelector('.state').textContent = status;
    b.setAttribute('aria-label', `Frame ${i + 1}: ${SURVEY[slot.source]} ${slot.status === 'ready' ? slot.frame.label || slotYear(slot) : slotYear(slot)}${status ? `, ${status}` : ''}`);
    const { done = 0, total = 0 } = slot.progress || {};
    b.querySelector('.fill').hidden = slot.status !== 'loading';
    b.querySelector('.fill i').style.width = total ? `${(100 * done) / total}%` : '0';
    let retry = li.querySelector('.retry');
    if (slot.status === 'error') {
      if (!retry) {
        retry = el('button', 'retry', 'Retry');
        retry.type = 'button';
        li.append(retry);
      }
      retry.setAttribute('aria-label', `Retry ${SURVEY[slot.source]}`);
      retry.onclick = () => onRetry(slot);
    } else retry?.remove();
    if (slot.status === 'ready' && li.dataset.drawn !== slot.drawKey) {
      draw(slot, b.querySelector('canvas'));
      li.dataset.drawn = slot.drawKey;
    }
    return li;
  });
  thumbs.replaceChildren(...items);
  drawRuler(ruler, thumbs, view, cur);
}

/** Time axis from 1997 to today under the thumbnails, with leader lines. */
export function drawRuler(svg, thumbs, view, cur) {
  const W = thumbs.parentElement.clientWidth;
  const H = svg.clientHeight || 40;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const today = Date.now() / 86400000 + 40587;
  const pad = 12;
  const x = (mjd) => pad + ((mjd - RULER_START) / (today - RULER_START)) * (W - 2 * pad);
  const axisY = H - 16;
  const nodes = [svgEl('line', { class: 'axis', x1: pad, x2: W - pad, y1: axisY, y2: axisY })];
  for (let y = 1997; y <= mjdDate(today).getUTCFullYear(); y++) {
    const m = Date.UTC(y, 0, 1) / 86400000 + 40587;
    const major = y % 5 === 0;
    nodes.push(svgEl('line', { class: 'axis', x1: x(m), x2: x(m), y1: axisY, y2: axisY + (major ? 5 : 2) }));
    if (major) {
      const t = svgEl('text', { x: x(m), y: H - 1, 'text-anchor': 'middle' });
      t.textContent = y;
      nodes.push(t);
    }
  }
  const base = thumbs.getBoundingClientRect();
  [...thumbs.children].forEach((li, i) => {
    const slot = view[i];
    if (!slot) return;
    const r = li.getBoundingClientRect();
    const cx = r.left - base.left + r.width / 2;
    const col = `var(--c-${slot.source})`;
    const known = slot.mjd != null && (slot.source === 'spherex' || slot.status === 'ready');
    const tx = known ? x(slot.mjd) : x((slot.span[0] + slot.span[1]) / 2);
    nodes.push(svgEl('path', { class: `lead${i === cur ? ' current' : ''}`, d: `M${cx},0 C${cx},${axisY * 0.6} ${tx},${axisY * 0.4} ${tx},${axisY - 4}` }));
    if (known) nodes.push(svgEl('line', { x1: tx, x2: tx, y1: axisY - 6, y2: axisY + 1, stroke: col, 'stroke-width': 2 }));
    else nodes.push(svgEl('line', { x1: x(slot.span[0]), x2: x(slot.span[1]), y1: axisY - 2, y2: axisY - 2, stroke: col, 'stroke-width': 3 }));
  });
  svg.replaceChildren(...nodes);
}
