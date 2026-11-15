// Regenerate the matched bands of web/src/engine/filters.json from the SVO
// Filter Profile Service response curves in tools/svo/*.dat (Angstrom, relative
// response). Detector bands D1-D6 are kept as they are.
//   node tools/build-filters.mjs

import { readFileSync, writeFileSync } from 'node:fs';

const OUT = new URL('../web/src/engine/filters.json', import.meta.url);
const SVO = 'SVO Filter Profile Service (Rodrigo, Solano & Bayo 2012; Rodrigo & Solano 2020), https://svo2.cab.inta-csic.es/theory/fps/';
const MATCHED = [
  { id: 'J', name: '2MASS J (matched)', file: '2MASS_2MASS.J.dat', svo: '2MASS/2MASS.J', ref: 'Cohen, Wheaton & Megeath 2003, AJ 126, 1090' },
  { id: 'H', name: '2MASS H (matched)', file: '2MASS_2MASS.H.dat', svo: '2MASS/2MASS.H', ref: 'Cohen, Wheaton & Megeath 2003, AJ 126, 1090' },
  { id: 'Ks', name: '2MASS Ks (matched)', file: '2MASS_2MASS.Ks.dat', svo: '2MASS/2MASS.Ks', ref: 'Cohen, Wheaton & Megeath 2003, AJ 126, 1090' },
  { id: 'W1', name: 'WISE W1 (matched)', file: 'WISE_WISE.W1.dat', svo: 'WISE/WISE.W1', ref: 'Wright et al. 2010, AJ 140, 1868; Jarrett et al. 2011, ApJ 735, 112' },
  { id: 'W2', name: 'WISE W2 (matched)', file: 'WISE_WISE.W2.dat', svo: 'WISE/WISE.W2', ref: 'Wright et al. 2010, AJ 140, 1868; Jarrett et al. 2011, ApJ 735, 112' },
];

export function parseDat(text) {
  const rows = text
    .split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter((r) => r.length >= 2 && r.every(Number.isFinite));
  const peak = Math.max(...rows.map((r) => r[1]));
  return {
    lambda: rows.map((r) => +(r[0] / 1e4).toFixed(5)), // Angstrom -> micron
    response: rows.map((r) => +(r[1] / peak).toPrecision(5)), // peak = 1
  };
}

const json = JSON.parse(readFileSync(OUT, 'utf8'));
json.note =
  "Bands a user can pick. kind 'detector': every frame of one SPHEREx detector (lambda gives its span). kind 'rsr': relative response curve (peak 1), wavelength in microns, linearly interpolated, 0 outside the table. kind 'tophat': response 1 between lambda[0] and lambda[1]. Regenerate the matched bands with tools/build-filters.mjs.";
json.bands = json.bands.map((b) => {
  const m = MATCHED.find((x) => x.id === b.id);
  if (!m) return b;
  const curve = parseDat(readFileSync(new URL(`svo/${m.file}`, import.meta.url), 'utf8'));
  return { id: m.id, name: m.name, kind: 'rsr', ...curve, source: `${SVO}, filter ${m.svo}; ${m.ref}` };
});
writeFileSync(OUT, JSON.stringify(json, null, 1) + '\n');
console.log(json.bands.map((b) => `${b.id} ${b.kind} ${b.lambda[0]}-${b.lambda.at(-1)} um (${b.lambda.length} points)`).join('\n'));
