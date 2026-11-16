import { RASTER_TILE_SIZE } from '@av/contracts/format';

const LATITUDE_LIMIT = 85.0511287798066;
const MAX_TILES = 64;
const MAX_EDGE = 4096;

export interface CropTile {
  /** Unwrapped tile column, used for drawing. */
  x: number;
  y: number;
  z: number;
  /** Canonical wrapped column, used for immutable URLs. */
  canonicalX: number;
  drawX: number;
  drawY: number;
}

export interface RasterCrop {
  zoom: number;
  worldSize: number;
  /** Integer native-pixel rectangle in unwrapped world pixels, right/bottom exclusive. */
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  visiblePixelSize: [number, number];
  retainedPixelSize: [number, number];
  tiles: CropTile[];
  coordinates: [[number, number], [number, number], [number, number], [number, number]];
  bytes: number;
}

export interface CropOptions {
  tileSize?: number;
  marginFractionPerEdge?: number;
  gutterPixelsPerEdge?: number;
}

/** Highest canonical zoom in a MapLibre coveringTiles result. Empty coverage never proves native completeness. */
export function requiredSourceZoom(covering: readonly { z: number }[]): number | null {
  let zoom: number | null = null;
  for (const tile of covering) if (Number.isSafeInteger(tile.z) && (zoom === null || tile.z > zoom)) zoom = tile.z;
  return zoom;
}

export function canonicalTileX(x: number, zoom: number): number {
  const count = 2 ** zoom;
  return ((x % count) + count) % count;
}

const worldX = (longitude: number, worldSize: number): number => (longitude + 180) / 360 * worldSize;
const worldY = (latitude: number, worldSize: number): number => {
  const clamped = Math.max(-LATITUDE_LIMIT, Math.min(LATITUDE_LIMIT, latitude));
  return (1 - Math.asinh(Math.tan(clamped * Math.PI / 180)) / Math.PI) / 2 * worldSize;
};
const longitude = (x: number, worldSize: number): number => x / worldSize * 360 - 180;
const latitude = (y: number, worldSize: number): number => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / worldSize))) * 180 / Math.PI;

/**
 * Native-pixel crop for one coherent camera rectangle.
 * The margin expands the viewport pixels; the gutter adds one source pixel per edge for sampling.
 */
export function planRasterCrop(bounds: readonly [number, number, number, number], zoom: number, options: CropOptions = {}): RasterCrop | null {
  const tileSize = options.tileSize ?? RASTER_TILE_SIZE, margin = options.marginFractionPerEdge ?? 0.1, gutter = options.gutterPixelsPerEdge ?? 1;
  const [west, south, east, north] = bounds;
  if (![west, south, east, north].every(Number.isFinite) || !Number.isSafeInteger(zoom) || zoom < 0 || zoom > 30
    || !Number.isFinite(margin) || margin < 0 || margin > 1 || !Number.isSafeInteger(gutter) || gutter < 0
    || !Number.isSafeInteger(tileSize) || tileSize < 1) return null;
  const span = east >= west ? east - west : east + 360 - west;
  if (span <= 0 || span > 360 || north <= south) return null;

  const worldSize = tileSize * 2 ** zoom;
  const x0 = worldX(west, worldSize), x1 = worldX(west + span, worldSize);
  const y0 = worldY(north, worldSize), y1 = worldY(south, worldSize);
  const visibleWidth = x1 - x0, visibleHeight = y1 - y0;
  if (!(visibleWidth > 0) || !(visibleHeight > 0)) return null;

  const visibleLeft = Math.floor(x0), visibleTop = Math.floor(y0);
  const visiblePixelSize: [number, number] = [Math.ceil(x1) - visibleLeft, Math.ceil(y1) - visibleTop];

  const left = Math.floor(x0 - margin * visibleWidth) - gutter;
  const right = Math.ceil(x1 + margin * visibleWidth) + gutter;
  const top = Math.max(0, Math.floor(y0 - margin * visibleHeight) - gutter);
  const bottom = Math.min(worldSize, Math.ceil(y1 + margin * visibleHeight) + gutter);
  const width = right - left, height = bottom - top;
  if (width <= 0 || height <= 0 || width > MAX_EDGE || height > MAX_EDGE) return null;

  const firstX = Math.floor(left / tileSize), lastX = Math.ceil(right / tileSize) - 1;
  const firstY = Math.max(0, Math.floor(top / tileSize)), lastY = Math.min(2 ** zoom - 1, Math.ceil(bottom / tileSize) - 1);
  if (lastY < firstY || (lastX - firstX + 1) * (lastY - firstY + 1) > MAX_TILES) return null;
  const tiles: CropTile[] = [];
  for (let y = firstY; y <= lastY; y++) for (let x = firstX; x <= lastX; x++) {
    tiles.push({ x, y, z: zoom, canonicalX: canonicalTileX(x, zoom), drawX: x * tileSize - left, drawY: y * tileSize - top });
  }

  const westLongitude = longitude(left, worldSize), eastLongitude = longitude(right, worldSize);
  const shift = Math.floor(((westLongitude + eastLongitude) / 2 + 180) / 360) * 360;
  return {
    zoom, worldSize, left, top, right, bottom, width, height, visiblePixelSize,
    retainedPixelSize: [width, height], tiles,
    coordinates: [
      [westLongitude - shift, latitude(top, worldSize)], [eastLongitude - shift, latitude(top, worldSize)],
      [eastLongitude - shift, latitude(bottom, worldSize)], [westLongitude - shift, latitude(bottom, worldSize)]
    ],
    bytes: width * height * 4
  };
}
