import type { Map as MapLibreMap } from 'maplibre-gl';
import { clampOpacity, previewRasterLayer } from '@av/client';
import type { ResolvedChannelStyles } from '../map/channel-styles';
import type { PrecipField } from './precip-field';
import { renderRainInnerVignetteRgba } from './rain-cuff';
import {
  isBitmapPendingOnImageSource,
  OwnedImageBitmapRetirer,
  RAIN_CUFF_LAYER_ID,
  rainCuffBeforeId
} from './sky-layer-order';

type Coordinates = [[number, number], [number, number], [number, number], [number, number]];
interface ImageSourceLike {
  updateImage?: (options: { image: ImageBitmap; coordinates: Coordinates }) => void;
}

interface CachedRainCuff {
  readonly hasCuff: boolean;
  readonly bitmap: ImageBitmap | null;
  readonly coordinates: Coordinates;
}

const RAIN_CUFF_SOURCE_ID = RAIN_CUFF_LAYER_ID;
const MAX_CUFF_CACHE = 48;

/**
 * Owns the `av-rain-cuff` image source and raster layer: renders the inner vignette per field
 * into a cached `ImageBitmap` and retires bitmaps only after MapLibre has uploaded their successor.
 */
export class RainCuffLayer {
  private canvas: OffscreenCanvas | null = null;
  private readonly bitmaps = new OwnedImageBitmapRetirer();
  private readonly cache = new Map<string, CachedRainCuff>();
  private shownBitmap: ImageBitmap | null = null;
  private shownKey = '';
  private dryHidden = false;
  private lastStyleSig = '';

  constructor(private readonly map: MapLibreMap) {}

  paint(field: PrecipField, styles: ResolvedChannelStyles, opacity: number, visible: boolean): void {
    const canvas = this.canvas ??= new OffscreenCanvas(field.cols, field.rows);

    const cuffKey = `${field.key}:${styles.rainEdge.cuffRgb.join(',')}:${styles.rainEdge.cuffMaxAlpha}`;
    let entry = this.cache.get(cuffKey);
    if (entry) {
      this.cache.delete(cuffKey);
      this.cache.set(cuffKey, entry);
    } else {
      const coordinates: Coordinates = [
        [field.west, field.north],
        [field.east, field.north],
        [field.east, field.south],
        [field.west, field.south]
      ];
      if (canvas.width !== field.cols) canvas.width = field.cols;
      if (canvas.height !== field.rows) canvas.height = field.rows;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;

      const img = ctx.createImageData(field.cols, field.rows);
      const hasCuff = renderRainInnerVignetteRgba(field, styles, img.data);
      let bitmap: ImageBitmap | null = null;
      if (hasCuff) {
        ctx.putImageData(img, 0, 0);
        try { bitmap = canvas.transferToImageBitmap(); }
        catch { return; }
      }
      if (this.cache.size >= MAX_CUFF_CACHE) this.evictOldest();
      entry = { hasCuff, bitmap, coordinates };
      this.cache.set(cuffKey, entry);
    }

    if (!entry.hasCuff || !entry.bitmap) {
      // Keep any mounted cuff source intact at opacity 0 instead of removing/re-adding layers on dry<->wet scrubs.
      if (!this.dryHidden) {
        this.dryHidden = true;
        this.lastStyleSig = '';
      }
      if (this.map.getLayer(RAIN_CUFF_SOURCE_ID)) {
        this.map.setPaintProperty(RAIN_CUFF_SOURCE_ID, 'raster-opacity', 0);
      }
      return;
    }

    if (this.dryHidden) {
      this.dryHidden = false;
      this.lastStyleSig = '';
    }

    const existing = this.map.getSource(RAIN_CUFF_SOURCE_ID) as ImageSourceLike | undefined;
    if (!existing) {
      this.shownKey = '';
      this.lastStyleSig = '';
      this.map.addSource(RAIN_CUFF_SOURCE_ID, { type: 'image', coordinates: entry.coordinates });
      const layer = previewRasterLayer(visible ? clampOpacity(0.66 + opacity * 0.34) : 0);
      this.map.addLayer(
        { ...layer, id: RAIN_CUFF_SOURCE_ID, source: RAIN_CUFF_SOURCE_ID, paint: { ...layer.paint, 'raster-opacity-transition': { duration: 0, delay: 0 } } },
        rainCuffBeforeId(this.map)
      );
    }

    if (this.shownKey !== cuffKey) {
      const src = this.map.getSource(RAIN_CUFF_SOURCE_ID) as ImageSourceLike | undefined;
      if (src?.updateImage) {
        src.updateImage({ image: entry.bitmap, coordinates: entry.coordinates });
        this.shownBitmap = entry.bitmap;
        this.shownKey = cuffKey;
        this.bitmaps.flushUploaded(this.map, RAIN_CUFF_SOURCE_ID);
      }
    }
  }

  syncStyle(opacity: number, visible: boolean): void {
    const hasLayer = Boolean(this.map.getLayer(RAIN_CUFF_SOURCE_ID));
    const cuffOpacity = visible && !this.dryHidden ? clampOpacity(0.66 + opacity * 0.34) : 0;
    const sig = `${hasLayer}:${visible}:${cuffOpacity.toFixed(3)}`;
    if (sig === this.lastStyleSig) return;
    this.lastStyleSig = sig;
    if (hasLayer) this.map.setPaintProperty(RAIN_CUFF_SOURCE_ID, 'raster-opacity', cuffOpacity);
  }

  /** Removes the layer and source, then closes every cached bitmap. */
  clear(): void {
    this.shownBitmap = null;
    this.shownKey = '';
    this.dryHidden = false;
    this.lastStyleSig = '';
    if (typeof this.map.getLayer === 'function' && this.map.getLayer(RAIN_CUFF_SOURCE_ID)) {
      this.map.removeLayer(RAIN_CUFF_SOURCE_ID);
    }
    if (typeof this.map.getSource === 'function' && this.map.getSource(RAIN_CUFF_SOURCE_ID)) {
      this.map.removeSource(RAIN_CUFF_SOURCE_ID);
    }
    for (const entry of this.cache.values()) entry.bitmap?.close();
    this.cache.clear();
    this.bitmaps.releaseAllAfterSourceRemoved();
  }

  private evictOldest(): void {
    for (const [oldKey, oldVal] of this.cache) {
      if (oldVal.bitmap && oldVal.bitmap === this.shownBitmap) continue;
      this.cache.delete(oldKey);
      if (oldVal.bitmap) {
        if (isBitmapPendingOnImageSource(this.map, RAIN_CUFF_SOURCE_ID, oldVal.bitmap)) {
          this.bitmaps.present(this.map, RAIN_CUFF_SOURCE_ID, oldVal.bitmap);
        } else {
          oldVal.bitmap.close();
        }
      }
      return;
    }
  }
}
