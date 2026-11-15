// Robust statistics over the finite values of an array (NaN = no data).

export function finiteSorted(values) {
  const out = [];
  for (const v of values) if (Number.isFinite(v)) out.push(v);
  return Float64Array.from(out).sort();
}

export function median(values) {
  const s = finiteSorted(values);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Median absolute deviation (raw, not scaled to sigma). */
export function mad(values, med = median(values)) {
  const dev = [];
  for (const v of values) if (Number.isFinite(v)) dev.push(Math.abs(v - med));
  return median(dev);
}

/** Sigma-clipped median and sigma (sigma = 1.4826 MAD), clipping at k sigma until stable. */
export function clippedStats(values, k = 3, iterations = 10) {
  let kept = finiteSorted(values);
  let med = median(kept);
  let sigma = 1.4826 * mad(kept, med);
  for (let i = 0; i < iterations && sigma > 0; i++) {
    const next = kept.filter((v) => Math.abs(v - med) <= k * sigma);
    if (next.length === kept.length) break;
    kept = next;
    med = median(kept);
    sigma = 1.4826 * mad(kept, med);
  }
  return { median: med, sigma };
}
