# Preview timeline performance

## 17 November 2026 regression repair

PR #127 (`1d209eb`) made a settled overview write its opacity during every map
render. MapLibre schedules a style/source update for that public setter even
when the value is unchanged. Its synchronous image-source notifications also
reentered image installation before ownership had transferred.

Overview source notifications now coalesce after installation. Settled images
and unchanged opacity leave the map alone. Preparation wakes on useful work,
selection, budget release and lifecycle events. Wind admission reads the
selected source's horizon estimate, retains a pan margin, and admits a usable
selected overview when the whole horizon exceeds capacity. Numeric-cache
pressure waits for numeric capacity; speculative work preserves the display.
Same-frame viewport replacements compare image identity, and a native image
that cannot obtain display memory leaves its preview visible. Real capacity
release resumes deferred display and expands a constrained native horizon.

Regression tests exercise the real raster overlay and overview together:

| Check | PR #127 | Repaired |
| --- | ---: | ---: |
| Paint-property writes in 120 settled render/idle pairs | 240 | 0 |
| Preparation-budget checks in those pairs | 480 | 0 |
| Nested image updates with synchronous source events | 2 | 0 |
| Source memory-accounting calls per admission query, 40 prepared times | 41 | 1 |

The source-event fixture caps recursion to keep the failing test bounded.
These are operation counts. Browser frame times and GPU pixel behavior remain
release checks. The original patch environment could not open its local page.
A later local preview of this revision, against production GFS build
`20261117T002820Z-7a0954c0-dddc-46ce-a131-78a60c0c9f3d` at latitude 0,
longitude -10.8614, zoom about 1, opacity 0.5, and hybrid wind, reached
preview and wind readiness 40/40. Day changes and playback stayed responsive
and settled on the selected frame. Pixel capture, regional benchmarks, and
physical devices were not run. The live merged page reproduced preparation
stalls, capacity errors, a blank map and unresponsive controls.

## Earlier viewport measurements

Viewport overviews showed all 39 requested times during both cold desktop sweeps
at a 40 ms response floor. Fine detail follows separately; preparation transfers
additional coarse data and can delay cold refinement.

[Preview build checks](../apps/preview/vite.config.ts) cap the startup JavaScript
bundle (MapLibre GL, DEM/OpenFreeMap soaring basemap, raster previews, numeric wind, and
the pinned `@deck.gl/*`/`@luma.gl/*`/`weatherlayers-gl` renderer set) at
**1,200,000 B gzip** and each lazy chunk (the on-demand `@av/windgram` renderer)
at **300,000 B gzip**.
The 16 November 2026 baseline measured 391,946 B startup and 27,336 B lazy before
the renderer migration. The timeline
figures below remain the 13 November capture.

```sh
pnpm bench:preview --baseline 2f34b65 --channel chrome --frames 40 --delay-ms 40 --out output/timeline-40.json
pnpm bench:preview --baseline 2f34b65 --channel chrome --frames 40 --scenario cold --delay-ms 250 --out output/timeline-250.json
pnpm bench:preview --baseline 2f34b65 --channel chrome --scenario smoke --frames 6 --transparent --opacity 0.7 --out output/timeline-alpha.json
```

## Measurement boundary

The [harness](../scripts/preview-layer-bench.ts) mounts each revision's real preview
UI in an isolated browser context over local HTTPS/HTTP2. Input timing starts
before the application handler. Nine framebuffer probes at 2%, 50% and 98% of
both axes must match the requested time, layer and Web Mercator position.
First-correct timing accepts coarse imagery; detailed timing requires fine
imagery at every probe. Physical input and compositor presentation are outside
this boundary. The alpha smoke also checks frame-varying transparency at 0.7 opacity.

Cold sweeps begin after the initial detailed frame renders; overview preparation
can already be underway. After-idle cases wait at most 10 seconds and record
readiness even if background work continues. Warm cases visit all 40 frames first.
The full workload includes preparation, 30 settled steps, continuous sweeps,
point-card steps, layer switches and eight alternating pans with distant times.

Benchmark reports now include GPU buffer storage beside textures and read wind
verification from the deck.gl `onAfterRender` pass (`renderedWindFrame`,
`renderedSceneGeneration`), so a stale canvas increments
`mismatchedWindRenders` even when field submission succeeded. Readiness separates
`coarseReadyFrames`, `detailBytesReadyFrames` and `detailDrawableFrames`. The
captures below predate that instrumentation and remain the 13 November fixture
run.

