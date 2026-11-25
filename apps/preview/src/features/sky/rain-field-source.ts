import type { Map as MapLibreMap } from 'maplibre-gl';
import {
  createSourceRasterTileProtocol, frameTileUrl, layerMaxZoom,
  type ForecastRequestHandle, type ForecastRequestSpec, type PinnedBuild, type RasterTileHandle, type RasterTileSourceProtocol
} from '@av/client';
import { RASTER_TILE_SIZE } from '@av/contracts/format';
import { planRasterCrop, type RasterCrop } from '../raster/raster-crop';
import { decodePrecipRgbaToField, type PrecipField } from './precip-field';
import type { ViewportBounds } from './synoptic-sampler';

const RAIN_FIELD_SIZE = 224;
const MAX_RAIN_FIELD_CACHE = 96;

function planRainCrop(raw: ViewportBounds, mapZoom: number, maxzoom: number): RasterCrop | null {
  const view: [number, number, number, number] = [raw.west, raw.south, raw.east, raw.north];
  const topZ = Math.max(0, Math.min(maxzoom, Math.round(mapZoom)));
  for (let z = topZ; z >= 0; z--) {
    const wide = planRasterCrop(view, z, { marginFractionPerEdge: 0.28, gutterPixelsPerEdge: 1 });
    if (wide && wide.tiles.length <= 6) return wide;
    const tight = planRasterCrop(view, z, { marginFractionPerEdge: 0.14, gutterPixelsPerEdge: 1 });
    if (tight && tight.tiles.length <= 6) return tight;
  }
  return null;
}

/**
 * Checks whether a cached `PrecipField` covers the viewport without over-coarsening relative to
 * the layer's native `maxzoom` (e.g., GFS `precip-rate` `maxzoom = 4..6`, where 1 tile spans 5.6°–22.5°).
 */
function precipFieldCoversView(field: PrecipField, raw: ViewportBounds, maxzoom: number): boolean {
  const viewSpanLon = raw.east - raw.west;
  if (viewSpanLon >= 145) return field.east - field.west >= 320;
  if (raw.west < field.west || raw.east > field.east || raw.south < field.south || raw.north > field.north) {
    return false;
  }
  const minNativeSpanDeg = (360 / Math.pow(2, Math.max(0, maxzoom))) * 2.25;
  const maxAllowedSpan = Math.max(minNativeSpanDeg, viewSpanLon * 2.75);
  return (field.east - field.west) <= maxAllowedSpan;
}

/**
 * Fetches `precip-rate` tiles for a viewport crop, decodes them into a `PrecipField`, and keeps
 * the last `MAX_RAIN_FIELD_CACHE` fields keyed by build, frame and crop.
 */
export class RainFieldSource {
  private readonly decodeCanvas = new OffscreenCanvas(RAIN_FIELD_SIZE, RAIN_FIELD_SIZE);
  private readonly protocol: RasterTileSourceProtocol;
  private readonly fieldCache = new Map<string, PrecipField>();

  constructor(
    private readonly map: MapLibreMap,
    baseUrl: string,
    options: { fetchImpl?: typeof fetch; request?: (spec: ForecastRequestSpec) => ForecastRequestHandle }
  ) {
    this.protocol = createSourceRasterTileProtocol(baseUrl, {
      maxSources: 2,
      fetchImpl: options.fetchImpl,
      request: options.request,
      maxActive: 8,
      maxPrefetchActive: 6
    });
  }

  /** Tile crop for the viewport at the current map zoom; null when no zoom fits six tiles. */
  planCrop(build: PinnedBuild, raw: ViewportBounds): RasterCrop | null {
    return planRainCrop(raw, this.map.getZoom(), layerMaxZoom(build.manifest, 'precip-rate'));
  }

  /** Returns `active` or a cached field for `frame` that covers `raw`, refreshing its LRU slot. */
  find(build: PinnedBuild, frame: string, raw: ViewportBounds, active: PrecipField | null): PrecipField | null {
    const maxzoom = layerMaxZoom(build.manifest, 'precip-rate');
    const prefix = `${build.manifest.buildId}:${frame}:`;
    if (active?.key.startsWith(prefix) && precipFieldCoversView(active, raw, maxzoom)) {
      return active;
    }
    const crop = planRainCrop(raw, this.map.getZoom(), maxzoom);
    if (crop) {
      const exactKey = `${prefix}${crop.zoom}:${crop.left}:${crop.top}:${crop.right}:${crop.bottom}`;
      const exact = this.fieldCache.get(exactKey);
      if (exact) {
        this.touch(exactKey, exact);
        return exact;
      }
    }
    for (const [key, candidate] of this.fieldCache) {
      if (candidate.key.startsWith(prefix) && precipFieldCoversView(candidate, raw, maxzoom)) {
        this.touch(key, candidate);
        return candidate;
      }
    }
    return null;
  }

