import type { Map } from 'maplibre-gl';
import { RASTER_TILE_SIZE } from '@av/contracts/format';
import { WIND_NUMERIC_BYTES } from '@av/client/wind';

export const RASTER_CACHE_TILES = 16;
export const RASTER_PAN_TILES = 48;
export const MAX_RASTER_SOURCES = 4;
export const WIND_TRAIL_PIXELS = 2 * 1024 * 1024;
/** Short soft streaks. Fade keeps 0.94 of the trail at 60 fps. Gain and bias are the on-map composite. */
export const WIND_TRAIL_FADE = 4;
/** Streak count for a viewport. Density is `1 / (50 * 1.6^(zoom-2))`, capped at 15,000. */
export function windParticleCount(width: number, height: number, zoom: number): number {
  const cells = 50 * 1.6 ** (Math.round(zoom) - 2);
  return Math.min(15_000, Math.max(1, Math.round(Math.max(0, width) * Math.max(0, height) / cells)));
}
const TRAIL_WIDTH = [0.6, 0.6, 0.6, 1, 1.2, 1.6, 1.8, 2, 2.2, 2.4, 2.4, 2.4, 2.4, 2.6, 2.8, 3];
/** Stroke diameter in CSS pixels at an integer zoom. */
export function windTrailWidth(zoom: number): number {
  return Math.max(1, (TRAIL_WIDTH[Math.max(0, Math.min(TRAIL_WIDTH.length - 1, Math.round(zoom)))] ?? 3) * 1.3);
}
export const WIND_TRAIL_GAIN = 1;
export const WIND_TRAIL_BIAS = 0.04;
export const WIND_CANVAS_PIXELS = 8 * 1024 * 1024;
export const WIND_CANVAS_BYTES = WIND_CANVAS_PIXELS * 4;
export const VIEWPORT_BYTES = 120 * 1024 * 1024;
const WIND_RESERVE_BYTES = WIND_NUMERIC_BYTES + WIND_CANVAS_BYTES;
const OVERVIEW_BYTES = 24 * 1024 * 1024;

const retainedBytes = (windActive: boolean, numericResident = windActive): number =>
  VIEWPORT_BYTES - (windActive ? WIND_RESERVE_BYTES : numericResident ? WIND_NUMERIC_BYTES : 0);

/** Admit a prepared window using covering tiles plus offscreen cache allowance, reclaiming freed canvas/wind memory. */
export function rasterSourceLimit(map: Pick<Map, 'coveringTiles'>, maxzoom: number, overview = false, windActive = true, numericResident = windActive): number {
  if (!map.coveringTiles) return 0;
  return Math.max(0, Math.min(MAX_RASTER_SOURCES - Number(overview), Math.floor((retainedBytes(windActive, numericResident) - (overview ? OVERVIEW_BYTES : 0)) / sourceBytes(map, maxzoom))));
}

export function canRetainRasterOverview(map: Pick<Map, 'coveringTiles'>, maxzoom: number, windActive = true, numericResident = windActive): boolean {
  return !!map.coveringTiles && sourceBytes(map, maxzoom) + OVERVIEW_BYTES <= retainedBytes(windActive, numericResident);
}

function sourceBytes(map: Pick<Map, 'coveringTiles'>, maxzoom: number): number {
  return (map.coveringTiles({ tileSize: RASTER_TILE_SIZE, minzoom: 0, maxzoom, roundZoom: true }).length + RASTER_PAN_TILES) * RASTER_TILE_SIZE ** 2 * 4;
}