Captured 13 November 2026, 17:17–17:42 UTC: Node 22.23.4, Chrome 157.0.8103.79,
MapLibre 6.16.0, Apple M4 Max Metal through ANGLE. Viewport: 1920 × 1080, scale 1,
zoom 7.15, 32 visible fine tiles. The fixture contains 40 hourly frames of spatially
patterned 256² lossless WebP over a neutral basemap. Tile delays are response
floors; network bandwidth is unrestricted. The drawing buffer is preserved.

## Input to correct viewport

Values below compare baseline → changed, with 120/60 ms input cadences:

- **40 ms cold:** 1/39 → **39/39** targets painted at both cadences. Changed
  first-correct p50 was **11.1/6.3 ms**, p95 **17.0/19.1 ms**. Final full detail
  took **149.4/139.8 → 233.5/226.4 ms**.
- **40 ms after idle:** baseline painted 9/39 and 5/39; changed painted **39/39**
  at both cadences, p95 **19.8/20.8 ms**. Changed reached idle with 40/40 overviews
  ready after **3.08/3.15 s**, including subsequent fine-neighbor preparation.
- **250 ms cold:** baseline painted 1/39 at each cadence; changed painted 4/39
  and 3/39. Final first-correct improved **575.9/561.0 → 260.9/257.4 ms**.
  Final full detail took **576.0/561.0 → 878.8/876.1 ms**.
- **250 ms after 10 seconds:** baseline painted 2/39; changed had 40/40 overviews
  ready and painted **39/39** at both cadences, p95 **18.8/17.7 ms**. Fine
  preparation was still active. Final detail took **576.1/574.8 → 653.4/651.2 ms**.

Warm settled steps stayed at **3.0 ms p50**; with the point card open they measured
**3.5 → 3.9 ms**. Both warm continuous sweeps painted every target with zero tile
HTTP requests. All measured sweeps painted zero superseded targets and completed
without browser errors. Cold fine loads wait 100 ms; ongoing coarse preparation
can also consume transport capacity during refinement.

## Transfer and retention

The complete 40 ms workload started **6,143 → 3,710** tile requests and emitted
**4,220,896 → 4,025,696 bytes**: 39.6% fewer requests and 4.6% fewer payload bytes.
Every initial load and preparation phase is included. Synthetic compression
makes these workload comparisons specific to the fixture.

Across the four 250 ms cold cases, requests fell **2,814 → 1,742**, while bytes
rose **343,084 → 1,052,324** as the overview window filled. Each 10-second
preparation phase transferred **63,782 → 334,164 bytes** after initial rendering.
The changed synthetic 40-frame overview itself totals **357,746 bytes**, including
those loaded before the preparation timer starts.

A separate normal-GET production audit measured **351,102 body bytes across 80
responses** for all 40 Alpine ICON-EU AGL overviews: z5, x16/17, y11, build
`20261113T110406Z-883a1c77-a2ef-443c-b0ae-5d21b68cd8ce`. Twenty frames were entirely
transparent. Two daytime views added 36,100/41,980 overview bytes to
266,858/296,572 detailed bytes, an additional 13.5–14.2%. These measurements cover
this build and viewport and exclude headers/TLS. The final geometry keeps this
Alpine tile plan unchanged.

The figures above record that 40-frame window. A rested camera now keeps every
map frame of the active layer, padded by half the shorter view, within the
decode cap in [serving budgets](serving-budgets.md).

After forced GC, retained GPU textures plus tracked native pixels measured
**42.67 → 42.50 MiB**. Changed storage comprised 32.25 MiB of textures, 10 MiB of
resident overview bitmaps and a 0.25 MiB canvas. JavaScript heap was
**24.19 → 24.33 MiB**. Across the workload, texture peaks fell **46.67 → 36.25 MiB**;
tracked native-pixel peaks rose **49.50 → 66.25 MiB**. Component peaks occur at
different times and cannot be added into a measured total peak.

Texture accounting includes mipmaps and pooled textures. Weak native tracking
counts unclosed ImageBitmaps, canvas backing dimensions and pending decode pixels;
its peaks include objects awaiting GC. Driver overhead, worker allocations,
decoder internals and the default framebuffer are outside these logical counts.
Mobile hardware, real basemap work and constrained bandwidth need separate profiles.

## Reproduction fingerprints

Both final latency runs used the same source and harness hashes. Source hashes
cover preview/client TypeScript and CSS plus application HTML; tests and build
configuration are excluded. JSON reports retain per-input samples, request
start/end times, preparation costs, readiness and memory snapshots. The full
command also saves final screenshots.

```text
baseline revision 2f34b65bd43164d5ebee8c9647c245599f739e19
baseline source   76cd925e94b1d25a6e3b2a403cd63cf404734182f9e62e13d39049b9bf3fbecc
changed source    d563826b5ca8e13d0034c985f72ad6bb5988172d1928093c39f879fb37ecb922
harness           4f28d58096d7342253c68b608488c8f2f23606fc31f57a5c970f884d2c620ff3
```


