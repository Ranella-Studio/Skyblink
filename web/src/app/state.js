// View state <-> URL query. Every number is parsed strictly; anything that
// does not parse falls back to the default, and nothing here touches the DOM.

export const MATCHED = ['J', 'H', 'Ks', 'W1', 'W2'];
export const DETECTORS = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'];
export const BANDS = [...MATCHED, ...DETECTORS];
export const MODES = ['blink', 'subtract', 'add', 'side'];
export const FOV_MIN = 2;
export const FOV_MAX = 20;

// Fast movers are centred where they were midway through their dates (from the
// catalogue position and proper motion), so the whole 1999-2026 track fits a
// 6 arcmin field: Barnard's Star moves 4.7 arcmin in that time.
// Barnard: J2000 269.45208 +4.69339, pm -801.6 +10362.4 mas/yr -> 2012.5.
// Epsilon Indi B: J2000 331.04383 -56.78269, pm +3966.7 -2536.2 -> 2012.5.
// WISE 0855: 2010.5 133.795129 -7.245147, pm -8123.7 +673.3 (Luhman & Esplin 2016) -> 2018.0 (it is too faint for 2MASS).
// Each target is also a guided mission: choosing it sets target, field and filter, and shows `brief`.
export const TARGETS = [
  { id: 'barnard', name: 'Barnard’s Star', ra: 269.449287, dec: 4.729371, fov: 6, band: 'Ks', brief: 'The fastest star in the sky. Watch it climb north, about 4.5 arcmin since 2MASS saw it in 2000.' },
  { id: 'eps-indi-b', name: 'Epsilon Indi B', ra: 331.068976, dec: -56.791496, fov: 6, band: 'Ks', brief: 'Two brown dwarfs 12 light-years away. Follow the faint dot drifting south-east, 4.7 arcsec a year.' },
  { id: 'wise0855', name: 'WISE 0855', ra: 133.778068, dec: -7.243744, fov: 6, band: 'W2', brief: 'The coldest known brown dwarf. Invisible to 2MASS, a faint dot for WISE in 2010, and SPHEREx finds it again 2 arcmin to the west.' },
  { id: 'rw-aur', name: 'RW Aurigae', ra: 76.95641, dec: 30.40141, fov: 6, band: 'W1', brief: 'A young star that dims when dust crosses it. It holds still, so watch its brightness, not its place.' },
  { id: 'r-dra', name: 'R Draconis', ra: 248.1676, dec: 66.755, fov: 6, band: 'W2', brief: 'A red giant that swells and shrinks every 246 days. SPHEREx passes it often; watch it brighten and fade.' },
];
export const NO_MISSION = 'See the sky change over 27 years';

export const DEFAULTS = { ra: TARGETS[0].ra, dec: TARGETS[0].dec, fov: 6, band: 'Ks', mode: 'blink', a: null, b: null, embed: false };

// A plain decimal: optional sign, digits, optional fraction. No exponents, hex, spaces or "Infinity".
const NUM = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;
function num(s, lo, hi) {
  if (s == null || !NUM.test(s)) return null;
  const v = Number(s);
  return v >= lo && v <= hi ? v : null;
}
function int(s, lo, hi) {
  return s != null && /^\d{1,3}$/.test(s) ? num(s, lo, hi) : null;
}

/** URLSearchParams or query string -> full state (defaults where absent or invalid). */
export function readState(search) {
  const p = new URLSearchParams(search);
  const ra = num(p.get('ra'), 0, 360);
  const dec = num(p.get('dec'), -90, 90);
  const both = ra != null && dec != null;
  const band = BANDS.includes(p.get('band')) ? p.get('band') : null;
  return {
    ra: both ? ra % 360 : DEFAULTS.ra,
    dec: both ? dec : DEFAULTS.dec,
    fov: num(p.get('fov'), FOV_MIN, FOV_MAX) ?? DEFAULTS.fov,
    band: band ?? (both ? DEFAULTS.band : TARGETS[0].band),
    mode: MODES.includes(p.get('mode')) ? p.get('mode') : DEFAULTS.mode,
    a: int(p.get('a'), 0, 999),
    b: int(p.get('b'), 0, 999),
    embed: p.get('embed') === '1',
    given: both,
  };
}

/** State -> query string ("?ra=...&dec=..."), short decimals, defaults for mode/a/b/embed left out. */
export function writeState(s) {
  const p = new URLSearchParams();
  p.set('ra', +s.ra.toFixed(6) + '');
  p.set('dec', +s.dec.toFixed(6) + '');
  p.set('fov', +s.fov.toFixed(1) + '');
  p.set('band', s.band);
  if (s.mode !== 'blink') p.set('mode', s.mode);
  if (s.a != null) p.set('a', String(s.a));
  if (s.b != null) p.set('b', String(s.b));
  if (s.embed) p.set('embed', '1');
  return '?' + p.toString();
}

/** A target by name, case- and punctuation-insensitive ("barnards star", "WISE 0855"). */
export function findTarget(text) {
  const key = (t) => t.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
  const k = key(text);
  return k ? TARGETS.find((t) => key(t.name) === k || t.id.replace(/-/g, '') === k) || null : null;
}