  /**
   * Loads and decodes `crop` for `frame`. Tile handles are pushed to `handlesOut` so the caller can
   * cancel them; returns null on failure or once `isCurrent()` turns false.
   */
  async decode(
    build: PinnedBuild,
    frame: string,
    crop: RasterCrop,
    priority: 'foreground' | 'background',
    handlesOut: RasterTileHandle[],
    isCurrent: () => boolean
  ): Promise<PrecipField | null> {
    const template = build.templates['precip-rate'];
    if (!template) return null;

    const buildId = build.manifest.buildId;
    const cacheKey = `${buildId}:${frame}:${crop.zoom}:${crop.left}:${crop.top}:${crop.right}:${crop.bottom}`;
    const existing = this.fieldCache.get(cacheKey);
    if (existing) {
      this.touch(cacheKey, existing);
      return existing;
    }

    const protocol = this.protocol;
    protocol.setBuildExpiry(buildId, build.expiresAtMs);

    const settled = await Promise.allSettled(crop.tiles.map(async tile => {
      const url = frameTileUrl(template, frame)
        .replaceAll('{z}', String(tile.z))
        .replaceAll('{x}', String(tile.canonicalX))
        .replaceAll('{y}', String(tile.y));
      let data: ArrayBuffer;
      let release: (() => void) | undefined;
      if (typeof protocol.requestTile === 'function') {
        const handle = protocol.requestTile(url, { priority });
        handlesOut.push(handle);
        const res = await handle.response;
        data = res.data;
        release = res.release;
      } else {
        const res = await protocol.load({ url }, new AbortController());
        data = res.data;
      }
      try {
        if (!isCurrent() || data.byteLength <= 48) return null;
        const bmp = await createImageBitmap(new Blob([data], { type: 'image/webp' }));
        return { tile, bmp };
      } finally {
        release?.();
      }
    }));
    const tileBitmaps = settled.map(result => result.status === 'fulfilled' ? result.value : null);
    try {
      if (!isCurrent() || settled.some(result => result.status === 'rejected')) return null;
      const scaleX = RAIN_FIELD_SIZE / crop.width;
      const scaleY = RAIN_FIELD_SIZE / crop.height;
      const ctx = this.decodeCanvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.clearRect(0, 0, RAIN_FIELD_SIZE, RAIN_FIELD_SIZE);
      for (const item of tileBitmaps) {
        if (!item) continue;
        ctx.drawImage(
          item.bmp,
          item.tile.drawX * scaleX,
          item.tile.drawY * scaleY,
          RASTER_TILE_SIZE * scaleX,
          RASTER_TILE_SIZE * scaleY
        );
      }

      const pixels = ctx.getImageData(0, 0, RAIN_FIELD_SIZE, RAIN_FIELD_SIZE).data;
      const west = crop.coordinates[0][0];
      const north = crop.coordinates[0][1];
      const east = crop.coordinates[1][0];
      const south = crop.coordinates[2][1];
      const field = decodePrecipRgbaToField(pixels, RAIN_FIELD_SIZE, RAIN_FIELD_SIZE, {
        west,
        south,
        east: east > west ? east : east + 360,
        north
      }, cacheKey);

      if (this.fieldCache.size >= MAX_RAIN_FIELD_CACHE) {
        const oldest = this.fieldCache.keys().next().value;
        if (oldest !== undefined) this.fieldCache.delete(oldest);
      }
      this.fieldCache.set(cacheKey, field);
      return field;
    } catch {
      return null;
    } finally {
      // Settled, so no sibling can finish later: every bitmap this decode made closes here.
      for (const item of tileBitmaps) item?.bmp.close();
    }
  }

  dispose(): void {
    this.protocol.dispose();
    this.fieldCache.clear();
  }

  private touch(key: string, field: PrecipField): void {
    this.fieldCache.delete(key);
    this.fieldCache.set(key, field);
  }
}
