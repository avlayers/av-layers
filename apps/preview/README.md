# Map preview

Standalone MapLibre GL viewer for forecast tiles and point time series.

Start both the local API and preview map with generated test data from the
repository root:

```sh
pnpm dev
```

To run, test, smoke-check, or build `@av/preview`:

```sh
AV_API_BASE=http://127.0.0.1:8787 pnpm --filter @av/preview dev
pnpm test:frontend
pnpm exec vitest run --project unit apps/preview/src/features/timeline/timeline-controller.test.ts
pnpm check:frontend
pnpm smoke:wind --fixture
pnpm --filter @av/preview build
```

`AV_API_BASE` defaults to `http://localhost:8787`. Set
`VITE_OFFLINE_FIXTURE=true` when serving the synthetic fixture (`pnpm dev`).
Reload the page to pick up a newly published build (subject to the API's
15-second [pointer cache](../../docs/serving-budgets.md)).

Auto selects the finest available forecast covering the map center and time.
A globe view, or a map without a location, selects GFS when that build is available.
Builds with numeric wind support trails and WMO/ICAO knot-feathered barbs with
`km/h` or `mph` speed labels at the selected height.
The basemap is the XC Skies Natural shaded-relief raster, with the roads and
place labels XC Skies draws above it. Retina displays request the `@2x` tiles.
The offline fixture keeps the neutral background.

The timeline shows the selected time, displayed time and image quality separately.
After the camera rests, every map frame of the active layer and the wind field
stay decoded for that view. A short pan and a time change reuse them. Fine tiles
replace a complete overview.

The startup bundle includes MapLibre and triggers Vite’s large-chunk warning.
The Windgram loads in a separate chunk on the first map click.
[Build checks](vite.config.ts) bound startup (`416,000 B` gzip) and lazy
(`33,000 B` gzip) JavaScript transfer and reject server modules in the browser output.

Click the map to open the Windgram. Sampled AGL and MSL lift appear while the
chart loads and in its selected hour readout. The km/mi control sets units.
Forecast settings change the horizon. Chart details hold height inspection and the legend.
A failed profile page leaves available lift visible.

Chart times within the map horizon select raster frames. Later point times keep
the map frame and show both clocks as local time with UTC in parentheses. The
scalar chart covers builds that publish no native profiles. Builds without a map
prefix offer a 24-hour point view.

## Source layout

- [src/index.tsx](src/index.tsx): the only production bootstrap.
- [src/app.tsx](src/app.tsx): Preact composition, layout and controls.
- [src/app/create-preview-app.ts](src/app/create-preview-app.ts): construction, commands, map/forecast/history wiring and shutdown.
- [src/stores/app-store.ts](src/stores/app-store.ts): the Signals state boundary; views read it, controllers publish through narrow writer calls.
- [src/features/forecast/forecast-model.ts](src/features/forecast/forecast-model.ts): model/layer selection policy.
- [src/features/map/map-controller.ts](src/features/map/map-controller.ts): MapLibre lifetime, basemap, coverage seam and viewport bounds.
- [src/features/raster/raster-overlay.ts](src/features/raster/raster-overlay.ts): raster replacement, overview retention and admission budgets.
- [src/features/wind/wind-session.ts](src/features/wind/wind-session.ts): wind session, controls, trails and barbs.
- [src/features/timeline/timeline-controller.ts](src/features/timeline/timeline-controller.ts): folded-night scale, gestures and playback.
- [src/features/point/point-session.ts](src/features/point/point-session.ts): progressive point series and the lazy Windgram.
- [src/features/location/location-controller.ts](src/features/location/location-controller.ts): geolocation and marker lifetime.
- [src/features/navigation/url-state.ts](src/features/navigation/url-state.ts): shared map URL parsing and serialization.
- [index.html](index.html): application shell.
- [package.json](package.json): Vite scripts.

Ordinary UI is Preact/TSX. MapLibre owns `#map` descendants; the compact
timeline and wind controls are imperative islands mounted into stable hosts.
Controllers own async work and resources; components receive readonly store
values and typed commands. URL/history behavior is tested through
`url-state.test.ts`; controller policy is tested in Node without a browser.

To change a control, update its store intent, command and component; leave the
graphics engine alone. To add a behavior, use the existing client/contracts
types and publish through the owning feature controller.

## Layer benchmark

[Measured results](../../docs/preview-performance.md) compare viewport overviews with detailed tiles.

Compare the baseline and current preview in isolated Chromium sessions:

```sh
pnpm exec playwright install chromium
pnpm bench:preview --baseline 2f34b65 --channel chrome --frames 40 --out output/preview-layer-bench.json
```

Use `--channel chrome` for installed Chrome and inspect the recorded WebGL renderer.
The [benchmark](../../scripts/preview-layer-bench.ts) loads each revision’s actual
preview UI and serves patterned lossless WebP over HTTP/2 with controlled latency.
Nine framebuffer probes verify time, layer and position, recording first-correct
and fully detailed views separately. GPU accounting reports texture and buffer
storage; wind verification reads the frame and generation recorded by the WebGL
render pass, not the submitted field state. Cold and warmed 40-frame sweeps dispatch
every 60 or 120 ms; settled steps include the point card.

Use `--scenario cold --delay-ms 250` or `500` to measure slower tile responses.
The JSON records source fingerprints, per-input latency, preparation and workload
bytes, retained heap, textures and native image pixels. Repeated pans and time
changes measure retention; adjacent PNGs show the final views. See the measured
results for accounting scope and the transparency smoke command.

Exercise altitude changes, pans and zoom changes while scrubbing across the full
forecast, then check that a final sweep still delivers:

```sh
pnpm bench:preview --variant changed --scenario interaction --model av-wrf --repeats 3 --mobile --device-memory 2 --out output/preview-interaction.json
```

`av-wrf` uses the pilot Lambert grids, 41 synthetic vertical levels and 48 frames
through hour 72. GFS and RRFS use 40 frames. `--mobile` selects a 390 by 844 viewport
at DPR 3; `--device-memory` supplies the browser memory hint. Run on real mobile
hardware separately. The report records each round, retained memory, long tasks
and final recovery delivery; async wind preparation metrics include yield time.
Recovery waits up to 15 seconds for the last frame at 1500 m and its expected
numeric wind. Instrumented mode also requires a detailed raster observation;
control mode reports raster verification as unavailable.
