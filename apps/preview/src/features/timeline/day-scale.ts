import { timeZoneOffsetMinutesAt, zoneDateKey } from '@av/client';
import type { TimelineFrame } from './timeline-model';

/** Local-day geometry for the timeline track: frame lookup by local clock time and the folded-night x scale. */
interface LocalTime { day: string; hour: number; minute: number }
export interface DayGroup { day: string; indices: number[] }
export interface NightBounds { sunrise: number; sunset: number }
interface ScaleSegment { kind: 'morning' | 'day' | 'evening'; start: number; end: number; folded: boolean; x0: number; x1: number }
export interface DayScale { linear: boolean; width: number; segments: ScaleSegment[] }

export const DAY_MS = 86_400_000;
export const DAY_MINUTES = 1440;
const MOON_PX = 28;

/** Civil date and clock of `ms` in IANA `timeZone`, using that instant's own offset. */
export function localTimeFromMs(ms: number, timeZone: string): LocalTime | null {
  if (!Number.isFinite(ms)) return null;
  const shifted = new Date(ms + timeZoneOffsetMinutesAt(ms, timeZone) * 60_000);
  const day = shifted.toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? { day, hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes() } : null;
}

export function nearestFrameIndexForDay(frames: readonly TimelineFrame[], indices: readonly number[], timeZone: string, hour: number, minute: number): number {
  if (!indices.length) return -1;
  const target = hour * 60 + minute;
  let best = indices[0]!, bestDist = Infinity, bestMs = Infinity;
  for (const index of indices) {
    const frame = frames[index];
    if (!frame) continue;
    const ms = Date.parse(frame.validTime), local = localTimeFromMs(ms, timeZone);
    if (!local) continue;
    const dist = Math.abs(local.hour * 60 + local.minute - target);
    if (dist < bestDist || (dist === bestDist && ms < bestMs)) { best = index; bestDist = dist; bestMs = ms; }
  }
  return best;
}

function localMinutes(frames: readonly TimelineFrame[], indices: readonly number[], timeZone: string): number[] {
  const minutes: number[] = [];
  for (const index of indices) {
    const frame = frames[index];
    if (!frame) continue;
    const local = localTimeFromMs(Date.parse(frame.validTime), timeZone);
    if (local) minutes.push(local.hour * 60 + local.minute);
  }
  minutes.sort((left, right) => left - right);
  return minutes;
}

export function frameIndexForDayFraction(frames: readonly TimelineFrame[], indices: readonly number[], timeZone: string, fraction: number): number {
  if (!Number.isFinite(fraction)) return -1;
  const minute = Math.round(Math.min(1, Math.max(0, fraction)) * 1440);
  return nearestFrameIndexForDay(frames, indices, timeZone, Math.floor(minute / 60), minute % 60);
}

export function dayHatchFractions(frames: readonly TimelineFrame[], indices: readonly number[], timeZone: string): { start: number; end: number }[] {
  const minutes = localMinutes(frames, indices, timeZone);
  if (!minutes.length) return [];
  const segments: { start: number; end: number }[] = [];
  const push = (from: number, to: number) => { if (to > from) segments.push({ start: from, end: to }); };
  push(0, minutes[0]! / 1440);
  push(minutes[minutes.length - 1]! / 1440, 1);
  return segments;
}

export function coarseSpanFractions(frames: readonly TimelineFrame[], indices: readonly number[], timeZone: string): { start: number; end: number }[] {
  const minutes = localMinutes(frames, indices, timeZone);
  const spans: { start: number; end: number }[] = [];
  for (let i = 1; i < minutes.length; i++) {
    const previous = minutes[i - 1]!, next = minutes[i]!;
    if (next - previous > 60) spans.push({ start: previous / 1440, end: next / 1440 });
  }
  return spans;
}

function linearScale(width: number): DayScale {
  return { linear: true, width, segments: [{ kind: 'day', start: 0, end: DAY_MINUTES, folded: false, x0: 0, x1: width }] };
}