## Full-horizon preparation

The 16 November 2026 change prepares every rendered map frame for browsing:
a cheap aspect-preserving raster preview bounded by 256 × 256 px from at most
four lower-zoom tiles, plus numeric wind at the selected height. It does not
change the measured 13 November captures above.

- Full native-detail expansion starts below **100,000 km²** and stays enabled
  until the rectangle exceeds **125,000 km²**. Dateline and full-world rectangles
  keep their coherent longitude span. Cheap previews and matching wind cover the
  whole axis outside that band.
- Preparation order is selected time, next and previous time, then the rest of
  the rendered axis in scrub direction, with a five-time native window as the
  retention fallback under memory pressure. Whole-axis preview and wind finish
  before speculative bandwidth goes to distant native crops.
- One scheduler serves raster, numeric wind and metadata with 24 active bodies,
  20 background bodies, four reserved foreground slots and 24/20 MiB response
  reservations; `VITE_FORECAST_REQUESTS` selects the 16, 24 or 32 profile.
  A 24 MiB managed foreground working-set reserve keeps selected responses,
  JSON parsing and raster processing ahead of speculative claims.
- Raster downloads run in a rolling queue that spans forecast times, separate
  from a four-decode queue and one composition canvas. A partial native crop
  suspends as an `ImageBitmap` when a selected preview is ready, and resumes
  without re-requesting drawn tiles.
- Native crops use `planRasterCrop()` at the canonical source zoom with the 10%
  pixel margin and one-source-pixel gutter. A native-complete crop suppresses
  the delayed detail source.
- Wind keeps up to six speculative frame jobs. Selected frames promote their
  queued and active physical requests, and deselected sources demote future
  chunks to background. Readiness requires both the prepared RGBA lattice and
  the raw field sampler for the selected height, build, coverage and expiry.
- Display installs the exact-time raster preview and matching wind under one
  selection generation. A cold target shows its preview as soon as it is usable,
  clears incompatible wind through `beforeRasterReveal`, and labels published
  coarse wind as overview quality.
- Readiness counts the intersection of usable raster and selected-height wind
  across every rendered frame, and reports detail separately.
- One preparation ledger bounds managed allocations at 128 MiB with a reported
  4 GB device hint or less, 256 MiB otherwise, and an explicit validated
  opt-in for 512 MiB. It covers response bodies, JSON working sets, compressed
  tiles, decoded crops, composition canvases, prepared wind grids, samplers and
  retained display textures.

Browser evidence for these paths is partly captured. A headless Chromium
MapLibre 6.16 probe confirms that an `ImageSource` reports no uploaded tile
before its first render and keeps the outgoing pixel during hidden staging.
Real iPhone/Safari and Android/Chrome runs, GPU blended-wind pixel identity,
16/24/32 profile comparisons, and the warm p95 target remain unverified; the
pull request records them as release gates rather than measured conclusions.


### Source-isolated benchmark smoke

The harness resolves every `@av/*` import through each variant's own
`codeRoot` package exports, archives the full baseline `packages` tree, fails
when a workspace import escapes that tree, and fingerprints the modules Vite
actually loaded. The earlier 2,499.7 ms versus 2,440.0 ms comparison is
retracted: that run's baseline omitted package manifests and resolved candidate
workspace code. No performance inference is drawn from it.

The corrected 48-frame run on 16 November 2026 used Node 22.23.4, bundled
Chromium through ANGLE SwiftShader, a 1920 × 1080 viewport at DPR 1, hourly
fixture frames, a 250 ms response floor and unrestricted bandwidth:

| Run | Baseline first-correct p50 | Candidate first-correct p50 | Loaded workspace files | Loaded hash prefix |
| --- | --- | --- | --- | --- |
| 48-frame cold wide view (z7.15, > 800 km²) | 2431.5 ms | 2413.4 ms | 73 / 74 | `299107ef19` / `41196288b0` |

Probes resolved `@av/client`, `@av/client/dom`, `@av/client/wind`,
`@av/contracts`, `@av/contracts/wind-data`, `@av/forecast/wind` and
`@av/soaring` inside each variant's own tree. Source hashes were
`d0c0b8f82ac3…` / `3201e62961c9…`; loaded-module hashes
`299107ef19…` / `41196288b0…`. The view is outside full-horizon
eligibility, so this run checks source isolation and foreground cold latency
(G01/G07), not automatic full-timeline preparation. The `viewport-warm` profile,
eligible-area calibration, warm sweep, DPR 2, constrained memory, faults and
real-basemap cases remain unverified.
