import { normalizeLon } from '@av/contracts/geometry';
import { renderedFrames, type ManifestV5 } from '@av/contracts/publication';

export interface FrameLike {
  id: string;
  validTime: string;
  intervalStart: string;
  intervalEnd: string;
}

/** Approximate local clock offset from longitude, in whole hours. */
export function longitudeOffsetHours(lon: number): number {
  return Math.round(normalizeLon(lon) / 15);
}

export type PlaceTimeStyle = 'clock' | 'stamp';

export interface PlaceClock {
  readonly validTime: string;
  readonly offsetMinutes: number;
}

const MONTH_DAY: Intl.DateTimeFormatOptions = { timeZone: 'UTC', month: 'short', day: 'numeric' };

/** Local calendar date `YYYY-MM-DD` for a fixed offset from UTC. */
export function placeDateKey(utcMs: number, offsetMinutes: number): string {
  if (!Number.isFinite(utcMs) || !Number.isFinite(offsetMinutes)) return '';
  return new Date(utcMs + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

function clockDigits(utcMs: number): string {
  const date = new Date(utcMs);
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
}

function monthDay(utcMs: number): string {
  return new Date(utcMs).toLocaleDateString('en-US', MONTH_DAY);
}

/** Local time for a fixed offset, with UTC in parentheses. */
export function formatPlaceTime(utcMs: number, offsetMinutes: number, style: PlaceTimeStyle = 'stamp'): string {
  if (!Number.isFinite(utcMs) || !Number.isFinite(offsetMinutes)) return '—';
  const localMs = utcMs + offsetMinutes * 60_000;
  const localClock = clockDigits(localMs);
  const utcClock = clockDigits(utcMs);
  const sameDay = placeDateKey(utcMs, offsetMinutes) === placeDateKey(utcMs, 0);
  if (style === 'clock') return sameDay ? `${localClock} (${utcClock} UTC)` : `${localClock} (${utcClock} UTC, ${monthDay(utcMs)})`;
  const localDate = monthDay(localMs);
  return sameDay ? `${localDate}, ${localClock} (${utcClock} UTC)` : `${localDate}, ${localClock} (${monthDay(utcMs)}, ${utcClock} UTC)`;
}

/** IANA zone of this browser, or `UTC` when the zone cannot be read. */
export function browserTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

function viewerFallback(utcMs: number): string {
  const year = new Date(utcMs).getUTCFullYear();
  const clock = clockDigits(utcMs);
  return `${monthDay(utcMs)}, ${year}, ${clock} (${clock} UTC)`;
}

/** Browser wall-clock time, with UTC in parentheses. */
export function formatViewerTime(utcMs: number, timeZone: string): string {
  if (!Number.isFinite(utcMs)) return '—';
  let localDate = '';
  let localMonthDay = '';
  let hour = Number.NaN;
  let minute = '';
  try {
    const date = new Date(utcMs);
    localDate = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
    localMonthDay = new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric' }).format(date);
    const clock = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) => clock.find(item => item.type === type)?.value ?? '';
    hour = Number(part('hour')) % 24;
    minute = part('minute');
  } catch {
    return viewerFallback(utcMs);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate) || !localMonthDay || !Number.isFinite(hour) || !/^\d{2}$/.test(minute)) return viewerFallback(utcMs);
  const localYear = localDate.slice(0, 4);
  const local = `${localMonthDay}, ${localYear}, ${String(hour).padStart(2, '0')}:${minute}`;
  const utcDate = new Date(utcMs).toISOString().slice(0, 10);
  const utcClock = clockDigits(utcMs);
  if (localDate === utcDate) return `${local} (${utcClock} UTC)`;
  const utcYear = utcDate.slice(0, 4);
  const utcWhen = localYear === utcYear ? `${monthDay(utcMs)}, ${utcClock}` : `${monthDay(utcMs)}, ${utcYear}, ${utcClock}`;
  return `${local} (${utcWhen} UTC)`;
}

/** Point and map clocks. The same instant and offset share one stamp. */
export function formatPointMapTimes(point: PlaceClock | null, map: PlaceClock | null): string {
  if (!point) return 'Point time unavailable';
  const pointMs = Date.parse(point.validTime);
  const pointStamp = formatPlaceTime(pointMs, point.offsetMinutes, 'stamp');
  if (!map) return `Point: ${pointStamp} · Map: unavailable`;
  const mapMs = Date.parse(map.validTime);
  if (pointMs === mapMs && point.offsetMinutes === map.offsetMinutes) return `Point and map: ${pointStamp}`;
  return `Point: ${pointStamp} · Map: ${formatPlaceTime(mapMs, map.offsetMinutes, 'stamp')}`;
}

export function frameTime(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new RangeError(`Invalid frame timestamp: ${value}`);
  return parsed;
}

export function selectExplicitFrame<T extends FrameLike>(frames: readonly T[], id: string): T | null {
  return frames.find(frame => frame.id === id) ?? null;
}

