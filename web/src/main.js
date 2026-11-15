// Skyblink: one patch of sky, every date we have, one matched filter.
import '@fontsource-variable/atkinson-hyperlegible-next';
import '@fontsource/overpass-mono/400.css';
import './styles/app.css';

import { readState, writeState, findTarget, TARGETS, MATCHED, DETECTORS, MODES, NO_MISSION } from './app/state.js';
import { parseCoords, formatRa, formatDec } from './data/sky-math.js';
import { openTimeline, sortSlots } from './app/timeline.js';
import { getBand, visitsForBand, BANDS as BAND_DEFS } from './engine/bands.js';
import { loadGaia } from './app/gaia.js';
import { renderStrip, drawRuler, slotStatusText, slotYear } from './ui/strip.js';
import { drawStage, stagePanels, clearRenderCache, GAIA_RING_G, centreText } from './ui/stage.js';
import { measureClick, measure, renderClicked, missionMarks } from './ui/clicked.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

const phone = matchMedia('(max-width: 719px)').matches;
const st = { ...readState(location.search), palette: 'grey', hud: !phone, gaia: false, speed: 1.5, playing: false, curId: null, userHeld: false };
const app = { tl: null, ctrl: null, view: [], passes: null, passError: null, gaia: null, gaiaState: 'off', click: null, gaiaCtrl: null };

if (st.embed) document.body.classList.add('embed');

// ---------- URL ----------
const syncUrl = () => history.replaceState(null, '', writeState(st));

// ---------- loading ----------
function load() {
  app.ctrl?.abort();
  app.ctrl = new AbortController();
  app.gaiaCtrl?.abort();
  clearRenderCache();
  // A mission (centre and filter equal to a target's) places its own marks once its frames are in.
  const mission = TARGETS.find((t) => Math.abs(t.ra - st.ra) < 1e-4 && Math.abs(t.dec - st.dec) < 1e-4 && t.band === st.band);
  Object.assign(app, { view: [], passes: null, passError: null, gaia: null, gaiaState: 'off', click: null, mission: mission?.track ?? null });
  st.curId = null;
  st.userHeld = false;
  st.pausedByUser = false;
  stop();
  $('clicked').hidden = true;
  $('click-hint').hidden = false;
  const signal = app.ctrl.signal;
  app.tl = openTimeline({ ra: st.ra, dec: st.dec, fovArcmin: st.fov, band: st.band, signal, onUpdate: schedule });
  app.tl.ready.then(
    (passes) => !signal.aborted && ((app.passes = passes), schedule()),
    (err) => !signal.aborted && ((app.passError = err?.message || String(err)), schedule()),
  );
  $('coords').value = `${+st.ra.toFixed(5)} ${+st.dec.toFixed(5)}`;
  $('foot-coords').textContent = centreText(st.ra, st.dec);
  markTarget();
  if (st.gaia) ensureGaia();
  syncUrl();
  schedule();
}

let raf = 0;
function schedule() {
  if (!raf) raf = requestAnimationFrame(() => ((raf = 0), render()));
}

// ---------- frames on screen ----------
const readyIdx = () => app.view.map((s, i) => (s.status === 'ready' ? i : -1)).filter((i) => i >= 0);
const curIndex = () => Math.max(0, app.view.findIndex((s) => s.id === st.curId));

function render() {
  if (!app.tl) return;
  app.view = sortSlots(app.tl.slots);
  const ready = readyIdx();
  // Show the first finished date at once; under reduced motion, the newest SPHEREx frame.
  if (!st.userHeld && ready.length) {
    const cur = app.view.findIndex((s) => s.id === st.curId);
    if (cur < 0 || app.view[cur].status !== 'ready') {
      const spherex = ready.filter((i) => app.view[i].source === 'spherex');
      st.curId = app.view[reduced && spherex.length ? spherex.at(-1) : ready[0]].id;
    }
    if (!reduced && !st.playing && !st.pausedByUser && ready.length >= 2) play();
  }
  if (st.curId == null && app.view.length) st.curId = app.view[0].id;
  for (const s of app.view) s.drawKey = `${s.status}|${st.palette}`;
  renderStrip({
    thumbs: $('thumbs'), ruler: $('ruler'), view: app.view, cur: curIndex(),
    onPick: (i) => hold(i),
    onRetry: (slot) => slot.retry(),
    draw: drawThumb,
  });
  renderPickers();
  renderPassNote();
  // Wait until no frame is still loading, so the first and last ready frames are the real first and last.
  if (app.mission && !app.click && ready.length >= 2 && !app.view.some((s) => s.status === 'loading')) {
    const track = app.mission;
    app.mission = null;
    if (missionMarks(app, track)) ensureGaia();
  }
  if (app.click) measure(app);
  renderStage();
  if (app.click) renderClicked(app, st);
}

