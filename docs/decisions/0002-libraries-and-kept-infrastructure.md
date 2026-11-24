# 0002. Libraries for generic infrastructure, and what stays in the repository

**Status:** accepted, 2026-11-24

## Context

The repository carried its own caches, retry loops, worker pools, schedulers and
contouring. Each copy is code to maintain and test. The owner wants the code to
cover forecast work and to use maintained libraries or the platform for the rest.

## Decision

Adopted:

| Concern | Library | Where |
|---|---|---|
| API serving caches (entries, bytes, absolute expiry) | `lru-cache` 11 | `apps/api/src/resources.ts` `ByteCache` |
| Retries with backoff, predicates and cancellation | `p-retry` 9 | batch source, R2, NOAA and terrain transports; publication and smoke scripts. Loops that retry every failure pass errors through `apps/batch/src/retriable.ts`, because p-retry stops on unrecognised `TypeError`s and non-Error throws |
| R2 object listing | `paginateListObjectsV2` | `apps/batch/src/storage.ts`, with our page budget and repeated-token check |
| Unused files, exports and dependencies | `knip` | `pnpm knip`, part of `pnpm verify` |
| Screenshot parity | `pixelmatch`, `pngjs` | `scripts/visual-check.ts` |

Kept, with the gap that blocks the library:

| Code | Candidate | Gap |
|---|---|---|
| `cached()`/`finish()` in `apps/api/src/http.ts` | `hono/cache`, `hono/etag` | `hono/cache` skips HEAD, clones the whole body and returns hits before our freshness, expiry and metrics checks. `hono/etag` answers 304 without releasing the original body and its memory reservation, and drops the CORS headers |
| `apps/api/src/storage-cache.ts` | Cache API alone | Keeps the millisecond deadline and source ETag beside each entry |
| Browser retry loops (`client-wind.ts`, `client-raster.ts`) | `p-retry` | No gap: `is-network-error` covers the browser fetch failures and `shouldConsumeRetry` covers demoted wind requests. Not moved yet; the next change to either loop moves it |
| `client-request-scheduler.ts` | `p-queue` | Admission is weighted by bytes and held until the body is read; the queue is bounded and promotes requests in place |
| `apps/batch/src/concurrent.ts` | `p-map` | `p-map` rejects while other tasks still run; callers rely on every in-flight task settling first |
| Raster and derive worker pools | `piscina` | Raster tiles stay on a fixed worker to keep its geometry cache warm; derive jobs go to every partition worker. Both start workers through `apps/batch/src/ts-worker.ts` |
| Small browser `Map` caches evicting `keys().next()` | `lru-cache` | 4 to 24 entries, most disposing GPU or decoded data on eviction; the library costs about 6 KB gzip per bundle. The Node-only caches in `apps/batch/src/validate.ts` (up to 16,384 entries) and `terrain/local-store.ts` (1,024) have no bundle cost and can move to it |
| `features/sky/contour-rings.ts`, `isobars.ts` | `d3-contour` | `d3-contour` emits closed polygons with border artefacts for lines and has no validity mask or centre-based saddle choice |

## Consequences

- One retry vocabulary in Node code. Each call site keeps its own predicate.
- `lru-cache` adds about 6.8 KB gzip to the Worker. Zero-byte entries count as one byte.
- p-retry backoff jitter spans ×1 to ×2 of the base delay, narrower than the old ×0.5 to ×1.5.
- Known issues found while reviewing the kept code, left for their own changes:
  the saddle cases in `contour-rings.ts` join the wrong corners (rain and cloud
  edges split where they should join; `isobars.ts` gets them right), and
  `finish()` compares ETags strongly, so a `W/` tag never revalidates to 304.

## Revisit when

A kept row's gap closes in the library, or the code it protects is rewritten.
New infrastructure needs a record here naming the library it beats.
