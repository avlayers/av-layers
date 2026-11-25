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

Auto selects the finest available forecast covering the map center and time, falling back to models covering at least 15% of the camera viewport when the center is over water or outside a regional domain, and clamping out-of-range timestamps to the nearest available frame.
A globe view, or a map without a location, selects GFS immediately without a center sample when that build is available.
Builds with numeric wind render GPU particles through the in-house
`WindParticleLayer` (deck.gl/luma.gl transform feedback) and
WMO/ICAO knot-feathered barbs through `@deck.gl/layers` (`IconLayer` in the map
plane, upright `TextLayer` labels). The barb atlas covers calm plus 5–280 kt in
both hemispheres and generates on-demand icons above 280 kt. Overlays share
MapLibre's WebGL2 context (`MapLibreOverlay`, interleaved) and re-attach on
`style.load`. Speed labels show `km/h` or `mph` at the selected height.
The basemap combines AWS Terrarium DEM color-relief and multidirectional
hillshade with OpenFreeMap vector roads, borders, airfields, peaks, and place
labels across four map themes (Stone, Slate, Chart and Classic). Each theme
fixes its own lift palette and cloud and rain styling. Retired theme ids in old
links fall back to the nearest kept theme.
The offline fixture keeps the neutral background.

The timeline shows the selected time, displayed time and image quality separately.
After the camera rests, every map frame of the active layer and the wind field
stay decoded for that view. A short pan and a time change reuse them. Fine tiles
replace a complete overview.

The startup bundle includes MapLibre and triggers Vite’s large-chunk warning.
The Windgram loads in a separate chunk on the first map click.
[Build checks](vite.config.ts) bound startup and lazy JavaScript transfer (see
[preview performance](../../docs/preview-performance.md)) and reject server modules in the browser output.

Click the map to open the Windgram. Sampled AGL and MSL lift appear while the
chart loads and in its selected hour readout. The km/mi control sets units.
Forecast settings change the horizon. Chart details hold height inspection and the legend.
A failed profile page leaves available lift visible.

Chart times within the map horizon select raster frames. Later point times keep
the map frame and show both clocks as local time with UTC in parentheses. The
scalar chart covers builds that publish no native profiles.

## Source layout

- [src/index.tsx](src/index.tsx): the only production bootstrap.
- [src/app.tsx](src/app.tsx): Preact composition, layout and controls.
- [src/app/create-preview-app.ts](src/app/create-preview-app.ts): composition root. Builds the [context](src/app/context.ts) (store, services, live parts) and the wiring modules, then creates the map channels on `start`. Wiring modules call each other through the shared `PreviewOps` table in [display-ops.ts](src/app/display-ops.ts).
- [display-ops.ts](src/app/display-ops.ts), [forecast-wiring.ts](src/app/forecast-wiring.ts), [url-wiring.ts](src/app/url-wiring.ts), [command-handlers.ts](src/app/command-handlers.ts), [map-wiring.ts](src/app/map-wiring.ts), [page-lifecycle.ts](src/app/page-lifecycle.ts): channel and notice sync, forecast session events, URL write and history restore, UI commands, camera events, and back/forward-cache suspension and disposal.
- [src/app/wind-wiring.ts](src/app/wind-wiring.ts), [point-wiring.ts](src/app/point-wiring.ts), [shortcuts.ts](src/app/shortcuts.ts), [overlay-status.ts](src/app/overlay-status.ts): wind, the point card, keyboard shortcuts and the raster status line.
- [src/channels/channel.ts](src/channels/channel.ts): `MapChannel`, the display contract the basemap, raster overlay, sky composite and wind overlay implement. The root forwards theme, opacity, visibility, units, playback and teardown to every channel in one loop.
- [src/themes/](src/themes/README.md): one data record per map theme plus the registry.
- [src/stores/app-store.ts](src/stores/app-store.ts): the Signals state boundary; views read it, controllers publish through narrow writer calls.
- [src/features/forecast/forecast-model.ts](src/features/forecast/forecast-model.ts): model/layer selection policy.
- [src/features/map/map-controller.ts](src/features/map/map-controller.ts): MapLibre lifetime, basemap, coverage seam and viewport bounds.
- [src/features/raster/raster-overlay.ts](src/features/raster/raster-overlay.ts): raster replacement, overview retention and admission budgets.
- [src/features/wind/wind-session.ts](src/features/wind/wind-session.ts): wind session and controls.
- [src/features/wind/wind-deck.ts](src/features/wind/wind-deck.ts): deck.gl particles (`WindParticleLayer`), map-plane barbs and labels.
- [src/features/wind/wind-barbs-atlas.ts](src/features/wind/wind-barbs-atlas.ts): 0–280 kt hemisphere atlas plus dynamic icons.
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
graphics engine alone. To add a map layer group, implement `MapChannel` and add
it to the root's channel list, which updates, clears and destroys every channel.
A group that loads forecast data also needs a select call where the root selects
the raster and sky frames;
to add a theme, see [src/themes/README.md](src/themes/README.md). To add a behavior, use the existing client/contracts
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
storage; wind verification reads the frame and generation recorded by the deck.gl
`onAfterRender` pass, not the submitted field state. Readiness reports
`coarseReadyFrames`, `detailBytesReadyFrames` and `detailDrawableFrames`
separately. Cold and warmed 40-frame sweeps dispatch
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