function drawThumb(slot, canvas) {
  const { rgba, n } = drawStage.rgbaFor(slot, st.palette);
  canvas.width = canvas.height = n;
  canvas.getContext('2d').putImageData(new ImageData(rgba, n, n), 0, 0);
}

function renderStage() {
  const msg = $('stage-msg');
  msg.replaceChildren();
  const res = drawStage({ app, st, canvasA: $('canvas-a'), canvasB: $('canvas-b'), wrap: $('canvases'), caption: $('caption'), overlay: $('overlay'), axes: $('axes'), files: $('files-list'), facts: $('facts'), footField: $('foot-field') });
  renderHud();
  if (res.message) {
    msg.append(el('p', res.data ? 'data' : null, res.message));
    if (res.retry) {
      const b = el('button', 'retry', 'Retry');
      b.type = 'button';
      b.onclick = res.retry;
      msg.append(b);
    }
  }
  const note = spherexNote();
  if (note) {
    if (res.message || !readyIdx().length) msg.append(note);
    else {
      note.classList.add('stage-under');
      msg.append(note);
    }
  }
  $('files').hidden = !res.files;
}

/** SPHEREx passes over this spot that have no frames in the chosen band. */
function renderPassNote() {
  const box = $('pass-note');
  const band = getBand(st.band);
  const skipped = (app.passes || []).filter((p) => !visitsForBand(band, p.visits).length);
  const some = app.passes?.some((p) => visitsForBand(band, p.visits).length);
  box.textContent = skipped.length && some ? `SPHEREx also passed over here in ${skipped.map((p) => p.label).join(', ')}, but took no ${st.band} frames then, so those dates are not in the strip.` : '';
}

/** "No SPHEREx data here in this band yet", with the bands that have some. */
function spherexNote() {
  if (app.passError) return el('p', null, `The SPHEREx index could not be read: ${app.passError}`);
  if (!app.passes) return null;
  const band = getBand(st.band);
  if (app.passes.some((p) => visitsForBand(band, p.visits).length)) return null;
  const box = el('div', 'offer-box');
  if (!app.passes.length) {
    box.append(el('p', null, 'SPHEREx has not imaged this spot yet.'));
    return box;
  }
  box.append(el('p', null, `SPHEREx has no ${st.band} frames here yet. The newest pass over this spot was ${app.passes.at(-1).label}.`));
  const have = BAND_DEFS.filter((b) => app.passes.some((p) => visitsForBand(b, p.visits).length));
  if (have.length) {
    const offer = el('div', 'offer');
    for (const b of have) {
      const btn = el('button', 'quiet', b.id);
      btn.type = 'button';
      btn.onclick = () => setBand(b.id);
      offer.append(btn);
    }
    box.append(el('p', null, 'Bands with SPHEREx data here:'), offer);
  }
  return box;
}

