import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { longitudeOffsetHours } from '@av/client';
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

export interface MapCameraOptions {
  readonly home: { lat: number; lng: number };
  readonly followsPlace: boolean;
  readonly initialOffset: number;
  readonly browserOffset: number;
}

export interface MapCamera {
  readonly home: { lat: number; lng: number };
  offsetMinutes(): number;
  followsPlace(): boolean;
  sync(): { changed: boolean; center: { lat: number; lng: number } };
  focusRegion(bounds: readonly [number, number, number, number] | undefined): void;
  scale(units: 'metric' | 'imperial'): { width: number; text: string };
}

/** Camera-derived clock, regional focus and scale for the preview map. */
export function createMapCamera(map: maplibregl.Map, options: MapCameraOptions): MapCamera {
  let follows = options.followsPlace, offset = options.initialOffset;
  return {
    home: options.home,
    offsetMinutes: () => offset,
    followsPlace: () => follows,
    sync() {
      const center = map.getCenter();
      if (!follows) {
        const moved = Math.abs(center.lat - options.home.lat) > 1e-4 || Math.abs(((center.lng - options.home.lng + 540) % 360) - 180) > 1e-4;
        if (moved) follows = true;
      }
      const next = Number.isFinite(center.lng) ? longitudeOffsetHours(center.lng) * 60 : offset;
      const changed = next !== offset;
      offset = next;
      return { changed, center: { lat: center.lat, lng: center.lng } };
    },
    focusRegion(bounds) {
      if (bounds && bounds[2] - bounds[0] < 360) map.fitBounds([[bounds[0], bounds[1]], [bounds[0] <= bounds[2] ? bounds[2] : bounds[2] + 360, bounds[3]]], { padding: 32, duration: 0 });
    },
    scale(units) {
      const metres = 80 * 2 * Math.PI * 6371000 * Math.cos(Math.min(85, Math.abs(map.getCenter().lat)) * Math.PI / 180) / (512 * 2 ** map.getZoom());
      const distance = metres / (units === 'metric' ? 1000 : 1609.344);
      const magnitude = 10 ** Math.floor(Math.log10(distance)), value = ([10, 5, 2, 1].find(candidate => candidate * magnitude <= distance) ?? 1) * magnitude;
      return { width: Math.max(1, 80 * value / distance), text: `${Number(value.toPrecision(2))} ${units === 'metric' ? 'km' : 'mi'}` };
    }
  };
}
