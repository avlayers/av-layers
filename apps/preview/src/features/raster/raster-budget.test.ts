import { expect, it } from 'vitest';
import type { Map } from 'maplibre-gl';
import { WIND_NUMERIC_BYTES } from '@av/client/wind';
import {
  canRetainRasterOverview,
  MAP_TEXTURE_POOL_RESERVE_BYTES,
  preparationBudgetBytes,
  RASTER_MIPMAPPED_TILE_BYTES,
  RASTER_PAN_TILES,
  RASTER_TRANSIENT_TILE_BYTES,
  rasterSourceBytes,
  rasterSourceLimit,
  VIEWPORT_BYTES,
  WIND_CACHE_CAPACITY_BYTES,
  WIND_DISPLAY_BYTES,
  WIND_FIELD_SAMPLER_BYTES,
  WIND_FRAME_PREPARED_BYTES,
  WIND_PREPARED_GRID_BYTES,
  windHorizonProtectedBytes
} from './raster-budget';

const map = (count: number) => ({ coveringTiles: () => ({ length: count }) }) as unknown as Pick<Map, 'coveringTiles'>;

it('uses conservative device tiers and charges mipmapped tiles plus the once-per-map texture pool', () => {
  const mib = 1024 * 1024;
  expect(preparationBudgetBytes(2)).toBe(128 * mib);
  expect(preparationBudgetBytes(4, true)).toBe(128 * mib);
  expect(preparationBudgetBytes()).toBe(256 * mib);
  expect(preparationBudgetBytes(NaN, true)).toBe(256 * mib);
  expect(preparationBudgetBytes(8)).toBe(256 * mib);
  expect(preparationBudgetBytes(8, true)).toBe(512 * mib);
  const perTile = RASTER_MIPMAPPED_TILE_BYTES + RASTER_TRANSIENT_TILE_BYTES;
  expect(RASTER_MIPMAPPED_TILE_BYTES).toBe(349_524);
  expect(RASTER_TRANSIENT_TILE_BYTES).toBe(16_384);
  expect(MAP_TEXTURE_POOL_RESERVE_BYTES).toBe(50 * RASTER_MIPMAPPED_TILE_BYTES);
  expect(RASTER_PAN_TILES).toBe(24);
  expect(rasterSourceBytes(map(1), 9)).toBe((1 + RASTER_PAN_TILES) * perTile);
  expect(rasterSourceBytes(map(24), 9)).toBe((24 + RASTER_PAN_TILES) * perTile);
  expect(WIND_PREPARED_GRID_BYTES).toBe(65_536);
  expect(WIND_FIELD_SAMPLER_BYTES).toBe(139_264);
  expect(WIND_FRAME_PREPARED_BYTES).toBe(204_800);
  expect(windHorizonProtectedBytes({ totalFrames: 40, readyFrames: 10, numericAllocatedBytes: 8 * mib, processingHeadroomBytes: 8 * mib }))
    .toBe((WIND_CACHE_CAPACITY_BYTES - 8 * mib) + 30 * WIND_FRAME_PREPARED_BYTES + 8 * mib);
  expect(windHorizonProtectedBytes({ totalFrames: 40, readyFrames: 40, numericAllocatedBytes: 12 * mib })).toBe(0);
});

it('reserves GPU wind display, numeric cache, and MapLibre bucket pool within the viewport envelope', () => {
  expect(WIND_DISPLAY_BYTES).toBe(8 * 1024 * 1024);
  expect(VIEWPORT_BYTES).toBe(120 * 1024 * 1024);
  const perTile = RASTER_MIPMAPPED_TILE_BYTES + RASTER_TRANSIENT_TILE_BYTES;
  const retained = VIEWPORT_BYTES - MAP_TEXTURE_POOL_RESERVE_BYTES - WIND_NUMERIC_BYTES - WIND_DISPLAY_BYTES;
  expect(rasterSourceLimit(map(24), 12)).toBe(4);
  expect(rasterSourceLimit(map(90), 12, true)).toBe(1);
  const maximum = Math.floor(retained / perTile) - RASTER_PAN_TILES;
  expect(rasterSourceLimit(map(maximum), 12)).toBe(1);
  expect(rasterSourceLimit(map(maximum + 1), 12)).toBe(0);
  const maxOverview = Math.floor((retained - 12 * 1024 * 1024) / perTile) - RASTER_PAN_TILES;
  expect(canRetainRasterOverview(map(maxOverview), 12)).toBe(true);
  expect(canRetainRasterOverview(map(maxOverview + 1), 12)).toBe(false);
  const warmHiddenMax = Math.floor((VIEWPORT_BYTES - MAP_TEXTURE_POOL_RESERVE_BYTES - WIND_NUMERIC_BYTES) / perTile) - RASTER_PAN_TILES;
  expect(rasterSourceLimit(map(warmHiddenMax), 12, false, false, true)).toBe(1);
  expect(rasterSourceLimit(map(warmHiddenMax + 1), 12, false, false, true)).toBe(0);
  expect(rasterSourceLimit(map(warmHiddenMax + 1), 12, false, false, false)).toBe(1);
  expect(canRetainRasterOverview(map(maxOverview + 1), 12, false)).toBe(true);
  expect(rasterSourceLimit({} as Pick<Map, 'coveringTiles'>, 12)).toBe(0);
});
