# Preview timeline performance

Viewport overviews showed all 39 requested times during both cold desktop sweeps
at a 40 ms response floor. Fine detail follows separately; preparation transfers
additional coarse data and can delay cold refinement.

[Preview build checks](../apps/preview/vite.config.ts) cap the startup JavaScript
bundle (MapLibre GL, XC Skies natural basemap, raster overviews, and
numeric wind overlay) at **400,000 B gzip** (391,946 B measured on 16 November 2026)
and each lazy chunk (the on-demand `@av/windgram` renderer) at **32,000 B gzip**
(27,336 B measured the same day). The timeline figures below remain the
13 November capture.

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


## Viewport preparation

The 16 November 2026 change adds a native-pixel crop for small views, prepared
wind lattices and a shared request-admission policy. It does not change the
measured 13 November captures above.

- A conservative camera rectangle of at most **800 km²** starts full-timeline
  preparation; the intent is retained until the rectangle exceeds **1000 km²**.
  Dateline and full-world rectangles keep their coherent longitude span.
- Small raster views ask MapLibre `coveringTiles` for the canonical source zoom,
  then retain `visible × 1.2 + 2 px` per axis. Coverage comes from that integer
  rectangle, so a pan inside the retained margin keeps the same prepared frames.
  The native-z10 Armenia fixture is 391 × 221 px and 15.8223 MiB across 48 frames;
  the fixture's capped source zoom produces 197 × 112 px at z9.
- Background warming prepares each acquired wind frame's 128×128 RGBA lattice;
  selection installs the prepared lattice and native fallback field in one
  overlay operation before renderer synchronization. The following GL prerender
  uploads the prepared bytes. Point sampling keeps the exact native sampler.
- Numeric wind retries transient 502/503/504 responses three times inside the
  request deadline, then records a 30 s per-resource cooldown and advances to the
  next promised time. Capacity is a typed outcome that records a bounded admitted
  window, evicts only outside that window and stops expanding under unchanged
  pressure; a playback toggle is not required.
- Physical request admission counts headers and live bodies until settlement.
  An explicit request reserves its validated expected size or its safe maximum.
  Unknown, malformed and non-identity encodings keep that reservation; an
  explicitly exposed `Content-Encoding: identity` permits an exact length.
- Raster, numeric wind and forecast metadata share one app-owned scheduler.
  Background wind requests carry low priority.

Wind lattice preparation still runs on the main thread during background
warming. The worker snapshot, prepared barb lattice, combined allocation ledger
and raster/wind stage-then-commit barrier are not implemented.

Browser evidence for these paths is not yet captured. The required
`viewport-warm` benchmark profile, 48-frame primary case, warm p95 sweep and
constrained-device budget remain unverified; the draft PR records them as
blocking release gates rather than reporting measured conclusions.


### Source-isolated benchmark smoke

The harness now resolves every `@av/*` import through each variant's own
`codeRoot` package exports before Vite's workspace links, and accepts the
48-frame guard. Two runs on 16 November 2026 used Node 22.23.4, bundled
Chromium 157 through ANGLE SwiftShader, a 1920 × 1080 viewport at DPR 1, 48
hourly fixture frames, a 250 ms response floor, and unrestricted bandwidth:

| Run | Baseline first-correct p50 | Candidate first-correct p50 | Overview ready at 10 s |
| --- | --- | --- | --- |
| 48-frame cold wide view (z7.15, > 800 km²) | 2499.7 ms | 2440.0 ms | 1/48 both |

Both variants ran their own source and painted the requested time and layer.
The view is outside full-horizon eligibility, so this run checks source
isolation and foreground cold latency (G01/G07), not automatic full-timeline
preparation. A 6-frame smoke at the same boundary also completed for both
variants. The `viewport-warm` profile, eligible-area calibration, warm sweep,
DPR 2, constrained memory, faults and real-basemap cases remain unverified.
