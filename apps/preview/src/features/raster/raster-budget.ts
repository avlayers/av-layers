import type { Map } from 'maplibre-gl';
import { RASTER_TILE_SIZE } from '@av/contracts/format';
import { WIND_FIELD_SAMPLER_BYTES, WIND_NUMERIC_BYTES, WIND_PREPARED_GRID_BYTES } from '@av/client/wind';

export { WIND_FIELD_SAMPLER_BYTES, WIND_PREPARED_GRID_BYTES };

export const RASTER_PAN_TILES = 24;
export const RASTER_MIPMAPPED_TILE_BYTES = 349_524;
export const RASTER_TRANSIENT_TILE_BYTES = 16_384;
export const MAP_TEXTURE_POOL_RESERVE_BYTES = 50 * RASTER_MIPMAPPED_TILE_BYTES;
export const MAX_RASTER_SOURCES = 4;
export const WIND_TRAIL_WIDTH = 1.45;
export const WIND_DISPLAY_BYTES = 8 * 1024 * 1024;
export const WIND_FRAME_PREPARED_BYTES = WIND_PREPARED_GRID_BYTES + WIND_FIELD_SAMPLER_BYTES;
export const WIND_CACHE_CAPACITY_BYTES = 32 * 1024 * 1024;
export const VIEWPORT_BYTES = 120 * 1024 * 1024;
const WIND_RESERVE_BYTES = WIND_NUMERIC_BYTES + WIND_DISPLAY_BYTES;
const OVERVIEW_BYTES = 12 * 1024 * 1024;

interface WindHorizonProtectionInput {
  readonly totalFrames: number;
  readonly readyFrames: number;
  readonly numericAllocatedBytes: number;
  readonly numericCapacityBytes?: number;
  readonly horizonNumericRemainingBytes?: number | null;
  readonly displayReservedBytes?: number;
  readonly displayTargetBytes?: number;
  readonly processingHeadroomBytes?: number;
}

export function windHorizonProtectedBytes(input: WindHorizonProtectionInput): number {
  const missingFrames = Math.max(0, input.totalFrames - input.readyFrames);
  const numericCapRemaining = Math.max(0, (input.numericCapacityBytes ?? WIND_CACHE_CAPACITY_BYTES) - Math.max(0, input.numericAllocatedBytes));
  const numericRemaining = input.horizonNumericRemainingBytes !== undefined && input.horizonNumericRemainingBytes !== null && Number.isFinite(input.horizonNumericRemainingBytes)
    ? Math.min(numericCapRemaining, Math.max(0, input.horizonNumericRemainingBytes))
    : numericCapRemaining;
  const displayRemaining = Math.max(0, (input.displayTargetBytes ?? 0) - Math.max(0, input.displayReservedBytes ?? 0));
  if (missingFrames === 0) return displayRemaining;
  return numericRemaining + missingFrames * WIND_FRAME_PREPARED_BYTES + displayRemaining + Math.max(0, input.processingHeadroomBytes ?? 0);
}

export function preparationBudgetBytes(deviceMemory?: number, validatedHighMemory = false): number {
  if (Number.isFinite(deviceMemory) && deviceMemory! > 0 && deviceMemory! <= 4) return 128 * 1024 * 1024;
  return (validatedHighMemory && Number.isFinite(deviceMemory) && deviceMemory! > 4 ? 512 : 256) * 1024 * 1024;
}

export function rasterSourceBytes(map: Pick<Map, 'coveringTiles'>, maxzoom: number): number {
  const visible = map.coveringTiles ? map.coveringTiles({ tileSize: RASTER_TILE_SIZE, minzoom: 0, maxzoom, roundZoom: true }).length : 64;
  return (visible + RASTER_PAN_TILES) * (RASTER_MIPMAPPED_TILE_BYTES + RASTER_TRANSIENT_TILE_BYTES);
}

const retainedBytes = (windActive: boolean, numericResident = windActive): number =>
  VIEWPORT_BYTES - MAP_TEXTURE_POOL_RESERVE_BYTES - (windActive ? WIND_RESERVE_BYTES : numericResident ? WIND_NUMERIC_BYTES : 0);

/** Admit a prepared window using covering tiles plus offscreen cache allowance, reclaiming freed canvas/wind memory. */
export function rasterSourceLimit(map: Pick<Map, 'coveringTiles'>, maxzoom: number, overview = false, windActive = true, numericResident = windActive): number {
  if (!map.coveringTiles) return 0;
  return Math.max(0, Math.min(MAX_RASTER_SOURCES - (overview ? 2 : 0), Math.floor((retainedBytes(windActive, numericResident) - (overview ? OVERVIEW_BYTES : 0)) / rasterSourceBytes(map, maxzoom))));
}

export function canRetainRasterOverview(map: Pick<Map, 'coveringTiles'>, maxzoom: number, windActive = true, numericResident = windActive): boolean {
  return !!map.coveringTiles && rasterSourceBytes(map, maxzoom) + OVERVIEW_BYTES <= retainedBytes(windActive, numericResident);
}
