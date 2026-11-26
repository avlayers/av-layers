import type { Map } from 'maplibre-gl';
import { RASTER_TILE_SIZE } from '@av/contracts/format';
import { planRasterCrop, requiredSourceZoom, type RasterCrop } from './raster-crop';

type View = [number, number, number, number];

/** Camera bounds as west, south, east, north with east > west and at most 360° wide. */
export function viewBounds(map: Map): View {
  const value = map.getBounds();
  let west = value.getWest(), east = value.getEast();
  if (east <= west) east += 360;
  if (east - west > 360) { const middle = (west + east) / 2; west = middle - 180; east = middle + 180; }
  return [west, value.getSouth(), east, value.getNorth()];
}

/** Source zoom MapLibre draws the view at, or null when it covers no tiles. */
export function canonicalZoom(map: Map, maxzoom: number): number | null {
  if (typeof map.coveringTiles !== 'function') return Math.max(0, Math.min(maxzoom, Math.round(map.getZoom())));
  const covering = map.coveringTiles({ tileSize: RASTER_TILE_SIZE, minzoom: 0, maxzoom, roundZoom: true })
    .map(tile => ({ z: tile?.canonical?.z ?? tile?.overscaledZ })).filter(tile => Number.isFinite(tile.z));
  return requiredSourceZoom(covering);
}

/** The finest crop below `zoom` that needs at most four tiles. */
export function previewCrop(view: View, zoom: number): RasterCrop | null {
  for (let z = Math.max(0, zoom - 1); z >= 0; z--) {
    const crop = planRasterCrop(view, z);
    if (crop && crop.tiles.length <= 4) return crop;
  }
  return null;
}

/** Whether `crop` still covers `view`, allowing for whole-world wraps. */
export function contains(crop: RasterCrop, view: View): boolean {
  return viewInCrop(crop, view) !== null;
}

/**
 * The view's pixel rectangle inside `crop` (crop-relative, at the crop's zoom), or null when the crop
 * does not cover it. Whole-world wraps shift the view onto the crop's copy of the world.
 */
export function viewInCrop(crop: RasterCrop, view: View): { x: number; y: number; width: number; height: number } | null {
  const current = planRasterCrop(view, crop.zoom, { marginFractionPerEdge: 0, gutterPixelsPerEdge: 0 });
  if (!current) return null;
  const shift = Math.round((crop.left + crop.right - current.left - current.right) / (2 * crop.worldSize)) * crop.worldSize;
  const whole = crop.right - crop.left >= crop.worldSize;
  if (current.top < crop.top || current.bottom > crop.bottom || (!whole && (current.left + shift < crop.left || current.right + shift > crop.right))) return null;
  const x = whole ? Math.max(0, Math.min(crop.width - current.width, current.left + shift - crop.left)) : current.left + shift - crop.left;
  return { x, y: current.top - crop.top, width: Math.min(current.width, crop.width), height: current.height };
}
