import type { Map as MapLibreMap } from 'maplibre-gl';
import { seamInsertBefore, WEATHER_CEILING_ID, windInsertBefore } from '@av/client';

export const RAIN_CUFF_LAYER_ID = 'av-rain-cuff';
const FIRST_VECTOR_LINE_ID = 'coastline';
const FIRST_VECTOR_SYMBOL_ID = 'aero-strip';
const FALLBACK_SYMBOL_ID = 'place-village';

interface ImageSourceInternal {
  readonly image?: unknown;
  readonly _imageDirty?: boolean;
}

/**
 * Inserts vector weather lines (cloud contours, isobar lines, storm perimeters) above roads,
 * borders, and weather rasters, while keeping them strictly below airport, peak, and place labels.
 */
export function weatherContourBeforeId(map: MapLibreMap): string | undefined {
  if (typeof map.getLayer === 'function') {
    if (map.getLayer(FIRST_VECTOR_SYMBOL_ID)) return FIRST_VECTOR_SYMBOL_ID;
    if (map.getLayer(FALLBACK_SYMBOL_ID)) return FALLBACK_SYMBOL_ID;
  }
  return windInsertBefore(map);
}

/**
 * Inserts the raster storm cuff (`av-rain-cuff`) above thermal lift (`av-overlay-*` + `av-hillshade-top`)
 * and cloud decks (`av-sky-clouds`), while keeping it below coastlines, roads, borders, and labels.
 */
export function rainCuffBeforeId(map: MapLibreMap): string | undefined {
  if (typeof map.getLayer === 'function' && map.getLayer(FIRST_VECTOR_LINE_ID)) {
    return FIRST_VECTOR_LINE_ID;
  }
  return weatherContourBeforeId(map);
}

/**
 * Inserts raster cloud cover (`av-sky-clouds`) strictly AFTER `av-hillshade-top` so dynamic
 * `RasterOverlay` thermal-lift slots (`av-overlay-N` inserted before `av-hillshade-top`) never
 * bury clouds on `xcskies` or high-lift views, while staying below `av-rain-cuff`, roads, and labels.
 */
export function cloudRasterBeforeId(map: MapLibreMap): string | undefined {
  if (typeof map.getLayer === 'function') {
    if (map.getLayer(RAIN_CUFF_LAYER_ID)) return RAIN_CUFF_LAYER_ID;
    if (map.getLayer(FIRST_VECTOR_LINE_ID)) return FIRST_VECTOR_LINE_ID;
    const contourAnchor = weatherContourBeforeId(map);
    if (contourAnchor) return contourAnchor;
    if (map.getLayer(WEATHER_CEILING_ID)) return undefined;
  }
  return seamInsertBefore(map);
}

/** Inserts isobar line numbers and H/L pressure centers just below wind streamlines/barbs. */
export function isobarLabelBeforeId(map: MapLibreMap): string | undefined {
  return windInsertBefore(map);
}

/** Returns true if MapLibre's `ImageSource` still holds an un-uploaded reference to `bitmap`. */
export function isBitmapPendingOnImageSource(map: MapLibreMap, sourceId: string, bitmap: ImageBitmap): boolean {
  if (typeof map.getSource !== 'function') return false;
  const src = map.getSource(sourceId) as ImageSourceInternal | undefined;
  if (!src) return false;
  return src.image === bitmap && src._imageDirty !== false;
}

/**
 * Safely manages owned `ImageBitmap` instances handed to MapLibre's `ImageSource.updateImage()`.
 * MapLibre defers `gl.texImage2D(..., this.image)` until the next `Map._render()` frame; closing
 * an `ImageBitmap` synchronously detaches `source.image` mid-render and turns the WebGL canvas black.
 */
export class OwnedImageBitmapRetirer {
  private shown: ImageBitmap | null = null;
  private readonly retired: ImageBitmap[] = [];
  private renderHooked = false;

  present(map: MapLibreMap, sourceId: string, next: ImageBitmap): void {
    if (this.shown && this.shown !== next) {
      this.retired.push(this.shown);
    }
    this.shown = next;
    this.flushUploaded(map, sourceId);

    if (this.retired.length > 0 && !this.renderHooked && typeof (map as { once?: unknown }).once === 'function') {
      this.renderHooked = true;
      map.once('render', () => {
        this.renderHooked = false;
        this.flushUploaded(map, sourceId);
      });
    }
  }

  flushUploaded(map: MapLibreMap, sourceId: string): void {
    for (let i = this.retired.length - 1; i >= 0; i--) {
      const candidate = this.retired[i]!;
      if (candidate !== this.shown && !isBitmapPendingOnImageSource(map, sourceId, candidate)) {
        this.retired.splice(i, 1);
        candidate.close();
      }
    }
  }

  /** Call strictly AFTER `map.removeLayer` and `map.removeSource` have detached the WebGL source. */
  releaseAllAfterSourceRemoved(): void {
    if (this.shown) {
      this.shown.close();
      this.shown = null;
    }
    while (this.retired.length > 0) {
      this.retired.pop()?.close();
    }
  }
}
