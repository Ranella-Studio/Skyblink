# The five test targets: what Skyblink measured

The challenge asks every tool to be tested on Barnard's Star, Epsilon Indi B, WISE 0855, RW Aurigae and R Draconis. These are the results, measured on real images only. Anyone can rerun them:

```
node tools/verify-targets.mjs     # SPHEREx: every visit, every filter
node tools/verify-legacy.mjs      # WISE 2010 and 2MASS
node tools/check-wise0855.mjs     # WISE 0855 at its old and new place, in both surveys
```

Both scripts write their numbers and contact sheets into `docs/targets/<target>/`. The numbers below come from the run of 15 November 2026 (SPHEREx Data Release 1 and Quick Release 3, pointing index of 14 November 2026).

**How the measurements are made.** Each image is a 6 arcmin field at 3 arcsec per pixel. Position is the flux-weighted centroid within 12 arcsec of where the object's published motion puts it on that date. Brightness is the sum inside a 12 arcsec radius minus the median of an 18 to 30 arcsec ring. Noise is the spread of the same aperture placed on empty sky in the same image.

## Moving objects

| Target | Compared | Time apart | Measured motion | Published motion |
|---|---|---|---|---|
| Barnard's Star | 2MASS Ks, 28 May 2000, to SPHEREx as Ks, Aug 2026 | 26.2 yr | 271.2 arcsec, **10.34 arcsec/yr** | 10.39 arcsec/yr (Gaia DR3) |
| Barnard's Star | WISE W1, 2010, to SPHEREx as W1, Aug 2026 | 16.2 yr | 168.5 arcsec, **10.41 arcsec/yr** | 10.39 arcsec/yr |
| Epsilon Indi B | 2MASS Ks, 8 Nov 1999, to SPHEREx as Ks, Sep 2026 | 26.9 yr | 126.1 arcsec, **4.69 arcsec/yr** | 4.71 arcsec/yr (Gaia DR3, Epsilon Indi A) |
| Epsilon Indi B | WISE W2, 2010, to SPHEREx as W2, Sep 2026 | 16.2 yr | 76.4 arcsec, **4.72 arcsec/yr** | 4.71 arcsec/yr |
| WISE 0855-0714 | WISE W2, 2010, to SPHEREx as W2, Nov 2025 | 15.3 yr | 125.6 arcsec west, 10.7 north, **8.24 arcsec/yr** | 8.15 arcsec/yr (Luhman and Esplin 2016) |

All three agree with the published motions to about 1%. The leftover difference for WISE 0855 is the size expected from its parallax (0.43 arcsec) and from the WISE image being a coadd of two visits six months apart.

**Barnard's Star.** In every SPHEREx visit (Aug 2025, Mar 2026, Aug 2026) the star sits within 1.2 arcsec of the predicted place in every filter. Between the first and last SPHEREx visits alone, one year apart, it moves 10.2 arcsec, which is 1.7 SPHEREx pixels: visible by eye in the blink.

**Epsilon Indi B.** The brown dwarf pair is not resolved (the two are 0.7 arcsec apart; a SPHEREx pixel is 6.15 arcsec). The blended dot is detected at about 300 times the noise in every visit and follows the motion of its parent star.

**WISE 0855-0714.** The coldest known brown dwarf, about 250 K. It does not appear in 2MASS at all, and in SPHEREx's short-wavelength filters there is nothing at its position. In the filter matched to WISE W2 (4.6 microns), SPHEREx detects it at the predicted place in all three visits:

| SPHEREx visit | Frames added | Signal to noise | Brightness as W2 | Share of the filter sampled |
|---|---|---|---|---|
| May 2025 | 10 | 6.1 | 0.44 mJy | 39% |
| Nov 2025 | 42 | 9.6 | 0.60 mJy | 84% |
| May 2026 | 33 | 8.8 | 0.58 mJy | 77% |

