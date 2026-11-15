---
name: Skyblink
colors:
  paper: "oklch(0.15 0.012 262)"        # the dark room the images sit in
  panel: "oklch(0.19 0.014 262)"        # rail, strip and field wells
  well: "oklch(0.12 0.010 262)"         # behind the image and thumbnails
  hairline: "oklch(1 0 0 / 0.09)"
  ink: "oklch(0.93 0.008 90)"
  ink-muted: "oklch(0.72 0.015 262)"
  ink-faint: "oklch(0.56 0.015 262)"
  accent: "oklch(0.83 0.15 82)"         # blink amber: the action and the frame on screen
  accent-ink: "oklch(0.20 0.03 82)"
  survey-2mass: "oklch(0.76 0.12 28)"
  survey-wise: "oklch(0.80 0.12 150)"
  survey-spherex: "oklch(0.80 0.10 235)"
  gaia: "oklch(0.86 0.09 200)"
  danger: "oklch(0.70 0.17 25)"
typography:
  ui: { family: "Atkinson Hyperlegible Next Variable", size: 15px, weight: 400, lineHeight: 1.5 }
  title: { family: "Atkinson Hyperlegible Next Variable", size: "clamp(28px, 3vw, 44px)", weight: 700, lineHeight: 1.05, tracking: "-0.02em" }
  label: { family: "Atkinson Hyperlegible Next Variable", size: 13px, weight: 500, lineHeight: 1.3 }
  data: { family: "Overpass Mono", size: 13px, weight: 400, lineHeight: 1.4 }   # measured numbers only
radius: { precise: 2px, control: 6px, panel: 10px }
spacing: [2, 4, 8, 12, 16, 24, 40, 64, 96]
motion: { ease-out: "cubic-bezier(.22,1,.36,1)", durations: { press: 140ms, hover: 180ms, ui: 240ms } }
---

## North Star
A blink comparator, not a dashboard. The sky image is the page; everything else is quiet and explains what the image is.

## Posture
Utility. Dark room, restrained accent. Motion is feedback only; the one thing that moves is the sky.

## The idea
On this page, the 27 years between 2MASS, WISE and SPHEREx become a film strip you can scrub: one patch of sky, every date we have, one matched filter. The live thing is the movie itself. It plays Barnard's Star the moment the page opens, and the coordinate box sits right above it.

## Screens

### The blink screen (the only page for the first release)
Who: a curious visitor from a share link, a judge, or a citizen scientist coming from Backyard Worlds. One job: see whether anything at this spot moved or changed. Primary action: enter RA and Dec and press **Blink**.

Desktop (1024 and up), top to bottom:
1. **Top bar**, 56px. Wordmark "Skyblink" at left. The coordinate form: one text field ("RA, Dec in degrees or 17h57m48s +04d41m36s"), the **Blink** button (the only solid amber button on the screen). To its right, five quiet text buttons for the test targets: Barnard's Star, Epsilon Indi B, WISE 0855, RW Aurigae, R Draconis. Far right: "How it works" (opens a plain dialog) and, later, "Join the hunt".
2. **Stage and rail**, side by side.
   - **Stage** (left): a square image, as large as fits (`min(100vh - 56px - 190px, 100vw - 400px)`), in a `well`. Over it, in the top-left corner, the frame caption in `data` type: survey name in its survey colour, the date, the band ("as WISE W2, 4.6 µm"), and "23 frames added". In the bottom-left, a scale bar ("1 arcmin") and the N/E compass. Gaia rings and the crosshair are SVG laid over the canvas. Under the caption, when it applies, one line saying what the frame is not ("2MASS dates run 1997 to 2001").
   - **Rail** (right, 344px, scrolls on its own if it must): three groups separated by space, not boxes.
     - **Look through**: a segmented control of matched filters (J, H, Ks, W1, W2) with one line under it: "SPHEREx's 102 colours are added up to imitate this older filter, so all three telescopes see the same light." A second row: SPHEREx's own six detectors (D1 to D6), which removes 2MASS and WISE from the strip and says so.
     - **Compare**: Blink, Subtract, Add, Side by side. Subtract shows frame B minus frame A on a mid-grey ground (brighter is white, fainter is black) and names both ("2026 minus 2010"). Field of view slider, 2 to 20 arcmin, with the download size it costs ("about 9 MB"). Speed. Invert. Gaia rings on/off.
     - **What you clicked** (hidden until the visitor clicks a source): position per date as a small table, the fitted motion in arcsec per year with its direction, the Gaia DR3 match if any ("Known star, Gaia says 10.39 arcsec/yr"), and the spectrum per SPHEREx pass.