// ---------- playback ----------
let timer = 0;
function step(dir) {
  const ready = readyIdx();
  if (!ready.length) return;
  const cur = curIndex();
  const next = dir > 0 ? ready.find((i) => i > cur) ?? ready[0] : [...ready].reverse().find((i) => i < cur) ?? ready.at(-1);
  st.curId = app.view[next].id;
  render();
}
function tick() {
  step(1);
  timer = setTimeout(tick, 1000 / st.speed);
}
function play() {
  if (st.playing) return;
  st.playing = true;
  st.pausedByUser = false;
  timer = setTimeout(tick, 1000 / st.speed);
  playButton();
}
function stop(byUser = false) {
  clearTimeout(timer);
  st.playing = false;
  if (byUser) st.pausedByUser = true;
  playButton();
}
function playButton() {
  $('play-label').textContent = st.playing ? 'Pause' : 'Play';
  $('play').setAttribute('aria-pressed', String(st.playing));
}
function hold(i) {
  stop(true);
  st.userHeld = true;
  st.curId = app.view[i]?.id ?? null;
  if (st.mode !== 'blink') setMode('blink');
  render();
}
$('play').onclick = () => (st.playing ? stop(true) : (step(1), play()));
const userStep = (dir) => {
  stop(true);
  st.userHeld = true;
  step(dir);
};
$('step-back').onclick = () => userStep(-1);
$('step-fwd').onclick = () => userStep(1);

// ---------- controls ----------
function radios(container, name, values, label, onChange, keys = false) {
  container.replaceChildren(
    ...values.map((v, k) => {
      const l = el('label');
      const i = el('input');
      i.type = 'radio';
      i.name = name;
      i.value = v;
      i.onchange = () => onChange(v);
      l.append(i, el('span', null, label(v)));
      if (keys) {
        i.setAttribute('aria-keyshortcuts', String(k + 1));
        l.append(el('kbd', 'kc', String(k + 1)));
      }
      return l;
    }),
  );
}
const MODE_NAMES = { blink: 'Blink', subtract: 'Subtract', add: 'Add', side: 'Side by side' };
radios($('bands-matched'), 'band', MATCHED, (v) => v, setBand, true);
const PALETTE_NAMES = { grey: 'Grey', inverted: 'Inverted', heat: 'Heat' };
radios($('palette'), 'palette', Object.keys(PALETTE_NAMES), (v) => PALETTE_NAMES[v], (v) => {
  st.palette = v;
  render();
});
radios($('bands-det'), 'band', DETECTORS, (v) => v, setBand);
radios($('modes'), 'mode', MODES, (v) => MODE_NAMES[v], setMode);

function setBand(b) {
  st.band = b;
  syncControls();
  load();
}
function setMode(m) {
  st.mode = m;
  if (m !== 'blink') stop(true);
  syncControls();
  syncUrl();
  render();
}

const HINT_MATCHED = 'SPHEREx’s 102 colours are added up to imitate this older filter, so all three telescopes see the same light.';
const MODE_HINT = {
  blink: 'The frames cut from one date to the next. Anything that jumps moved or changed.',
  subtract: 'The later date minus the earlier one, after matching their brightness. White got brighter or arrived, black got fainter or left; grey is no change.',
  add: 'The two dates averaged, to bring out faint things that did not move.',
  side: 'The two dates next to each other.',
};
function syncControls() {
  for (const i of document.querySelectorAll('input[name=band]')) i.checked = i.value === st.band;
  for (const i of document.querySelectorAll('input[name=mode]')) i.checked = i.value === st.mode;
  const det = DETECTORS.includes(st.band);
  const b = getBand(st.band);
  $('band-hint').textContent = det
    ? `SPHEREx detector ${st.band.slice(1)} alone, ${b.lambda[0]}–${b.lambda.at(-1)} µm. 2MASS and WISE have no matching filter, so they leave the strip.`
    : HINT_MATCHED;
  $('mode-hint').textContent = MODE_HINT[st.mode];
  $('pair').hidden = st.mode === 'blink';
  $('fov').value = st.fov;
  $('fov-out').textContent = `${st.fov} arcmin`;
  $('speed').value = st.speed;
  $('speed-out').textContent = `${st.speed} frames/s`;
  for (const i of document.querySelectorAll('input[name=palette]')) i.checked = i.value === st.palette;
  $('gaia').checked = st.gaia;
  $('hud-toggle').checked = st.hud;
}

