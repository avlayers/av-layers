# Preview frontend refactor report

Base revision: `cc42d75` (the actual execution checkout). Candidate: this branch.
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

## Verification

Environment: macOS arm64, pnpm 10.34.9, repository Node 22.23.4, Chromium via Playwright.

| Check | Result |
| --- | --- |
| `pnpm lint` | pass |
| `pnpm typecheck` | pass (root, preview TSX, API) |
| `pnpm test:frontend` | 30 files, 563 tests pass |
| `pnpm verify` | pass |
| `pnpm smoke:wind --fixture` | 12/12 checks pass, 0 page errors |
| `pnpm bench:preview --scenario smoke` | pass, 0 stale-frame paints |
| `git diff --check` | pass |

Baseline frontend unit suite: 28 files, 639 tests, median 4.65 s (runs 5.80/4.62/4.65).
Candidate: 30 files, 563 tests, median 4.23 s (runs 4.22/4.23/4.23).

## Compressed assets

Measured with zlib gzip, matching the build checker.

| Asset | Base | Candidate |
| --- | ---: | ---: |
| Startup JS | 391,946 B | 399,850 B |
| Lazy JS (aggregate) | 27,336 B | 31,953 B |
| Worker JS | 150,556 B | 150,556 B |
| CSS | 14,641 B | 15,203 B |
| Windy plugin | 97,775 B | 97,775 B |

The existing gates (400,000 B startup, 32,000 B aggregate lazy) pass unchanged.

## Source size

Authored preview runtime (TS/TSX/CSS, tests excluded): 4,161 → 5,058 lines (+897).
Authored preview tests: 5,145 → 3,348 lines (−1,797). `main.test.ts` was replaced by
focused store, URL, timeline-model and scheduler tests plus the real-browser smoke.

## Limitations

- Runtime lines increased. The fewer-lines goal is not met.
- Test count fell from 639 to 563. The removed bootstrap fake-DOM suite was replaced by narrower controller/store coverage; that is a coverage reduction, not a consolidation of equal scope.
- The timeline and wind-controls DOM remain imperative; the plan's full TSX conversion for those two areas is not complete.
- Only the transparency/smoke benchmark scenario was run after the migration. The paired 3× baseline/candidate 40-frame and 250 ms cold timing comparison was not run, so rendering-performance parity is unverified beyond the smoke result.
- Physical iOS/Android devices and Firefox/WebKit were not tested. The existing smoke is Chromium-only.
- The startup and lazy gates pass with little headroom (about 150 B and 47 B respectively at the measured zlib sizes). Further startup additions need a matching removal.