3. **The film strip** (the signature), 190px, full width under the stage. A row of equal thumbnails, one per date, each with its survey colour as a 3px top edge, the year large, the month small, and a progress fill while its frames arrive ("7 of 12"). Under the thumbnails, a thin ruler drawn to true time scale from 1997 to today, with a leader line from each thumbnail to its real date, so the 11-year and 15-year gaps and the tight cluster of SPHEREx passes are visible at a glance. The frame on screen has an amber outline. Click a thumbnail to hold it. Play/pause sits at the strip's left end.

Phone (under 720): the coordinate form, then the stage at full width, then the strip as a horizontally scrolling row, then the rail's three groups as plain stacked sections. Test targets become a horizontally scrolling row of chips. Targets are at least 44px.

Keyboard: Space play/pause, Left/Right step, 1 to 9 jump to a frame, S subtract, G Gaia rings. Shown in "How it works".

### States
- **Opening with no coordinates**: Barnard's Star plays at once. Each test target carries its own best band (Barnard's Star Ks, Epsilon Indi B Ks, WISE 0855 W2, RW Aurigae W1, R Draconis Ks). A title line above the stage: "See the sky change over 27 years".
- **Loading**: thumbnails fill as frames arrive; the stage shows the first finished date at once rather than waiting for all.
- **A survey cannot be reached**: its thumbnail stays in the strip, greyed, with "2MASS did not answer" and a Retry button. The movie plays without it.
- **No SPHEREx data here in this band yet**: say so in the stage, with the date of the newest pass that covers the spot, and offer the bands that do have data.
- **Bad coordinates**: the field gets a `danger` hairline and one line under it with an example. Nothing else changes.
- **Embed** (`?embed=1`): stage and strip only, with a small "Open in Skyblink" link.

### URL
`?ra=269.45208&dec=4.69339&fov=6&band=Ks&mode=blink&a=0&b=4&embed=1`. Every control writes to the URL (replaceState), so any view can be shared or embedded. Numbers are parsed strictly; nothing from the URL is ever written into the page as HTML.

## Colours
- Amber means "this is the action" or "this is the frame on screen". Nothing else is amber.
- One colour per survey (2MASS coral, WISE green, SPHEREx blue), used only on thumbnails' top edge, the caption's survey name and the ruler ticks.
- Gaia cyan only for Gaia rings and the Gaia line in "What you clicked".
- Sky images are greyscale (astronomers' default; colour would suggest data that is not there). Invert is offered.

## Typography
Atkinson Hyperlegible Next for everything a person reads; Overpass Mono only for measured numbers (coordinates, dates, wavelengths, fluxes). Weights 400, 500, 700. Tabular numbers wherever digits change.

## Layout and surfaces
Flat at rest: no shadows, no cards. Groups are separated by 24 to 40px of space and hairlines. The only wells are the image and the thumbnails. One radius per job: 2px on images (they are data), 6px on controls, 10px on the dialog.

## Motion
Press 140ms, hover 180ms, menus 240ms, all on `ease-out`; named properties only. The blink itself is an instant cut (a cross-fade would hide small shifts). Under reduced motion the movie does not autoplay: it shows the newest SPHEREx frame with the Play button offered.

## Named rules
1. **The image is the brightest thing.** No surface in the chrome is lighter than `panel`; no white panels.
2. **Every frame says where it came from.** Survey, date, band, number of files, and a "files" disclosure listing the archive URLs.
3. **One colour per survey**, and amber only for the action and the current frame.
4. **Mono is for measured numbers.**
5. **Say what it is not.** Where a frame is approximate (2MASS date range, a top-hat stand-in for a filter curve, a host that did not answer), the screen says so in plain words next to the frame.
6. **Never invented.** No placeholder images, counts or sample rows. An absent thing is shown as absent.

## Do and don't
- Do keep labels as words a visitor uses: "Look through", "Compare", "23 frames added", not `bandId` or `n`.
- Do keep focus rings visible (2px amber, 2px offset) and zoom unlocked.
- Don't add gradients, glass, glows, eyebrow labels, emoji or decorative icons.
- Don't animate the image except by cutting between frames.
