// A north-up, east-left tangent-plane (TAN) pixel grid centred on a sky position.
// Frame images on a grid are Float32Array(n*n), index row*n + col, NaN = no data.

import { tanProject, tanDeproject } from '../data/sky-math.js';

/** scale in arcsec/pixel; n = odd integer nearest fovArcmin*60/scale. */
export function makeGrid({ ra, dec, fovArcmin, scale = 3.0 }) {
  const x = (fovArcmin * 60) / scale;
  let n = 2 * Math.round((x - 1) / 2) + 1;
  if (n < 1) n = 1;
  return { ra0: ra, dec0: dec, n, scale };
}

/** [raDeg, decDeg] of pixel centre (col, row); row 0 = north edge, col 0 = east edge. */
export function gridToSky(grid, col, row) {
  const h = (grid.n - 1) / 2;
  return tanDeproject(grid.ra0, grid.dec0, ((h - col) * grid.scale) / 3600, ((h - row) * grid.scale) / 3600);
}

/** Fractional [col, row] of a sky position, or null if behind the tangent point. */
export function skyToGrid(grid, raDeg, decDeg) {
  const p = tanProject(grid.ra0, grid.dec0, raDeg, decDeg);
  if (!p) return null;
  const h = (grid.n - 1) / 2;
  return [h - (p[0] * 3600) / grid.scale, h - (p[1] * 3600) / grid.scale];
}
