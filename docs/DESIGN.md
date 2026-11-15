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

## Console layout (supersedes "Stage and rail" above for 1100px and wider)

The owner's bar: it should look like something a NASA archive could put its name on. That means rigour, not decoration: a strict grid, real axes, every number labelled with its unit, and credits in plain sight. It must not carry NASA's logo or imply it is an official NASA product.

**Frame.** A three-column console on a 12-column grid with 24px gutters and 24px outer margins:
- **Left rail, 296px: "Controls".** Three groups in this order: Look through (filters 1 to 5, then the six detectors), Compare (mode, A and B pickers when subtracting or adding), Display (palette, field of view, speed, HUD, Gaia rings). Each group opens with a 12px label in `ink-muted`, 500 weight, sentence case, and groups are 32px apart with a hairline between them.
- **Centre: the stage**, a square as large as the space allows (`min(100vh - 56px - 212px - 72px, 100vw - 296px - 360px - 96px)`), centred in its column.
- **Right rail, 360px: "Readout".** Top: a definition list for the frame on screen, one row each: Telescope, Date, Filter, Frames added, Wavelengths, Pixel scale, Flags (the three most common flag names with counts), Source files (a disclosure). Labels left in `ink-muted`, values right-aligned in the `data` type. Under it "What you clicked" (positions, motion, brightness, Gaia match), then the spectrum. When nothing is clicked, one quiet line: "Click a star to measure it."
- Between 720 and 1100px the right rail drops under the stage; under 720px everything stacks (stage, strip, readout, controls).

**Stage chrome.** The image carries no text on top of it except the HUD when the HUD is on.
- A header strip above the image, same width, 36px: the survey name in its survey colour, then date, filter and frames in `data` type, separated by 16px gaps (not dots). At the right end, "frame 3 of 5".
- Real axes: a 1px `hairline` border around the image with tick marks outside it every arcminute (every 5 above 12 arcmin fields), labelled along the bottom and left as offsets from the centre in arcmin ("-2′", "0", "+2′"), `data` type at 11px, `ink-faint`. East is left; put a small "E" at the left end of the bottom axis and "N" at the top of the left axis. This replaces the compass and scale bar.
- A footer strip under the image, 28px: the centre coordinates in sexagesimal at left, the note for this frame (the "say what it is not" line) at right in `ink-muted`.
- While a date is loading, the image area shows the last ready frame dimmed to 40% with a centred `data` line ("Adding 12 of 33 frames"), never a spinner graphic and never an empty black square if any frame is ready.

**Film strip.** Height 212px. Thumbnails 132px square with 12px gaps, left-aligned after a 64px transport block (Play/Pause as an icon button with a text label under it, and step buttons). Under each thumbnail: the year in 20px `data` type, the telescope and month in 12px `ink-muted`. Between neighbouring thumbnails, centred on the gap and vertically at the thumbnails' middle, the elapsed time in a small pill on `panel` ("+10.2 yr"). The ruler: a 1px line with year ticks every year and labels every five; connectors from thumbnail to date are straight elbow lines (down, across, down) in that survey's colour at 60% opacity, 1px, and the current frame's connector is amber at full strength. No curves.

**Header and footer.**
- Header 56px: the mark and wordmark at left. The mark is two 8px discs, one amber and one `ink-faint`, overlapping by a third (a star and where it used to be). Beside the wordmark, in `ink-muted` 13px: "SPHEREx time-domain viewer". Then the coordinate form (field 320px, `data` type inside), the **Blink** button, a "Missions" menu button that lists the five missions with their one-line briefings, and at the far right "How it works".
- A footer bar, 32px, `ink-faint` 12px: "Data: NASA/JPL-Caltech SPHEREx and WISE, 2MASS (UMass/IPAC), ESA Gaia. Built for NASA Space Apps 2026. Not an official NASA product." and a link to the source code.

**Controls.**
- Segmented controls: 36px tall, `well` track, the selected segment on `panel` with a 1px `hairline` and `ink` text, others `ink-muted`; key caps (1 to 5) as 10px `data` type in the segment's top-right corner.
- Sliders: 2px track, 14px round thumb in `ink`, amber only while dragging or focused; the value right-aligned in `data` type on the label row.
- Toggles (HUD, Gaia rings): real switches, 32x18px, not checkboxes.
- The only solid amber surface on the screen is the **Blink** button; the frame on screen is marked by an amber 2px outline in the strip.
- Every number has its unit, with a no-break space. Tabular numbers everywhere.

**Type.** 15px body; 13px labels; 12px captions; 20px for the strip years; the mission briefing line above the stage at 17px `ink`, at most 80 characters wide, with the mission name before it in 13px `ink-muted`. Nothing else is larger. No uppercase runs, no letter-spaced caps.

**Quality bar for the review screenshots.** Shared left edges: the wordmark, the left rail and the strip's transport block start on the same x. The stage header strip, image and footer strip share one width. No element touches the viewport edge. Nothing overlaps at 1280x800 or 1440x900, and the phone layout at 390px has no horizontal scroll.
