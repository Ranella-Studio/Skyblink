# Skyblink

**See the sky change over 27 years.** Type a position, and Skyblink plays real images of that patch of sky from 2MASS (about 1999), WISE (2010) and NASA's SPHEREx mission (2025 and 2026) as one short movie. Anything that moved or changed jumps out.

Built for the NASA Space Apps Challenge 2026, "Planet X and SPHEREx". Not an official NASA product.

- Live site: https://ranella-studio.github.io/Skyblink/
- Results on the challenge's five test targets: [docs/TARGETS.md](docs/TARGETS.md)
- Everything we reused or cite: [REFERENCES.md](REFERENCES.md)

## The problem with blinking SPHEREx

SPHEREx photographs each spot of sky about a hundred times in one visit, but every one of those frames is at a different wavelength, because the filter changes across the detector. The same wavelength only comes back six months later. If you flip between raw frames, stars flicker because their colour differs, not because anything happened. And SPHEREx has only been flying since 2025, so on its own it shows about a year of motion.

## What Skyblink does about it

1. **One matched filter.** For each visit, Skyblink adds up the SPHEREx frames through the response curve of an older telescope's filter (2MASS J, H, Ks or WISE W1, W2). The result is the picture that telescope would have taken that month.
2. **A long timeline.** It then fetches the real 2MASS and WISE images of the same spot and puts all of them on the same pixel grid. You blink 1999 against 2010 against 2025 and 2026, like for like.
3. **Measure and check.** Click anything. Skyblink measures where it is on each date, fits its motion in arcsec per year, shows its brightness per date and its SPHEREx spectrum, and tells you whether Gaia already knows the star and how fast Gaia says it moves.

You can also look through SPHEREx's own six detectors, subtract any date from any other, add dates together, choose the field of view from 2 to 20 arcmin, and share or embed any view: the address bar always holds the full state (`?ra=269.45208&dec=4.69339&fov=6&band=Ks`, add `&embed=1` for a frame without the controls).

## It works: the five test targets

| Target | What Skyblink shows |
|---|---|
| Barnard's Star | Moves 271 arcsec between 2MASS (2000) and SPHEREx (2026): 10.34 arcsec a year. Gaia says 10.39. |
| Epsilon Indi B | The brown dwarf pair drifts 126 arcsec in 26.9 years: 4.69 arcsec a year. Published: 4.71. |
| WISE 0855-0714 | Invisible in 2MASS. SPHEREx finds it 126 arcsec from its 2010 WISE position, at 6 to 10 times the noise, at the brightness WISE measured (0.60 against 0.57 mJy). |
| RW Aurigae | Stays put, but faded 35% at 3.4 microns and 47% at 4.6 microns between Sep 2025 and Sep 2026. |
| R Draconis | Nine SPHEREx visits; about 40% fainter at 4.6 microns in Jul 2026 than in Jun 2025. Too bright to measure at shorter wavelengths, and the tool says so. |

Methods, tables and limits are in [docs/TARGETS.md](docs/TARGETS.md).

## Real data only

Nothing in Skyblink is simulated, mocked or drawn by hand. Every pixel comes from a public archive at the moment you ask:

| Data | Source | How it is read |
|---|---|---|
| SPHEREx Level 2 images (Data Release 1, Quick Releases 2 and 3) | NASA/IPAC IRSA, public Amazon S3 bucket `nasa-irsa-spherex` | Your browser reads only the rows it needs from each 70 MB file |
| WISE 2010 (AllWISE Atlas) | IRSA, S3 bucket `nasa-irsa-wise` | Same way |
| 2MASS Atlas images with exact observing dates | IRSA | Through the small relay in `server/` (IRSA does not accept calls from web pages); the five test targets ship with their real cutouts so they work without it |
| Gaia DR3 stars and motions | ESA Gaia, copy hosted by STScI on S3 | Read in the browser |
| Filter response curves | SVO Filter Profile Service | Stored in the repository |

When a source does not answer, its frame is shown as missing, with the reason. Each frame lists the files it was made from.

## New data arrives by itself

SPHEREx releases new weeks of data all the time. A GitHub Action runs every day, reads the headers of any new files in NASA's bucket, adds them to a compact index of where SPHEREx was pointing (101,123 pointings as of 14 November 2026) and redeploys the site. Nobody has to touch anything when a new release lands.

## Run it yourself

```
cd web
npm ci
npm run dev                      # the site, at http://localhost:5173
npm test                         # unit tests, no network needed
SKYBLINK_LIVE=1 npm test         # also the tests that read the real archives
node ../tools/verify-targets.mjs # rerun the five test targets
```

To run the site with live 2MASS for any position: `cd web && VITE_IRSA_PROXY=/irsa npm run build && node ../server/server.mjs` (or deploy `render.yaml`).

## How it is built

A static site in plain JavaScript with Vite, no framework, and no server needed except the optional 2MASS relay. `web/src/fits` reads FITS files over HTTP range requests; `web/src/engine` groups frames into visits, weights them through a filter and stacks them; `web/src/engine/legacy` reads WISE and 2MASS; `web/src/ui` is the screen. The design is written down in [docs/DESIGN.md](docs/DESIGN.md).

## What we reused

The FITS reader, sky maths and pointing index come from our own first attempt at this challenge, [Ranella-Studio/Nasa-Challenge](https://github.com/Ranella-Studio/Nasa-Challenge). Each of those files says so on its first line and is listed in [REFERENCES.md](REFERENCES.md). Everything that makes this tool what it is (matched filters, visits, the long timeline, WISE and 2MASS readers, the screen, the tests on the five targets) was written during the hackathon.

## Licence

MIT. Data belongs to its providers: NASA/JPL-Caltech (SPHEREx, WISE), UMass/IPAC (2MASS), ESA (Gaia).
