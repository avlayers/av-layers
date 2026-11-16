# Preview frontend refactor report

Base revision: `cc42d75` (the actual execution checkout). Candidate: this branch.
Preact `10.29.8`, `@preact/signals` `2.11.4`, `@preact/preset-vite` `2.10.6`.
Implementation: one branch, one PR.

## What moved

- `main.ts` and its fake-browser test are gone. `src/index.tsx` is the only production bootstrap.
- Preact/TSX owns the shell and ordinary controls (`app.tsx`).
- `@preact/signals` owns preview UI state in `stores/app-store.ts`; views read readonly signals and emit typed commands.
- `create-preview-app.ts` constructs the API, map, renderers, sessions and shutdown, and owns forecast/Auto/history/expiry coordination.
- `features/wind/wind-session.ts` owns numeric wind acquisition, held/prefetched/retiring sources, blending and reservation.
- `features/point/point-session.ts` owns the existing `PointSeriesController` and the lazy Windgram; point UI and build details load on first use.
- `features/location/location-controller.ts` owns geolocation, retries and marker lifetime.
- Raster, overview, wind, map, timeline and URL modules moved into feature folders without algorithm changes.
- `FOCUS_DWELL_MS` moved to `features/map/viewport-policy.ts`.
- The request scheduler now applies `maxQueued` when byte admission stops dispatch, with regression tests for byte pressure and immediate dispatch at `maxQueued: 0`.

The compact timeline and wind-controls DOM remain imperative islands mounted into
stable Preact hosts. This preserves the folded-night gesture model and the
wind-control preference record while the rest of the UI is Preact-owned.

## Architecture completion pass

- `app/startup.ts` owns URL/preference/default precedence and initial state construction.
- `features/navigation/history-controller.ts` owns URL projection, push/replace, restoration generations and suppression.
- `features/forecast/forecast-session.ts` owns manual/Auto discovery, request identity, frame/time commitment, expiry, suspension and resumption.
- `features/map/map-controller.ts` now owns camera-derived clock, regional focus and scale.
- `platform/browser-lifecycle.ts` owns visibility/focus/BFCache subscriptions.
- `create-preview-app.ts` is 626 lines and is now construction, connections, commands and teardown; it still owns point presentation, wind commands and map event wiring.
- Production minification uses Terser (`terser@5.51.2`) to keep both JavaScript budgets with real headroom. The baseline was built with esbuild, so compressed-size comparisons include this packaging change; worker JavaScript also shrinks for the same reason.

## Review fixes

The adversarial review found and this branch fixes:

- History restoration commits the restored wind height before notifying the wind session, so the installed field samples the restored height.
- Point-only forecast hours refresh the chart and map-wind readout even when no rendered map frame exists; a focused point-session test covers it.
- BFCache records the interrupted model/Auto discovery and resumes it on `pageshow`; late completions are guarded by request identity and disposal.
- Switching to Auto clears an interrupted manual `pendingModel`, so recovery controls stay enabled.
- Wind acquisition and presentation status are separate; a retained source becomes ready again when the raster recovers, and a height change rebuilds the installed field. Focused tests cover both completion orders and height replacement.
- A requested custom layer survives discovery and is validated only against the resolved build.
- Wind overlay options use explicit `style`/`visible`/`paused` keys for deep links and saved preferences.
- Wind status and quality are forwarded to the imperative controls, including state published before lazy mounting.
- A replacement model keeps the committed raster visible until the new display succeeds or the committed display expires.
- Manual model loads normalize the committed requested time to the selected frame, so a model switch with a different grid does not drift the selected time.
- URL-selected units are persisted at startup, matching the previous startup `setUnits` call.
- Startup keeps the browser clock offset until the map leaves home.
- Permanent disposal aborts model/Auto requests and guards late continuations.
- Concurrent map clicks share one point-session initialization.
- Wind disposal releases sources held only by retirement timers.
- Browser lifecycle subscriptions moved to `platform/browser-lifecycle.ts`; wind intent decisions read the store rather than the imperative controls.
- The unused `ModelPicker` and `LocateControl` components are removed.

New focused tests cover wind acquisition/display status, height replacement, committed frame selection, custom-layer validation, point-only selection, resume policy and the scheduler queue bound.

Second review round fixes:

- Wind reconciliation receives the actual displayed raster, including a previous build, so a new model's wind waits for its own raster.
- Numeric acquisition failure stays `unavailable`; an unusable retained field is cleared, while a genuinely retained source remains recoverable.
- Point-only selection publishes the changed selection so dependent map-wind readouts clear.
- Same-model history restoration commits the clamped frame's valid time and validates a restored layer against the loaded build.
- Direct destruction disposes every distinct owned wind source, including retirement entries.
- Tests now cover failed acquisition, cross-build alignment, point selection notification, history frame normalization and same-model layer validation.

## Verification

Environment: macOS arm64, pnpm 10.34.9, repository Node 22.23.4, Chromium via Playwright.

| Check | Result |
| --- | --- |
| `pnpm lint` | pass |
| `pnpm typecheck` | pass (root, preview TSX, API) |
| `pnpm test:frontend` | 36 files, 592 tests pass |
| `pnpm verify` | pass |
| `pnpm smoke:wind --fixture` | 12/12 checks pass, 0 page errors |
| `pnpm bench:preview --scenario smoke` | pass, 0 stale-frame paints |
| `git diff --check` | pass |

Baseline frontend unit suite: 28 files, 639 tests, median 4.65 s (runs 5.80/4.62/4.65).
Candidate: 36 files, 592 tests, median 4.26 s (runs 4.32/4.26/4.23).

## Compressed assets

Measured with zlib gzip, matching the build checker.

| Asset | Base | Candidate |
| --- | ---: | ---: |
| Startup JS | 391,946 B | 391,324 B |
| Lazy JS (aggregate) | 27,336 B | 30,402 B |
| Worker JS | 150,556 B | 146,638 B |
| CSS | 14,641 B | 15,212 B |
| Windy plugin | 97,775 B | 97,775 B |

The existing gates (400,000 B startup, 32,000 B aggregate lazy) pass unchanged.

## Source size

Authored preview runtime (TS/TSX/CSS, tests excluded): 4,161 → 5,291 lines (+1,130).
Authored preview tests: 5,145 → 3,792 lines (−1,353). `main.test.ts` was replaced by
focused store, URL, timeline-model and scheduler tests plus the real-browser smoke.

## Limitations

- Runtime lines increased. The fewer-lines goal is not met.
- Test count fell from 639 to 592. The removed bootstrap fake-DOM suite is replaced by focused controller/store tests plus the browser smoke; some composition-boundary transitions still lack direct coverage.
- The timeline and wind-controls DOM remain imperative; the plan's full TSX conversion for those two areas is not complete.
- Only the transparency/smoke benchmark scenario was run after the migration. The paired 3× baseline/candidate 40-frame and 250 ms cold timing comparison was not run, so rendering-performance parity is unverified beyond the smoke result.
- Physical iOS/Android devices and Firefox/WebKit were not tested. The existing smoke is Chromium-only.
- The startup and lazy gates pass with comfortable headroom (about 8,676 B and 1,598 B at the measured zlib sizes) after switching production minification to Terser.
- `create-preview-app.ts` is 626 lines. Forecast discovery, history and expiry now have owners; point presentation, wind commands and map event wiring still live in the root.
