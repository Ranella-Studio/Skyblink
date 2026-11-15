// The one adapter between the survey engines and the UI. Everything else in
// the UI talks only to this file.
//
// A frame, from any survey, already on the shared grid:
// { source: 'spherex'|'allwise'|'2mass', band, label, mjd, mjdRange, data: Float32Array(n*n),
//   unit, n, lambdaRange, files, flagCounts, note }

import { makeGrid } from '../engine/grid.js';
import { findPasses } from '../engine/passes.js';
import { passStack } from '../engine/stack.js';
import { getBand, visitsForBand } from '../engine/bands.js';
import { loadFrame } from '../engine/cutout.js';
import { loadPointings } from '../data/pointings.js';

// The older-survey readers are written alongside this file; whichever exist are used.
const legacy = import.meta.glob('../engine/legacy/{allwise,twomass}.js');
const LEGACY = {
  '2mass': { bands: ['J', 'H', 'Ks'], file: '../engine/legacy/twomass.js', fn: 'loadTwomass', label: '2MASS', span: [50449, 52275] }, // 1997-01-01 .. 2001-12-31
  allwise: { bands: ['W1', 'W2'], file: '../engine/legacy/allwise.js', fn: 'loadAllwise', label: 'WISE', span: [55197, 55605] }, // 2010-01-01 .. 2011-02-14
};

// Why a SPHEREx stack is too thin to show (status 'empty', reason in frame.note);
// a partly sampled filter gets a note instead. Returns the reason or null.
function thinStack(frame) {
  const pct = Math.round(100 * frame.bandCoverage);
  if (frame.n < 3) return `Only ${frame.n} SPHEREx frame${frame.n === 1 ? '' : 's'} in this filter on this visit`;
  if (frame.bandCoverage < 0.35) return `SPHEREx sampled only ${pct}% of this filter on this visit`;
  if (frame.bandCoverage < 0.8) frame.note = `SPHEREx sampled ${pct}% of this filter on this visit`;
  return null;
}

const mjdYear = (mjd) => new Date((mjd - 40587) * 86400000).getUTCFullYear();
const hasData = (d) => d.some((v) => v === v);

/**
 * Open every date for one spot and band. Returns { grid, slots, passes } at
 * once; slots fill in the background and onUpdate(slot) fires on each change.
 * slot: { id, source, label, year, mjd, span, status, progress: {done,total}, frame, error, retry() }
 */
export function openTimeline({ ra, dec, fovArcmin, band, signal, onUpdate }) {
  const grid = makeGrid({ ra, dec, fovArcmin });
  const slots = [];
  const update = (slot, patch) => {
    if (signal.aborted) return;
    Object.assign(slot, patch);
    onUpdate?.(slot);
  };
  const run = async (slot, load) => {
    update(slot, { status: 'loading', error: null, progress: { done: 0, total: slot.progress?.total ?? 0 } });
    try {
      const frame = await load();
      if (frame?.errors?.length && !hasData(frame.data)) throw new Error(`${frame.errors.length} of ${frame.requested} files failed: ${frame.errors[0].error}`);
      const why = slot.source === 'spherex' && frame && thinStack(frame);
      if (why) update(slot, { status: 'empty', frame: Object.assign(frame, { note: why }) });
      else if (!frame || !hasData(frame.data)) update(slot, { status: 'empty', frame: frame || null });
      else update(slot, { status: 'ready', frame, mjd: frame.mjd, year: mjdYear(frame.mjd) });
    } catch (err) {
      if (signal.aborted || err?.name === 'AbortError') return;
      update(slot, { status: 'error', error: err?.message || String(err) });
    }
  };

  for (const [source, L] of Object.entries(LEGACY)) {
    if (!L.bands.includes(band)) continue;
    const slot = { id: source, source, label: L.label, year: null, mjd: null, span: L.span, status: 'loading', progress: { done: 0, total: 1 }, frame: null, error: null };
    const load = async () => {
      const mod = legacy[L.file];
      if (!mod) throw new Error(`${L.label} reader is not built yet`);
      const fn = (await mod())[L.fn];
      const frame = await fn(grid, band, { signal });
      update(slot, { progress: { done: 1, total: 1 } });
      return frame;
    };
    slot.retry = () => run(slot, load);
    slots.push(slot);
  }

  // SPHEREx: one slot per pass, filled in time order, two passes at a time.
  const ready = (async () => {
    const pointings = await loadPointings();
    const passes = findPasses(pointings, ra, dec, { fovArcmin });
    const b = getBand(band);
    const jobs = [];
    for (const pass of passes) {
      const need = Math.min(48, visitsForBand(b, pass.visits).length); // passStack's maxFrames
      if (!need) continue; // passes without frames in this band are listed by the UI from `passes`, not shown as slots
      const slot = {
        id: `spherex-${pass.id}`, source: 'spherex', label: pass.label, year: mjdYear(pass.mjdMean), mjd: pass.mjdMean, span: [pass.start, pass.end],
        status: 'loading', progress: { done: 0, total: need }, frame: null, error: null, pass,
      };
      const load = () => passStack(pass, band, grid, { signal, onProgress: (done, total) => update(slot, { progress: { done, total } }) });
      slot.retry = () => run(slot, load);
      slots.push(slot);
      jobs.push(slot);
    }
    for (const s of slots) onUpdate?.(s);
    let next = 0;
    const worker = async () => {
      while (next < jobs.length && !signal.aborted) {
        await jobs[next++].retry();
      }
    };
    await Promise.all([worker(), worker()]);
    return passes;
  })();

  for (const s of slots) if (s.source !== 'spherex') s.retry();
  return { grid, slots, ready, sortedSlots: () => sortSlots(slots) };
}

/** Slots in time order; legacy slots without a date yet sit at the middle of their span. */
export function sortSlots(slots) {
  const t = (s) => s.mjd ?? (s.span[0] + s.span[1]) / 2;
  return [...slots].sort((a, b) => t(a) - t(b));
}

/**
 * The single SPHEREx frames of a pass, for a spectrum: each { data, lambda, bandwidth, mjd, url }.
 * all = false: only the frames the current band used (already downloaded).
 * all = true: every frame of the pass on every detector (downloads the rest).
 */
export async function passFrames(slot, grid, band, { all = false, signal, onProgress } = {}) {
  const visits = all ? slot.pass.visits : visitsForBand(getBand(band), slot.pass.visits);
  let done = 0;
  const out = await Promise.all(
    visits.map((v) =>
      loadFrame(v, grid, { signal })
        .catch((err) => {
          if (err?.name === 'AbortError') throw err;
          return null;
        })
        .finally(() => onProgress?.(++done, visits.length)),
    ),
  );
  return out.filter(Boolean);
}

/** How many single frames a pass has in this band and in all. */
export const passCounts = (slot, band) => ({ band: visitsForBand(getBand(band), slot.pass.visits).length, all: slot.pass.visits.length });