/** Latest frame whose valid time is at or before the host instant, or the earliest frame when the host is earlier than all of them. */
export function selectHostFrame<T extends FrameLike>(frames: readonly T[], timestampMs: number): T | null {
  if (!Number.isFinite(timestampMs) || frames.length === 0) return null;
  let covered: T | null = null;
  let coveredAt = Number.NEGATIVE_INFINITY;
  let earliest: T | null = null;
  let earliestAt = Number.POSITIVE_INFINITY;
  for (const frame of frames) {
    const valid = frameTime(frame.validTime);
    if (valid < earliestAt) {
      earliest = frame;
      earliestAt = valid;
    }
    if (valid <= timestampMs && valid >= coveredAt) {
      covered = frame;
      coveredAt = valid;
    }
  }
  return covered ?? earliest;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function formatBuildFreshness(
  manifest: Pick<ManifestV5, 'buildId' | 'createdAt'>,
  expiresAtMs: number,
  now = Date.now()
): string {
  return `Pinned build ${manifest.buildId} · age ${formatDuration(buildAgeMs(manifest.createdAt, now))} · expires in ${formatDuration(expiresAtMs - now)}`;
}

/** Compact model-run label for the model picker: `06Z run · 3 h old`. */
export function formatRunAge(cycle: string, now = Date.now()): string {
  const cycleMs = Date.parse(cycle);
  if (!Number.isFinite(cycleMs)) return '';
  const minutes = Math.max(0, Math.round((now - cycleMs) / 60_000));
  const age = minutes < 60 ? `${minutes} min` : minutes < 2880 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} d`;
  return `${new Date(cycleMs).toISOString().slice(11, 13)}Z run · ${age} old`;
}

export function watchBuildExpiry(expiresAtMs: number, expire: () => void, targets: EventTarget[]): () => void {
  if (!Number.isFinite(expiresAtMs)) throw new RangeError('Invalid expiry deadline');
  let fired = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const check = () => {
    if (fired) return;
    const remaining = expiresAtMs - Date.now();
    if (remaining <= 0) {
      fired = true;
      expire();
      return;
    }
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(check, Math.min(2_147_000_000, remaining));
  };
  const events = ['visibilitychange', 'pageshow', 'focus'];
  for (const target of targets) for (const event of events) target.addEventListener(event, check);
  check();
  return () => {
    fired = true;
    if (timer !== null) clearTimeout(timer);
    for (const target of targets) for (const event of events) target.removeEventListener(event, check);
  };
}

type MapTimeline = Parameters<typeof renderedFrames>[0];

export function mapForecastEnd(manifest: MapTimeline): number | null {
  const frames = renderedFrames(manifest);
  return frames.length ? Math.max(...frames.map(frame => frameTime(frame.validTime))) : null;
}

export function mapForecastHorizonNotice(manifest: MapTimeline, nowMs = Date.now(), formatTime?: (ms: number) => string): string | null {
  const endMs = mapForecastEnd(manifest);
  if (endMs === null || nowMs < endMs) return null;
  const when = formatTime ? formatTime(endMs) : new Date(endMs).toISOString();
  return `Map forecast ended at ${when} — update overdue. Showing historical forecast.`;
}

export function buildAgeMs(createdAt: string, now = Date.now()): number {
  return Math.max(0, now - frameTime(createdAt));
}

/** True for the zones the preview treats as plain UTC. */
export const isUtcZone = (timeZone: string): boolean => timeZone === 'UTC' || timeZone === 'Etc/UTC';

export function cachedFormatter(
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

// Zone transitions fall on quarter-hour boundaries, so one offset holds for a whole quarter hour.
const QUARTER_HOUR_MS = 900_000;
const offsetCache = new Map<string, number>();

/** UTC offset in minutes (east positive, west negative) for `validMs` in `timeZone`. */
export function timeZoneOffsetMinutesAt(validMs: number, timeZone: string): number {
  if (!Number.isFinite(validMs) || isUtcZone(timeZone)) return 0;
  const quarter = Math.floor(validMs / QUARTER_HOUR_MS), key = `${timeZone}|${quarter}`;
  const cached = offsetCache.get(key);
  if (cached !== undefined) return cached;
  const formatter = cachedFormatter(offsetFormatters, timeZone, OFFSET_PARTS_OPTIONS);
  if (!formatter) return 0;
  const at = quarter * QUARTER_HOUR_MS, parts = formatter.formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? 0);
  const localAsUtcMs = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  const offset = Math.round((localAsUtcMs - at) / 60_000) || 0;
  if (offsetCache.size >= 4096) offsetCache.clear();
  offsetCache.set(key, offset);
  return offset;
}

/** Local calendar date `YYYY-MM-DD` of `utcMs` in IANA `timeZone`, with that instant's own UTC offset. */
export function zoneDateKey(utcMs: number, timeZone: string): string {
  return placeDateKey(utcMs, timeZoneOffsetMinutesAt(utcMs, timeZone));
}

/** `formatPlaceTime` in IANA `timeZone`, with that instant's own UTC offset (DST-correct). */
export function formatZoneTime(utcMs: number, timeZone: string, style: PlaceTimeStyle = 'stamp'): string {
  return formatPlaceTime(utcMs, timeZoneOffsetMinutesAt(utcMs, timeZone), style);
}
