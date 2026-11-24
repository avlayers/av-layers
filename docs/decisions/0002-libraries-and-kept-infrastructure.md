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
| Retries with backoff, predicates and cancellation | `p-retry` 9 | batch source, R2, NOAA and terrain transports; publication and smoke scripts |
| Unused files, exports and dependencies | `knip` | `pnpm knip`, part of `pnpm verify` |
| Screenshot parity | `pixelmatch`, `pngjs` | `scripts/visual-check.ts` |

Kept, with the gap that blocks the library:

| Code | Candidate | Gap |
|---|---|---|
| `cached()`/`finish()` in `apps/api/src/http.ts` | `hono/cache`, `hono/etag` | `hono/cache` keys on the URL, skips HEAD, clones the whole body and returns hits before our freshness, expiry and metrics checks. `hono/etag` hashes the body and leaves the original body and its memory reservation alive on 304 |
| `apps/api/src/storage-cache.ts` | Cache API alone | Keeps the millisecond deadline and source ETag beside each entry |
| Browser retry loops (`client-wind.ts`, `client-raster.ts`) | `p-retry` | `p-retry` drops `TypeError`s it cannot classify as network errors, which includes Safari's fetch failures. The wind loop also re-queues demoted requests without spending an attempt |
| `client-request-scheduler.ts` | `p-queue` | Admission is weighted by bytes and held until the body is read; the queue is bounded and promotes requests in place |
| `apps/batch/src/concurrent.ts` | `p-map` | `p-map` rejects while other tasks still run; callers rely on every in-flight task settling first |
| Raster and derive worker pools | `piscina` | Raster tiles stay on a fixed worker to keep its geometry cache warm; derive jobs go to every partition worker. Both start workers through `apps/batch/src/ts-worker.ts` |
| R2 listing in `apps/batch/src/storage.ts` | `paginateListObjectsV2` | The paginator takes no abort signal and stops silently on a repeated token |
| Small `Map` caches evicting `keys().next()` | `lru-cache` | 4 to 24 entries, most with disposal on eviction; the library adds about 6.8 KB gzip per bundle |
| `features/sky/contour-rings.ts`, `isobars.ts` | `d3-contour` | `d3-contour` emits closed polygons with border artefacts for lines and has no validity mask or centre-based saddle choice |

## Consequences

- One retry vocabulary in Node code. Each call site keeps its own predicate.
- `lru-cache` adds 6.8 KB gzip to the Worker. Zero-byte entries count as one byte.
- Known issues found while reviewing the kept code, left for their own changes:
  the saddle cases in `contour-rings.ts` join the wrong corners (rain and cloud
  edges split where they should join; `isobars.ts` gets them right), and
  `finish()` compares ETags strongly, so a `W/` tag never revalidates to 304.

## Revisit when

A kept row's gap closes in the library, or the code it protects is rewritten.
New infrastructure needs a record here naming the library it beats.
