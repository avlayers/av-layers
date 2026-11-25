import tzLookup from '@photostructure/tz-lookup';
import { normalizeLon } from '@av/contracts/geometry';
import { cachedFormatter, formatPlaceTime, isUtcZone, longitudeOffsetHours, timeZoneOffsetMinutesAt, type PlaceTimeStyle } from './client-time.ts';

export { timeZoneOffsetMinutesAt };
import type { GeoPoint } from './client-types.ts';

export interface SiteTimeZoneResolution {
  readonly timeZone: string;
  readonly isUtcFallback: boolean;
}

/** Fixed solar UTC offset IANA identifier (`Etc/GMT±N`) from longitude. */
export function timeZoneForLongitude(lon: number): string {
  const offsetHours = longitudeOffsetHours(lon);
  return offsetHours === 0 ? 'Etc/UTC' : `Etc/GMT${offsetHours > 0 ? '-' : '+'}${Math.abs(offsetHours)}`;
}

/**
 * Resolves the civil IANA time zone for `(lat, lon)` via `@photostructure/tz-lookup`,
 * returning `{ timeZone: 'UTC', isUtcFallback: true }` over international waters.
 */
export function resolveSiteTimeZone(lat: number, lon: number): SiteTimeZoneResolution {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90) {
    return { timeZone: 'UTC', isUtcFallback: true };
  }
  try {
    const timeZone = tzLookup(lat, normalizeLon(lon));
    if (!timeZone || timeZone.startsWith('Etc/')) return { timeZone: 'UTC', isUtcFallback: true };
    return { timeZone, isUtcFallback: false };
  } catch {
    return { timeZone: 'UTC', isUtcFallback: true };
  }
}

/** Civil IANA time zone for `(lat, lon)`, returning `'UTC'` over international waters. */
export function resolveCivilTimeZone(lat: number, lon: number): string {
  return resolveSiteTimeZone(lat, lon).timeZone;
}

const shortZoneFormatters = new Map<string, Intl.DateTimeFormat>();
const SHORT_ZONE_OPTIONS: Intl.DateTimeFormatOptions = { timeZoneName: 'short' };

/** Short time-zone abbreviation (such as `EDT`, `EST`, `CEST`, `UTC+4`) at `validMs`. */
export function shortTimeZoneNameAt(validMs: number, timeZone: string): string {
  if (!Number.isFinite(validMs) || isUtcZone(timeZone)) return 'UTC';
  const formatter = cachedFormatter(shortZoneFormatters, timeZone, SHORT_ZONE_OPTIONS);
  return formatter?.formatToParts(new Date(validMs)).find(p => p.type === 'timeZoneName')?.value ?? 'UTC';
}

/** Per-instant civil UTC offset and fallback metadata for a geographic point. */
export function pointOffsetMinutesAt(
  point: GeoPoint,
  validMs: number,
  explicitTimeZone?: string,
): { readonly offsetMinutes: number; readonly timeZone: string; readonly isUtcFallback: boolean } {
  const resolved = explicitTimeZone
    ? { timeZone: explicitTimeZone, isUtcFallback: isUtcZone(explicitTimeZone) }
    : resolveSiteTimeZone(point.lat, point.lon);
  return {
    offsetMinutes: timeZoneOffsetMinutesAt(validMs, resolved.timeZone),
    timeZone: resolved.timeZone,
    isUtcFallback: resolved.isUtcFallback,
  };
}

/** Formats an instant at a point using its civil time zone, labeling unmapped offshore sites as UTC. */
export function formatSitePlaceTime(
  validMs: number,
  point: GeoPoint,
  style: PlaceTimeStyle = 'stamp',
  explicitTimeZone?: string,
): string {
  if (!Number.isFinite(validMs)) return '—';
  const resolved = pointOffsetMinutesAt(point, validMs, explicitTimeZone);
  if (!resolved.isUtcFallback) return formatPlaceTime(validMs, resolved.offsetMinutes, style);
  const date = new Date(validMs);
  const clock = `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')} UTC`;
  if (style === 'clock') return clock;
  const monthDay = date.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
  return `${monthDay}, ${clock} (UTC fallback)`;
}
