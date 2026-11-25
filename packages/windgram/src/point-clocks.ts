// Point and map valid-time label shown when the chart hour differs from the map hour.

import { formatPlaceTime, formatPointMapTimes, type GeoPoint } from '@av/client';
import { formatSitePlaceTime } from '@av/client/timezone';

export function formatSplitClocks(
  point: GeoPoint,
  explicitTimeZone: string | undefined,
  isUtcFallback: boolean,
  pointValidTime: string | null,
  pointOffsetMinutes: number,
  mapValidTime: string | null,
  mapOffsetMinutes: number,
): string {
  if (!pointValidTime) return 'Point time unavailable';
  if (!isUtcFallback) {
    return formatPointMapTimes(
      { validTime: pointValidTime, offsetMinutes: pointOffsetMinutes },
      mapValidTime ? { validTime: mapValidTime, offsetMinutes: mapOffsetMinutes } : null,
    );
  }
  const pointMs = Date.parse(pointValidTime);
  const pointStamp = formatSitePlaceTime(pointMs, point, 'stamp', explicitTimeZone);
  if (!mapValidTime) return `Point: ${pointStamp} · Map: unavailable`;
  const mapMs = Date.parse(mapValidTime);
  if (pointMs === mapMs && mapOffsetMinutes === 0) return `Point and map: ${pointStamp}`;
  const mapStamp = mapOffsetMinutes === 0
    ? formatSitePlaceTime(mapMs, point, 'stamp', explicitTimeZone)
    : formatPlaceTime(mapMs, mapOffsetMinutes, 'stamp');
  return `Point: ${pointStamp} · Map: ${mapStamp}`;
}
