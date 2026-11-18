import { gridOutline, type GeographicBounds, type GeographicPoint, type Grid } from '@av/contracts/geometry';
import type { LayerId } from '@av/contracts/layers';
import { MODEL_OPTIONS } from '@av/contracts/model-options';
import { outlineMeetsView } from './client-view.js';
import type { PinnedBuild } from './client-types.js';

export const SEAM_SOURCE_ID = 'av-seam';
export const SEAM_HALO_ID = 'av-seam-halo';
export const SEAM_LINE_ID = 'av-seam-line';
export const SEAM_LABEL_ID = 'av-seam-label';
export const WEATHER_CEILING_ID = 'av-hillshade-top';

/** Coverage parallels for a longitude-wrapping grid. Endpoints stay off exact ±180. */
export function coverageParallels(bounds: GeographicBounds): GeographicPoint[][] {
  const [west, south, east, north] = bounds;
  if (!(east > west)) return [];
  return [north, south].map(lat => parallel(lat, Math.max(west, -179.9), Math.min(east, 179.9))).filter(line => line.length >= 2);
}

function parallel(lat: number, west: number, east: number): GeographicPoint[] {
  if (!Number.isFinite(lat) || !(lat > -90) || !(lat < 90) || !(east > west)) return [];
  const points: GeographicPoint[] = [];
  for (let lon = west; lon < east; lon += 10) points.push({ lat, lon });
  points.push({ lat, lon: east });
  return points;
}

/** Cell-center ring, or coverage parallels when the grid wraps longitude. */
export function seamLines(grid: Grid, bounds: GeographicBounds): GeographicPoint[][] {
  return grid.wrapLongitude ? coverageParallels(bounds) : gridOutline(grid);
}

export function seamLabel(model: string): string {
  return `${MODEL_OPTIONS.find(option => option.modelId === model)?.label ?? model} coverage`;
}

export interface SeamMap {
  addSource(id: string, source: object): void;
  getSource(id: string): object | undefined;
  removeSource(id: string): void;
  addLayer(layer: object, beforeId?: string): void;
  getLayer(id: string): unknown;
  removeLayer(id: string): void;
  getBounds(): { getWest(): number; getSouth(): number; getEast(): number; getNorth(): number };
}

export function seamInsertBefore(map: { getLayer(id: string): unknown }): string | undefined {
  if (map.getLayer(WEATHER_CEILING_ID)) return WEATHER_CEILING_ID;
  return map.getLayer(SEAM_HALO_ID) ? SEAM_HALO_ID : undefined;
}

export function windInsertBefore(map: { getLayer(id: string): unknown }): string | undefined {
  return map.getLayer(SEAM_HALO_ID) ? SEAM_HALO_ID : undefined;
}

/** Install or remove the seam for the displayed layer. `label` is for maps whose style has glyphs. */
export function syncCoverageSeam(map: SeamMap, build: PinnedBuild | null, layer: LayerId | null, label: boolean): void {
  const surface = build && layer ? build.manifest.surfaces.find(item => item.layers.includes(layer)) : undefined;
  const lines = surface ? seamLines(surface.grid, build!.manifest.descriptors.bounds) : [];
  const view = map.getBounds();
  const visible = lines.length > 0 && outlineMeetsView(lines, { west: view.getWest(), south: view.getSouth(), east: view.getEast(), north: view.getNorth() });
  if (!build || !visible) { clearSeam(map); return; }
  paintSeam(map, featureCollection(lines, seamLabel(build.manifest.model)), label);
}

function featureCollection(lines: GeographicPoint[][], label: string) {
  return {
    type: 'FeatureCollection' as const,
    features: lines.filter(line => line.length >= 2).map(line => ({
      type: 'Feature' as const,
      properties: { label },
      geometry: { type: 'LineString' as const, coordinates: line.map(point => [point.lon, point.lat]) }
    }))
  };
}

const haloLayer = { id: SEAM_HALO_ID, type: 'line', source: SEAM_SOURCE_ID, paint: { 'line-color': '#1c2430', 'line-opacity': 0.45, 'line-width': 2.5 } };
const dashLayer = { id: SEAM_LINE_ID, type: 'line', source: SEAM_SOURCE_ID, paint: { 'line-color': '#f4f7f8', 'line-width': 1.25, 'line-dasharray': [2, 2] } };
const labelLayer = {
  id: SEAM_LABEL_ID, type: 'symbol', source: SEAM_SOURCE_ID,
  layout: {
    'symbol-placement': 'line', 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 12,
    'text-rotation-alignment': 'viewport', 'text-keep-upright': true, 'text-allow-overlap': true, 'text-ignore-placement': true, 'symbol-spacing': 800
  },
  paint: { 'text-color': '#f4f7f8', 'text-halo-color': '#1c2430', 'text-halo-width': 1.2 }
};

function paintSeam(map: SeamMap, data: ReturnType<typeof featureCollection>, label: boolean): void {
  const source = map.getSource(SEAM_SOURCE_ID) as { setData?: (value: unknown) => void; data?: unknown } | undefined;
  if (source) { if (typeof source.setData === 'function') source.setData(data); else source.data = data; }
  else map.addSource(SEAM_SOURCE_ID, { type: 'geojson', data });
  if (!map.getLayer(SEAM_HALO_ID)) map.addLayer(haloLayer);
  if (!map.getLayer(SEAM_LINE_ID)) map.addLayer(dashLayer);
  if (label && !map.getLayer(SEAM_LABEL_ID)) map.addLayer(labelLayer);
  if (!label && map.getLayer(SEAM_LABEL_ID)) map.removeLayer(SEAM_LABEL_ID);
}

function clearSeam(map: SeamMap): void {
  for (const id of [SEAM_LABEL_ID, SEAM_LINE_ID, SEAM_HALO_ID]) if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(SEAM_SOURCE_ID)) map.removeSource(SEAM_SOURCE_ID);
}
