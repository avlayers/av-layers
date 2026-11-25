# 0004. The lift and rain raster stays on MapLibre sources

**Status:** accepted, 2026-11-25

## Context

The lift and rain rasters run through a home-grown pipeline: the
`features/raster/` overlay and overview, the palette remap worker
(`tile-remap*`), the raster budget and crop, and `@av/client`'s raster tile
transport with its request scheduler and preparation budget. deck.gl's
`TileLayer` offers caching, request throttling and parent-tile fallback, and
the plan proposed moving the raster onto it, ideally drawing value-encoded tiles
so one shader colours them per theme.

The owner chose one pull request with no new published files. Without value
tiles a deck.gl layer would still need the palette lookup on the GPU, and it
would have to reproduce what the current pipeline is tuned for:

- frame slots staged ahead of playback, so scrubbing shows no blank frames;
- one memory budget shared by raster and wind, with foreground requests
  admitted before background prefetch;
- overview tiles that cover the view while fine tiles load and swap in without
  a flash;
- overlay readiness that the timeline and notices read to say when a frame is
  shown, loading or unavailable.

## Decision

Keep the raster on MapLibre sources and split the pipeline by concern instead:
each file owns one of slots, overview, remap, budget and the tile transport.
The tile transport's retries move to `p-retry` (ADR 0002).

## Consequences

- No new published artifact and no change to the public palette tile route.
- The palette lookup (`paletteValueLut`) and the remap worker stay.
- `pnpm visual-check` and the raster tests guard the split, since the pixels
  must not change.

## Revisit when

The batch publishes value-encoded tiles, or deck.gl's tile layer can share a
memory budget with wind and report per-frame readiness. Then the overlay,
overview, remap worker and raster budget can go in one change.
