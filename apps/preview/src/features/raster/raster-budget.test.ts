import { expect, it } from 'vitest';
import type { Map } from 'maplibre-gl';
import { MAX_TILE_BYTES, RASTER_TILE_SIZE } from '@av/contracts/format';
import { WIND_NUMERIC_BYTES } from '@av/client/wind';
import { canRetainRasterOverview, preparationBudgetBytes, rasterRendererPoolBytes, rasterSourceLimit, RASTER_PAN_TILES, VIEWPORT_BYTES, WIND_CACHE_CAPACITY_BYTES, WIND_CANVAS_BYTES, WIND_CANVAS_PIXELS, WIND_FIELD_SAMPLER_BYTES, WIND_FRAME_PREPARED_BYTES, WIND_PREPARED_GRID_BYTES, WIND_TRAIL_PIXELS, windHorizonProtectedBytes } from './raster-budget';

const map = (count: number) => ({ coveringTiles: () => ({ length: count }) }) as unknown as Pick<Map, 'coveringTiles'>;

it('uses conservative device tiers and charges the configured 48-tile offscreen cache per source', () => {
  const mib = 1024 * 1024;
  expect(preparationBudgetBytes(2)).toBe(128 * mib);
  expect(preparationBudgetBytes(4, true)).toBe(128 * mib);
  expect(preparationBudgetBytes()).toBe(256 * mib);
  expect(preparationBudgetBytes(NaN, true)).toBe(256 * mib);
  expect(preparationBudgetBytes(8)).toBe(256 * mib);
  expect(preparationBudgetBytes(8, true)).toBe(512 * mib);
  const perTile = MAX_TILE_BYTES + 2 * RASTER_TILE_SIZE ** 2 * 4;
  expect(rasterRendererPoolBytes(map(1), 9)).toBe((1 + RASTER_PAN_TILES) * perTile);
  expect(rasterRendererPoolBytes(map(24), 9)).toBe((24 + RASTER_PAN_TILES) * perTile);
  expect(WIND_PREPARED_GRID_BYTES).toBe(65_536);
  expect(WIND_FIELD_SAMPLER_BYTES).toBe(139_264);
  expect(WIND_FRAME_PREPARED_BYTES).toBe(204_800);
  expect(windHorizonProtectedBytes({ totalFrames: 40, readyFrames: 10, numericAllocatedBytes: 8 * mib, processingHeadroomBytes: 8 * mib }))
    .toBe((WIND_CACHE_CAPACITY_BYTES - 8 * mib) + 30 * WIND_FRAME_PREPARED_BYTES + 8 * mib);
  expect(windHorizonProtectedBytes({ totalFrames: 40, readyFrames: 40, numericAllocatedBytes: 12 * mib })).toBe(0);
});

it('reserves Retina wind canvases and numeric cache within the viewport envelope and charges warm hidden cache honestly', () => {
  expect(WIND_CANVAS_PIXELS).toBe(8_388_608);
  expect(WIND_TRAIL_PIXELS).toBe(2_097_152);
  expect(WIND_CANVAS_BYTES).toBe(32 * 1024 * 1024);
  expect(WIND_NUMERIC_BYTES + WIND_CANVAS_BYTES).toBe(40 * 1024 * 1024);
  expect(VIEWPORT_BYTES).toBe(120 * 1024 * 1024);
  const raster = VIEWPORT_BYTES - WIND_NUMERIC_BYTES - WIND_CANVAS_BYTES;
  expect(raster).toBe(80 * 1024 * 1024);
  expect(RASTER_PAN_TILES).toBe(48);
  expect(rasterSourceLimit(map(24), 12)).toBe(4);
  expect(rasterSourceLimit(map(64), 12)).toBe(2);
  const tile = RASTER_TILE_SIZE ** 2 * 4;
  const maximum = raster / tile - RASTER_PAN_TILES;
  expect(rasterSourceLimit(map(maximum), 12)).toBe(1);
  expect(rasterSourceLimit(map(maximum + 1), 12)).toBe(0);
  expect(canRetainRasterOverview(map((raster - 24 * 1024 * 1024) / tile - RASTER_PAN_TILES), 12)).toBe(true);
  expect(canRetainRasterOverview(map((raster - 24 * 1024 * 1024) / tile - RASTER_PAN_TILES + 1), 12)).toBe(false);
  // Hidden wind with warm WindDataCache reclaims 32 MiB canvas reserve while keeping 8 MiB numeric cache charged.
  const warmHiddenMax = (VIEWPORT_BYTES - WIND_NUMERIC_BYTES) / tile - RASTER_PAN_TILES;
  expect(rasterSourceLimit(map(warmHiddenMax), 12, false, false, true)).toBe(1);
  expect(rasterSourceLimit(map(warmHiddenMax + 1), 12, false, false, true)).toBe(0);
  // Non-numeric or cleared wind reclaims the full 40 MiB reserve.
  expect(rasterSourceLimit(map(warmHiddenMax + 1), 12, false, false, false)).toBe(1);
  expect(canRetainRasterOverview(map((raster - 24 * 1024 * 1024) / tile - RASTER_PAN_TILES + 1), 12, false)).toBe(true);
  expect(rasterSourceLimit({} as Pick<Map, 'coveringTiles'>, 12)).toBe(0);
});