function renderPickers() {
  const ready = readyIdx();
  if (ready.length) {
    if (st.a == null || app.view[st.a]?.status !== 'ready') st.a = ready[0];
    if (st.b == null || app.view[st.b]?.status !== 'ready') st.b = ready.at(-1);
  }
  for (const [id, key] of [['pick-a', 'a'], ['pick-b', 'b']]) {
    const sel = $(id);
    const opts = ready.map((i) => {
      const o = el('option', null, `${slotYear(app.view[i])} ${app.view[i].source === 'spherex' ? app.view[i].label : app.view[i].label}`);
      o.value = String(i);
      return o;
    });
    if (sel.options.length !== opts.length || [...sel.options].some((o, k) => o.textContent !== opts[k].textContent)) sel.replaceChildren(...opts);
    if (st[key] != null) sel.value = String(st[key]);
    sel.onchange = () => {
      st[key] = Number(sel.value);
      syncUrl();
      render();
    };
  }
}

let fovTimer = 0;
$('fov').oninput = () => {
  st.fov = Number($('fov').value);
  $('fov-out').textContent = `${st.fov} arcmin`;
  clearTimeout(fovTimer);
  fovTimer = setTimeout(load, 500);
};
$('speed').oninput = () => {
  st.speed = Number($('speed').value);
  $('speed-out').textContent = `${st.speed} frames/s`;
};
$('hud-toggle').onchange = () => setHud($('hud-toggle').checked);
function setHud(on) {
  st.hud = on;
  $('hud-toggle').checked = on;
  renderHud();
}
$('gaia').onchange = () => setGaia($('gaia').checked);
function setGaia(on) {
  st.gaia = on;
  $('gaia').checked = on;
  if (on) ensureGaia();
  gaiaStateText();
  render();
}

// ---------- HUD: reticle, pointer readout, frame number, years elapsed ----------
let pointer = null;
function renderHud() {
  const hud = $('hud');
  hud.hidden = !st.hud;
  if (!st.hud) return;
  const ready = app.view.filter((s) => s.status === 'ready');
  const cur = ready.find((s) => s.id === st.curId);
  const first = ready[0];
  // The frame count is in the header strip; the HUD keeps only the elapsed years.
  $('hud-frame').textContent = cur && st.mode === 'blink'
    ? `+${((cur.frame.mjd - first.frame.mjd) / 365.25).toFixed(1)} yr`
    : '';
  const p = pointer && stagePanels.hit(pointer, $('stage'));
  if (!p) return void ($('hud-pointer').textContent = '');
  const n = p.grid.n;
  const [c, r] = [Math.round(p.col), Math.round(p.row)];
  const v = c >= 0 && r >= 0 && c < n && r < n ? p.slot.frame.data[r * n + c] : NaN;
  $('hud-pointer').textContent = `${formatRa(p.ra)}  ${formatDec(p.dec)}\n${Number.isFinite(v) ? `${v.toPrecision(4)}\u00a0${p.slot.frame.unit || ''}` : 'no data'}`;
}
$('stage').addEventListener('pointermove', (e) => {
  pointer = { clientX: e.clientX, clientY: e.clientY };
  if (st.hud) renderHud();
});
$('stage').addEventListener('pointerleave', () => {
  pointer = null;
  if (st.hud) renderHud();
});

// ---------- Gaia ----------
function ensureGaia() {
  if (app.gaia || app.gaiaState === 'loading') return;
  app.gaiaCtrl?.abort();
  app.gaiaCtrl = new AbortController();
  const signal = app.gaiaCtrl.signal;
  app.gaiaState = 'loading';
  gaiaStateText();
  loadGaia(st.ra, st.dec, st.fov, { signal }).then(
    (stars) => {
      if (signal.aborted) return;
      app.gaia = stars;
      app.gaiaState = 'ready';
      gaiaStateText();
      render();
    },
    (err) => {
      if (signal.aborted) return;
      app.gaiaState = 'error';
      app.gaiaError = err?.message || String(err);
      gaiaStateText();
      render();
    },
  );
}
function gaiaStateText() {
  const t = { off: '', loading: '(loading Gaia DR3…)', ready: `(${app.gaia?.filter((s) => s.g <= GAIA_RING_G).length ?? 0} stars to G ${GAIA_RING_G})`, error: '(Gaia did not answer)' }[app.gaiaState];
  $('gaia-state').textContent = st.gaia || app.gaiaState === 'error' ? t : '';
}
app.ensureGaia = ensureGaia;

