import { longitudeOffsetHours } from '@av/client';

/** Fixed solar UTC offset IANA identifier (`Etc/GMT±N`) from longitude. */
export function timeZoneForLongitude(lon: number): string {
  const offsetHours = longitudeOffsetHours(lon);
  if (offsetHours === 0) return 'Etc/UTC';
  const sign = offsetHours > 0 ? '-' : '+';
  return `Etc/GMT${sign}${Math.abs(offsetHours)}`;
}

/**
 * Civil DST-aware IANA timeZone lookup for supported soaring regions (North America,
 * Europe, and Caucasus), falling back to solar `Etc/GMT±N` over ocean and unmapped areas.
 */
export function resolveCivilTimeZone(lat: number, lon: number): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return 'Etc/UTC';

  // Hawaii
  if (lat >= 18.5 && lat <= 22.8 && lon >= -161 && lon <= -154) return 'Pacific/Honolulu';
  // Alaska
  if (lat >= 54 && lat <= 72 && lon >= -169 && lon <= -130) return 'America/Anchorage';

  // Continental North America (CONUS / southern Canada / northern Mexico)
  if (lat >= 24 && lat <= 60 && lon >= -126 && lon <= -52) {
    // Arizona (no DST outside Navajo Nation)
    if (lat >= 31.3 && lat <= 37.0 && lon >= -114.8 && lon <= -109.05) {
      if (!(lat >= 35.4 && lon >= -111.1)) return 'America/Phoenix';
    }
    if (lon < -114.5) return 'America/Los_Angeles';
    if (lon < -102.05) return 'America/Denver';
    if (lon < -85.5) return 'America/Chicago';
    if (lon < -67.0) return 'America/New_York';
    return 'America/Halifax';
  }

  // Caucasus & Anatolia (AV-WRF / ICON-EU eastern domain)
  if (lat >= 38.0 && lat <= 43.8 && lon >= 40.0 && lon <= 50.8) {
    if (lon >= 46.7) return 'Asia/Baku';
    if (lat >= 41.15 && lon <= 46.7) return 'Asia/Tbilisi';
    if (lat >= 38.8 && lon >= 43.4) return 'Asia/Yerevan';
  }
  if (lat >= 36.0 && lat <= 42.2 && lon >= 26.0 && lon < 43.4) return 'Europe/Istanbul';

  // Europe (ICON-EU domain)
  if (lat >= 35.0 && lat <= 71.5 && lon >= -11.0 && lon <= 32.0) {
    if (lon < -1.0 || (lat >= 50.0 && lat <= 61.0 && lon < 1.8) || (lat >= 36.8 && lat <= 42.2 && lon < -6.2)) {
      return 'Europe/London';
    }
    if (lon < 20.5) return 'Europe/Paris';
    return 'Europe/Athens';
  }

  return timeZoneForLongitude(lon);
}

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

/** UTC offset in minutes (east positive, west negative) for `validMs` in `timeZone`. */
export function timeZoneOffsetMinutesAt(validMs: number, timeZone: string): number {
  if (!Number.isFinite(validMs)) return 0;
  if (timeZone === 'UTC' || timeZone === 'Etc/UTC') return 0;
  let formatter = offsetFormatters.get(timeZone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      });
      if (offsetFormatters.size >= 64) offsetFormatters.clear();
      offsetFormatters.set(timeZone, formatter);
    } catch {
      return 0;
    }
  }
  const parts = formatter.formatToParts(new Date(validMs));
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? 0);
  const localAsUtcMs = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return Math.round((localAsUtcMs - validMs) / 60_000);
}
