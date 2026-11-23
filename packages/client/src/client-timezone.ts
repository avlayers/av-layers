import tzLookup from '@photostructure/tz-lookup';
import { formatPlaceTime, longitudeOffsetHours, type PlaceTimeStyle } from './client-time.ts';
import type { GeoPoint } from './client-types.ts';

export interface SiteTimeZoneResolution {
  readonly timeZone: string;
  readonly isUtcFallback: boolean;
}

const isUtcZone = (timeZone: string): boolean => timeZone === 'UTC' || timeZone === 'Etc/UTC';

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
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return { timeZone: 'UTC', isUtcFallback: true };
  }
  try {
    const timeZone = tzLookup(lat, lon);
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

function cachedFormatter(
  cache: Map<string, Intl.DateTimeFormat>,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat | null {
  let formatter = cache.get(timeZone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-US', { timeZone, ...options });
      if (cache.size >= 64) cache.clear();
      cache.set(timeZone, formatter);
    } catch {
      return null;
    }
  }
  return formatter;
}

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();
const OFFSET_PARTS_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
};

/** UTC offset in minutes (east positive, west negative) for `validMs` in `timeZone`. */
export function timeZoneOffsetMinutesAt(validMs: number, timeZone: string): number {
  if (!Number.isFinite(validMs) || isUtcZone(timeZone)) return 0;
  const formatter = cachedFormatter(offsetFormatters, timeZone, OFFSET_PARTS_OPTIONS);
  if (!formatter) return 0;
  const parts = formatter.formatToParts(new Date(validMs));
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? 0);
  const localAsUtcMs = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((localAsUtcMs - validMs) / 60_000);
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