/** Fold each night that does not contain the selected minute into a fixed moon. */
export function buildDayScale(width: number, bounds: NightBounds | null, selectedMinute: number | null): DayScale {
  if (!bounds) return linearScale(width);
  const sunrise = bounds.sunrise < 1 ? 0 : bounds.sunrise;
  const sunset = bounds.sunset > DAY_MINUTES - 1 ? DAY_MINUTES : bounds.sunset;
  const candidates: ScaleSegment[] = [
    { kind: 'morning', start: 0, end: sunrise, folded: false, x0: 0, x1: 0 },
    { kind: 'day', start: sunrise, end: sunset, folded: false, x0: 0, x1: 0 },
    { kind: 'evening', start: sunset, end: DAY_MINUTES, folded: false, x0: 0, x1: 0 },
  ];
  const parts = candidates.filter(part => part.end - part.start >= 1);
  for (const part of parts) {
    const selected = selectedMinute !== null && selectedMinute >= part.start && selectedMinute < part.end;
    part.folded = part.kind !== 'day' && !selected;
  }
  return layoutSegments(parts, width);
}

function layoutSegments(parts: ScaleSegment[], width: number): DayScale {
  const folded = parts.filter(part => part.folded).length;
  const openMinutes = parts.filter(part => !part.folded).reduce((sum, part) => sum + part.end - part.start, 0);
  if (openMinutes <= 0 || width < folded * MOON_PX + 80) return linearScale(width);
  const openWidth = width - folded * MOON_PX;
  let x = 0;
  for (const part of parts) {
    const span = part.folded ? MOON_PX : openWidth * (part.end - part.start) / openMinutes;
    part.x0 = x;
    part.x1 = x + span;
    x += span;
  }
  const last = parts.at(-1);
  if (last) last.x1 = width;
  return { linear: false, width, segments: parts };
}

/** Re-lay a gesture's frozen scale at a new track width, keeping its folds. */
export function scaleAtWidth(scale: DayScale, width: number): DayScale {
  if (!(width > 0) || Math.abs(scale.width - width) < 0.5) return scale;
  if (scale.linear) return linearScale(width);
  return layoutSegments(scale.segments.map(part => ({ ...part })), width);
}

export function minuteToX(scale: DayScale, minute: number): number {
  const clamped = Math.min(DAY_MINUTES, Math.max(0, minute));
  const segment = scale.segments.find(part => clamped < part.end) ?? scale.segments.at(-1);
  if (!segment || segment.end <= segment.start) return 0;
  const fraction = Math.min(1, Math.max(0, (clamped - segment.start) / (segment.end - segment.start)));
  return segment.x0 + fraction * (segment.x1 - segment.x0);
}

export function xToMinute(scale: DayScale, x: number): number {
  const clamped = Math.min(scale.width, Math.max(0, x));
  const segment = scale.segments.find(part => clamped < part.x1) ?? scale.segments.at(-1);
  if (!segment || segment.x1 <= segment.x0) return 0;
  const fraction = Math.min(1, Math.max(0, (clamped - segment.x0) / (segment.x1 - segment.x0)));
  return segment.start + fraction * (segment.end - segment.start);
}

/** Every local day from the first to the last frame, including empty gap days. */
export function localDayGroups(frames: readonly TimelineFrame[], timeZone: string): DayGroup[] {
  const present = new Map<string, number[]>();
  frames.forEach((frame, index) => {
    const day = zoneDateKey(Date.parse(frame.validTime), timeZone);
    if (!day) return;
    const indices = present.get(day);
    if (indices) indices.push(index);
    else present.set(day, [index]);
  });
  const keys = [...present.keys()].sort();
  const first = keys[0], last = keys.at(-1);
  if (!first || !last) return [];
  const start = Date.parse(`${first}T00:00:00Z`), end = Date.parse(`${last}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const groups: DayGroup[] = [];
  for (let time = start; time <= end; time += DAY_MS) groups.push({ day: new Date(time).toISOString().slice(0, 10), indices: present.get(new Date(time).toISOString().slice(0, 10)) ?? [] });
  return groups;
}
