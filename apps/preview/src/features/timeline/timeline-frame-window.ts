import { placeDateKey } from '@av/client';
import { buildDayScale, DAY_MS, localDayGroups, localTimeFromMs, type DayGroup, type DayScale, type NightBounds } from './day-scale';
import { solarMinuteBounds, solarRibbonStops } from './solar-day';
import type { TimelineFrame } from './timeline-model';

/**
 * The frames the timeline offers, grouped into local days, with the selected frame, the frame last
 * delivered to the scene, and the map centre that colours each day.
 */
export interface FrameWindow {
  readonly frames: readonly TimelineFrame[];
  readonly days: readonly DayGroup[];
  /** Bumped whenever `frames` is replaced. */
  readonly revision: number;
  readonly offsetMinutes: number;
  /** Frame the track shows; leads `sceneIndex` during a gesture. */
  selectedIndex: number;
  /** Frame last delivered through `onSelect` or confirmed by `update`. */
  sceneIndex: number;
  disabled: boolean;
  /** True when the controls cannot act: disabled or no frames. */
  off(): boolean;
  selectedDay(): string;
  selectedGroup(): DayGroup | undefined;
  adjacentGroup(direction: -1 | 1): DayGroup | undefined;
  selectedMinute(): number | null;
  /** True when `next` has the same ids and valid times as `frames`. */
  sameFrames(next: readonly TimelineFrame[]): boolean;
  setFrames(next: readonly TimelineFrame[]): void;
  /** Regroups days; returns whether the grouping changed. */
  syncDays(): boolean;
  setOffsetMinutes(next: number): boolean;
  setCenter(latitude: number, longitude: number): boolean;
  /** Rounded centre used in paint cache keys. */
  centerKey(): string;
  daySolar(day: string): DaySolar;
  liveScale(width: number): DayScale;
  clearSolar(): void;
}

interface DaySolar { stops: ReturnType<typeof solarRibbonStops>; bounds: NightBounds | null }

interface FrameWindowOptions { offsetMinutes?: number | undefined; latitude?: number | undefined; longitude?: number | undefined }

const SOLAR_CACHE_DAYS = 24;

export function createFrameWindow(options: FrameWindowOptions): FrameWindow {
  let frames: readonly TimelineFrame[] = [], days: DayGroup[] = [], daySignature = '', revision = 0;
  let offsetMinutes = Number.isFinite(options.offsetMinutes) ? options.offsetMinutes! : 0;
  let latitude = Number.isFinite(options.latitude) ? options.latitude! : Number.NaN;
  let longitude = Number.isFinite(options.longitude) ? options.longitude! : Number.NaN;
  let hasCenter = Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90;
  const solarCache = new Map<string, DaySolar>();

  const win: FrameWindow = {
    get frames() { return frames; },
    get days() { return days; },
    get revision() { return revision; },
    get offsetMinutes() { return offsetMinutes; },
    selectedIndex: -1,
    sceneIndex: -1,
    disabled: false,
    off: () => win.disabled || !frames.length,
    selectedDay: () => win.selectedIndex >= 0 ? placeDateKey(Date.parse(frames[win.selectedIndex]!.validTime), offsetMinutes) : '',
    selectedGroup() {
      const day = win.selectedDay();
      return days.find(group => group.day === day && group.indices.length) ?? days.find(group => group.indices.length);
    },
    adjacentGroup(direction) {
      const current = win.selectedGroup();
      if (!current) return undefined;
      const start = days.indexOf(current);
      if (start < 0) return undefined;
      for (let idx = start + direction; idx >= 0 && idx < days.length; idx += direction) {
        const candidate = days[idx];
        if (candidate?.indices.length) return candidate;
      }
      return undefined;
    },
    selectedMinute() {
      const frame = win.selectedIndex >= 0 ? frames[win.selectedIndex] : undefined;
      const local = frame ? localTimeFromMs(Date.parse(frame.validTime), offsetMinutes) : null;
      return local ? local.hour * 60 + local.minute : null;
    },
    sameFrames: next => next.length === frames.length && next.every((frame, index) => frame.id === frames[index]?.id && frame.validTime === frames[index]?.validTime),
    setFrames(next) {
      frames = next.slice();
      revision++;
    },
    syncDays() {
      const next = localDayGroups(frames, offsetMinutes);
      const signature = next.map(group => `${group.day}:${group.indices.join('.')}`).join('|');
      if (signature === daySignature) return false;
      days = next;
      daySignature = signature;
      return true;
    },
    setOffsetMinutes(next) {
      if (!Number.isFinite(next) || next === offsetMinutes) return false;
      offsetMinutes = next;
      solarCache.clear();
      return true;
    },
    setCenter(nextLatitude, nextLongitude) {
      if (!Number.isFinite(nextLatitude) || !Number.isFinite(nextLongitude) || Math.abs(nextLatitude) > 90) return false;
      if (hasCenter && nextLatitude.toFixed(2) === latitude.toFixed(2) && nextLongitude.toFixed(2) === longitude.toFixed(2)) return false;
      latitude = nextLatitude;
      longitude = nextLongitude;
      hasCenter = true;
      return true;
    },
    centerKey: () => hasCenter ? `${latitude.toFixed(2)}|${longitude.toFixed(2)}` : '|',
    daySolar(day) {
      if (!hasCenter || !day) return { stops: null, bounds: null };
      const key = `${latitude.toFixed(2)},${longitude.toFixed(2)},${day},${offsetMinutes}`;
      const cached = solarCache.get(key);
      if (cached) return cached;
      const start = Date.parse(`${day}T00:00:00Z`) - offsetMinutes * 60_000;
      const solar = { stops: solarRibbonStops(latitude, longitude, start, start + DAY_MS), bounds: solarMinuteBounds(latitude, longitude, day, offsetMinutes) };
      solarCache.set(key, solar);
      if (solarCache.size > SOLAR_CACHE_DAYS) solarCache.delete(solarCache.keys().next().value!);
      return solar;
    },
    liveScale(width) {
      const group = win.selectedGroup();
      const bounds = group ? win.daySolar(group.day).bounds : null;
      return buildDayScale(width, bounds, win.selectedMinute());
    },
    clearSolar: () => solarCache.clear()
  };
  return win;
}
