import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { RASTER_CACHE_TILES } from '../raster/raster-budget';
import { naturalBasemapStyle } from './basemap';

maplibregl.setWorkerUrl(workerUrl);

export interface MapOptions {
  readonly container: HTMLElement;
  readonly offlineFixture: boolean;
  readonly camera: { center: [number, number]; zoom: number } | null;
  readonly deviceMemory: number | undefined;
}

/** Owns the single MapLibre instance for one preview app lifetime. */
export function createMap(options: MapOptions): maplibregl.Map {
  return new maplibregl.Map({
    container: options.container,
    center: options.camera?.center ?? [0, 20], zoom: options.camera?.zoom ?? 2,
    ...(options.deviceMemory !== undefined && options.deviceMemory <= 4 ? { maxTileCacheSize: RASTER_CACHE_TILES } : {}),
    style: options.offlineFixture
      ? { version: 8, sources: {}, layers: [{ id: 'neutral-background', type: 'background', paint: { 'background-color': '#d5dde3' } }] }
      : naturalBasemapStyle(window.devicePixelRatio)
  });
}

export { maplibregl };
