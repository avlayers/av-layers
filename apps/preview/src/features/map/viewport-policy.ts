export const FOCUS_DWELL_MS = 400;

export interface MapBoundsPort {
  getBounds(): { getWest(): number; getEast(): number; getSouth(): number; getNorth(): number };
  getZoom(): number;
}

export type Bounds = [number, number, number, number];

export function cameraBounds(map: MapBoundsPort): Bounds {
  const bounds = map.getBounds(), west = bounds.getWest(), east = bounds.getEast();
  const lon = (value: number) => ((value + 180) % 360 + 360) % 360 - 180;
  return [east - west >= 360 ? -180 : lon(west), Math.max(-90, bounds.getSouth()), east - west >= 360 ? 180 : lon(east), Math.min(90, bounds.getNorth())];
}

export function windBounds(map: MapBoundsPort, lowMemory: boolean): Bounds {
  const [west, south, east, north] = cameraBounds(map);
  if (east - west >= 360 || lowMemory) return [west, south, east, north];
  const lat = Math.min(85, Math.max(-85, (south + north) / 2));
  const height = north - south, width = east >= west ? east - west : east + 360 - west;
  const meters = Math.PI * 6_371_000 / 180, lonScale = Math.max(0.2, Math.cos(lat * Math.PI / 180));
  const pad = Math.min(height * meters, width * meters * lonScale) / 2;
  return [Math.max(-180, west - pad / (meters * lonScale)), Math.max(-90, south - pad / meters), Math.min(180, east + pad / (meters * lonScale)), Math.min(90, north + pad / meters)];
}

export function coversBounds(outer: readonly [number, number, number, number], inner: readonly [number, number, number, number]): boolean {
  const span = (w: number, e: number) => (e - w + 360) % 360 || (e === w ? 0 : 360);
  return inner[1] >= outer[1] && inner[3] <= outer[3] && span(outer[0], inner[0]) + span(inner[0], inner[2]) <= span(outer[0], outer[2]);
}