// ---------- clicking a source ----------
$('stage').addEventListener('click', (e) => {
  if (st.embed) return;
  const hit = stagePanels.hit(e, $('stage'));
  if (!hit) return;
  stop(true);
  app.mission = null;
  measureClick(app, hit);
  ensureGaia();
  render();
  $('clicked').scrollIntoView({ block: 'nearest' });
});
$('clear-click').onclick = () => {
  app.click = null;
  app.mission = null;
  $('clicked').hidden = true;
  $('click-hint').hidden = false;
  render();
};

// ---------- coordinates ----------
const EXAMPLE = 'Try 269.452 4.693, or 17h57m48s +04d41m36s, or a name like Barnard’s Star.';
$('coord-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('coords').value;
  const t = findTarget(text);
  const p = t ? [t.ra, t.dec] : parseCoords(text);
  const err = $('coords-error');
  if (!p) {
    $('coords').setAttribute('aria-invalid', 'true');
    err.textContent = `That is not a position Skyblink can read. ${EXAMPLE}`;
    err.hidden = false;
    return;
  }
  $('coords').removeAttribute('aria-invalid');
  err.hidden = true;
  goTo(p[0], p[1], t?.band);
});
$('coords').addEventListener('input', () => {
  if ($('coords').getAttribute('aria-invalid')) {
    $('coords').removeAttribute('aria-invalid');
    $('coords-error').hidden = true;
  }
});
function goTo(ra, dec, band) {
  st.ra = ra;
  st.dec = dec;
  if (band) st.band = band;
  st.a = st.b = null;
  syncControls();
  load();
}
const targetButtons = TARGETS.map((t) => {
  const b = el('button', 'mission');
  b.type = 'button';
  b.dataset.id = t.id;
  b.append(el('span', 'm-name', t.name), el('span', 'm-brief', t.brief));
  b.onclick = () => {
    $('missions').hidePopover?.();
    st.fov = t.fov;
    goTo(t.ra, t.dec, t.band);
  };
  return b;
});
$('targets').replaceChildren(...targetButtons);
function markTarget() {
  const on = TARGETS.findIndex((t) => Math.abs(t.ra - st.ra) < 1e-4 && Math.abs(t.dec - st.dec) < 1e-4);
  targetButtons.forEach((b, i) => b.setAttribute('aria-current', String(i === on)));
  $('mission-name').textContent = on >= 0 ? TARGETS[on].name : '';
  $('mission-text').textContent = on >= 0 ? TARGETS[on].brief : NO_MISSION;
  $('briefing').classList.toggle('none', on < 0);
}
// The stage takes the height the briefing leaves; the briefing wraps to the column, not the stage.
const sizeToBriefing = () => document.documentElement.style.setProperty('--brief-h', `${$('briefing').offsetHeight}px`);
new ResizeObserver(sizeToBriefing).observe($('briefing'));

// ---------- dialog ----------
$('about-open').onclick = () => $('about').showModal();

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || $('about').open) return;
  const t = e.target;
  if (t.closest?.('input, select, textarea')) return;
  // Space on an ordinary button presses it; only the stage, the strip and the page play/pause.
  if (e.key === ' ' && t.tagName === 'BUTTON' && !t.classList.contains('thumb')) return;
  if (e.key === ' ') {
    e.preventDefault();
    st.playing ? stop(true) : play();
  } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault();
    userStep(e.key === 'ArrowRight' ? 1 : -1);
  } else if (/^[1-5]$/.test(e.key)) {
    // Like sensor modes: 1 to 5 look through J, H, Ks, W1, W2.
    if (st.band !== MATCHED[+e.key - 1]) setBand(MATCHED[+e.key - 1]);
  } else if (e.key === 'h' || e.key === 'H') setHud(!st.hud); else if (e.key === 's' || e.key === 'S') setMode(st.mode === 'subtract' ? 'blink' : 'subtract');
  else if (e.key === 'g' || e.key === 'G') setGaia(!st.gaia);
});

// ---------- embed ----------
if (st.embed) {
  const a = $('embed-link').querySelector('a');
  a.href = writeState({ ...st, embed: false });
  $('embed-link').hidden = false;
}

addEventListener('resize', schedule);

syncControls();
load();
