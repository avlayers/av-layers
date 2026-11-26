import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { RASTER_PAN_TILES } from '../raster/raster-budget';
import { compositeBasemapStyle } from './basemap';
import { DEFAULT_THEME, type MapTheme } from '../../themes/registry';

maplibregl.setWorkerUrl(workerUrl);

interface MapOptions {
  readonly container: HTMLElement;
  readonly offlineFixture: boolean;
  readonly camera: { center: [number, number]; zoom: number } | null;
  readonly theme?: MapTheme;
}

/**
 * Attribution as the compact ⓘ button at every width, starting collapsed. MapLibre expands a compact control the
 * first time it compacts; this collapses it again so the credits open only on request.
 */
class CollapsedAttribution extends maplibregl.AttributionControl {
  constructor() {
    super({ compact: true });
    const update = this._updateCompact;
    this._updateCompact = () => {
      const wasCompact = this._container?.classList.contains('maplibregl-compact') ?? false;
      update();
      if (!wasCompact && this._container?.classList.contains('maplibregl-compact')) this._updateCompactMinimize();
    };
  }
}

/** Owns the single MapLibre instance for one preview app lifetime. */
export function createMap(options: MapOptions): maplibregl.Map {
  const map = createMapInstance(options);
  if (typeof map.addControl === 'function') map.addControl(new CollapsedAttribution(), 'bottom-right');
  return map;
}

function createMapInstance(options: MapOptions): maplibregl.Map {
  return new maplibregl.Map({
    attributionControl: false,
    container: options.container,
    center: options.camera?.center ?? [0, 20], zoom: options.camera?.zoom ?? 2,
    maxTileCacheSize: RASTER_PAN_TILES,
    maxTileCacheZoomLevels: 2,
    style: options.offlineFixture
      ? { version: 8, sources: {}, layers: [{ id: 'neutral-background', type: 'background', paint: { 'background-color': '#d5dde3' } }] }
      : compositeBasemapStyle(options.theme ?? DEFAULT_THEME)
  });
}

export { maplibregl };

interface MapCameraOptions {
  readonly home: { lat: number; lng: number };
  readonly followsPlace: boolean;
  /** Zone the clock uses until the camera follows a place: the browser's. */
  readonly browserTimeZone: string;
  /** Civil zone lookup, a separate chunk so `tz-lookup` stays out of the startup bundle. */
  readonly loadZoneLookup?: () => Promise<(lat: number, lng: number) => string>;
}

export interface MapCamera {
  readonly home: { lat: number; lng: number };
  /** IANA zone of the map centre (the nautical longitude zone offshore), or the browser zone before the camera follows a place. */
  timeZone(): string;
  /** Settles once the zone lookup has loaded (or failed); `sync` then resolves place zones. */
  readonly zoneReady: Promise<void>;
  followsPlace(): boolean;
  sync(): { changed: boolean; center: { lat: number; lng: number } };
  focusRegion(bounds: readonly [number, number, number, number] | undefined): void;
  scale(units: 'metric' | 'imperial'): { width: number; text: string };
}

const ZONE_LOOKUP_STEP_DEG = 0.05;

/** Camera-derived clock, regional focus and scale for the preview map. */
export function createMapCamera(map: maplibregl.Map, options: MapCameraOptions): MapCamera {
  let follows = options.followsPlace, zone = options.browserTimeZone;
  let lookup: ((lat: number, lng: number) => string) | null = null, lookedUp: { lat: number; lng: number } | null = null;
  const zoneReady = options.loadZoneLookup?.().then(fn => { lookup = fn; }, () => {}) ?? Promise.resolve();
  return {
    home: options.home,
    zoneReady,
    timeZone: () => zone,
    followsPlace: () => follows,
    sync() {
      const center = map.getCenter();
      if (!follows) {
        const moved = Math.abs(center.lat - options.home.lat) > 1e-4 || Math.abs(((center.lng - options.home.lng + 540) % 360) - 180) > 1e-4;
        if (moved) follows = true;
      }
      let next = zone;
      if (!follows) next = options.browserTimeZone;
      else if (lookup && Number.isFinite(center.lat) && Number.isFinite(center.lng)) {
        const stale = !lookedUp || Math.abs(center.lat - lookedUp.lat) >= ZONE_LOOKUP_STEP_DEG || Math.abs(center.lng - lookedUp.lng) >= ZONE_LOOKUP_STEP_DEG;
        if (stale) { next = lookup(center.lat, center.lng); lookedUp = { lat: center.lat, lng: center.lng }; }
      }
      const changed = next !== zone;
      zone = next;
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