WISE itself measured 0.57 mJy in 2010, in the same aperture on the AllWISE image, so the raw brightness comes back to within about 7% for an object that no single SPHEREx frame shows.

The stronger check is the blink itself: measure both images at both places.

| Place on the sky | WISE W2, 2010 | SPHEREx as W2, Nov 2025 |
|---|---|---|
| Where the brown dwarf was in 2010 | 0.57 mJy | 0.15 mJy |
| Where it is in Nov 2025, 125 arcsec west | 0.08 mJy | 0.61 mJy |

The object left one place and turned up at the other. Neither place is quite empty without it: a faint background source sits in each aperture (0.15 and 0.08 mJy). With those taken off, the brown dwarf alone is about 0.42 mJy in WISE and 0.53 mJy in SPHEREx, a difference of about 25%. So read the brightness agreement as "the same object at roughly the same brightness", not as a 7% calibration. (Measured 15 Nov 2026 on a 6 arcmin field centred between the two positions; the Nov 2025 value is 0.61 here and 0.60 in the table above because the grid centre differs.)

## Variable stars

**RW Aurigae.** It holds still (centroids within 1 arcsec of the catalogue position in every image). Its brightness does not:

| SPHEREx visit | as J | as Ks | as W1 | as W2 |
|---|---|---|---|---|
| Sep 2025 | 217 mJy | 583 mJy | 1347 mJy | 2526 mJy |
| Mar 2026 | 286 mJy | 603 mJy | 1211 mJy | 1938 mJy |
| Sep 2026 | 317 mJy | 559 mJy | 875 mJy | 1350 mJy |

Over one year it faded by 35% at 3.4 microns and 47% at 4.6 microns, while brightening by 46% at 1.2 microns and staying level at 2.2 microns. For scale, Barnard's Star, which is steady, measured the same way changes by 3% in W1 and W2 between visits, and by up to 25% in J and Ks, where it is bright enough to trouble the detector. So the long-wavelength fading of RW Aurigae is far outside the method's scatter; the J change is suggestive, not secure.

**R Draconis.** A Mira variable with a 246-day period, close to the north ecliptic pole, so SPHEREx sees it in most weeks: nine visits of about six weeks each from Apr 2025 to Sep 2026. It is so bright that its core overflows SPHEREx's detector at the J, Ks and W1 wavelengths; the pipeline flags those pixels and Skyblink refuses to give a brightness there instead of inventing one. At W2 wavelengths it is measurable: 43, 49, 36, 41, 41, 31 and 28 Jy across the visits that sampled the filter, a fall of about 40% from Jun 2025 to Jul 2026. The share of the filter sampled varies from 25% to 83% between those visits, so read this as a real, large change with a loose scale, not as a calibrated light curve.

## What these tests say about the method

- **Positions** are good to about 1 arcsec (a sixth of a SPHEREx pixel) for anything detected at 10 times the noise or better.
- **Matched filters work.** SPHEREx frames added through the 2MASS and WISE response curves reproduce WISE's own W2 brightness for Epsilon Indi B to about 4% (26 mJy against WISE's 25 mJy). For WISE 0855 the raw apertures agree to 7%, and to about 25% once the faint background source in each aperture is taken off.
- **A visit does not always sample a whole filter.** Each visit catches a spot at a different set of wavelengths. Skyblink reports the share of the filter that was sampled, hides a frame when it is under 35%, and says so on the frame when it is under 80%. Epsilon Indi B shows why: its W1 brightness is 19 and 17 mJy in the two visits that sampled the filter fully, and a meaningless 47 mJy in a visit that sampled under 1% of it.
- **Very bright stars saturate.** R Draconis overflows the detector at every wavelength below 4 microns. The pipeline flags those pixels, and Skyblink gives no brightness there.
- **Old images of bright stars are saturated too**, so Skyblink never compares brightness between different telescopes in one sentence, only within one telescope and filter.
