# 0002. Libraries for generic infrastructure, and what stays in the repository

**Status:** accepted, 2026-11-24; updated 2026-11-25

## Context

The repository carried its own caches, retry loops, worker pools, schedulers and
contouring. Each copy is code to maintain and test. The owner wants the code to
cover forecast work and to use maintained libraries or the platform for the rest.

## Decision

Adopted:

| Concern | Library | Where |
|---|---|---|
| API serving caches (entries, bytes, absolute expiry) | `lru-cache` 11 | `apps/api/src/resources.ts` `ByteCache`; batch validation and terrain caches |
| Retries with backoff, predicates and cancellation | `p-retry` 9 | batch source, R2, NOAA and terrain transports; publication and smoke scripts; browser wind and raster reads. Loops that retry every failure pass errors through `apps/batch/src/retriable.ts`, because p-retry stops on unrecognised `TypeError`s and non-Error throws |
| Conditional requests (`If-None-Match`, weak comparison) | `fresh` | `apps/api/src/http.ts` `finish()` |
| R2 object listing | `paginateListObjectsV2` | `apps/batch/src/storage.ts`, with our page budget and repeated-token check |
| Unused files, exports and dependencies | `knip` | `pnpm knip`, part of `pnpm verify` |
| Screenshot parity | `pixelmatch`, `pngjs` | `scripts/visual-check.ts` |

Kept, with the gap that blocks the library:

| Code | Candidate | Gap |
|---|---|---|
| `cached()`/`finish()` in `apps/api/src/http.ts` | `hono/cache`, `hono/etag` | `hono/cache` skips HEAD, clones the whole body and returns hits before our freshness, expiry and metrics checks. `hono/etag` answers 304 without releasing the original body and its memory reservation, and drops the CORS headers |
| `apps/api/src/storage-cache.ts` | Cache API alone | Keeps the millisecond deadline and source ETag beside each entry, and checks each hit's SHA-256 so a poisoned or torn entry is refetched rather than served. The check costs about 3.6 ms per 4 MiB entry |
| `client-request-scheduler.ts` | `p-queue` | Admission is weighted by bytes and held until the body is read; the queue is bounded and promotes requests in place |
| `apps/batch/src/concurrent.ts` | `p-map` | `p-map` rejects while other tasks still run; callers rely on every in-flight task settling first |
| Raster and derive worker pools | `piscina` | Raster tiles stay on a fixed worker to keep its geometry cache warm; derive jobs go to every partition worker. Both start workers through `apps/batch/src/ts-worker.ts` |
| Small browser `Map` caches evicting `keys().next()` | `lru-cache` | 4 to 24 entries, most disposing GPU or decoded data on eviction; the library costs about 6 KB gzip per bundle. The Node-only caches in `apps/batch/src/validate.ts` and `terrain/local-store.ts` use it |
| `features/sky/contours.ts`, one marching-squares routine for map isobars, cloud and rain edges | `d3-contour` | `d3-contour` emits closed polygons with border artefacts for lines and has no validity mask or centre-based saddle choice |
| `packages/windgram/src/windgram-isobands.ts`, filled bands on the windgram's uneven time axis | `d3-contour` plus a coordinate transform | No gap for filled bands. Not moved yet: the swap changes the chart's SVG, so it needs its own visual review |

## Consequences

- One retry vocabulary in Node and browser code. Each call site keeps its own predicate.
- `lru-cache` adds about 6.8 KB gzip to the Worker. Zero-byte entries count as one byte.
- p-retry backoff grows by its factor per attempt with jitter of ×1 to ×2; the Node loops used ×0.5 to ×1.5, the browser wind reads ×0.85 to ×1.15 and the raster transport a linear step.
- Browser retries (`client-wind-transport.ts`, `client-raster.ts`) use `p-retry` too.
  Demoted wind requests re-run outside p-retry without spending a retry, because
  p-retry checks its retry budget before any predicate.
- Two issues found while reviewing the kept code are fixed: cloud and rain edges
  now share the isobar routine, so saddles join the right corners, and `finish()`
  compares `If-None-Match` weakly through `fresh`, so a `W/` tag revalidates to 304.

## Revisit when

A kept row's gap closes in the library, or the code it protects is rewritten.
New infrastructure needs a record here naming the library it beats.
