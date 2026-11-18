import { formatPlaceTime, placeDateKey } from '@av/client';
import { solarFluxFactor, sunriseSunsetInRange } from '@av/solar';
import './compact-timeline.css';
import { PLAYBACK_STEP_MS, type TimelineFrame } from './timeline-model';

export type { TimelineFrame } from './timeline-model';
export interface CompactTimelineOptions {
  onSelect(index: number, history: 'push' | 'replace' | 'none'): void;
  onIntent?(index: number): void;
  onPrepare?(index: number): void;
  onPlayback?(playing: boolean): void;
  offsetMinutes?: number;
  latitude?: number;
  longitude?: number;
}
export interface CompactTimeline {
  update(frames: readonly TimelineFrame[], selectedFrame: string | null, disabled?: boolean): void;
  cancelGesture(): { changed: boolean; delivered: boolean } | null;
  setOffsetMinutes(offsetMinutes: number): void;
  setMapCenter(latitude: number, longitude: number): void;
  pause(): void;
  destroy(): void;
}
export interface RibbonStop { readonly at: number; readonly color: string }

interface LocalTime { day: string; hour: number; minute: number }
interface DayGroup { day: string; indices: number[] }

const PLAYBACK_INTERVAL_MS = PLAYBACK_STEP_MS;
const DAY_MS = 86_400_000;
const NIGHT = '#1c3358';
const PEAK = '#fff7d6';
const NEUTRAL = '#e7edf2';
const RADIANCE: readonly [number, string][] = [[0, NIGHT], [0.12, '#243f68'], [0.4, '#d7b15f'], [0.72, '#ffe3a0'], [1, PEAK]];
const FLUX_SAMPLES = 48;
const TICKS = ['00', '03', '06', '09', '12', '15', '18', '21', '24'] as const;
const DAY_MINUTES = 1440;
const MOON_PX = 28;
const WEEKDAY: Intl.DateTimeFormatOptions = { timeZone: 'UTC', weekday: 'short' };

export interface NightBounds { sunrise: number; sunset: number }
interface ScaleSegment { kind: 'morning' | 'day' | 'evening'; start: number; end: number; folded: boolean; x0: number; x1: number }
export interface DayScale { linear: boolean; width: number; segments: ScaleSegment[] }

function localTimeFromMs(ms: number, offsetMinutes: number): LocalTime | null {
  if (!Number.isFinite(ms) || !Number.isFinite(offsetMinutes)) return null;
  const shifted = new Date(ms + offsetMinutes * 60_000);
  const day = shifted.toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? { day, hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes() } : null;
}

export function nearestFrameIndexForDay(frames: readonly TimelineFrame[], indices: readonly number[], offsetMinutes: number, hour: number, minute: number): number {
  if (!indices.length) return -1;
  const target = hour * 60 + minute;
  let best = indices[0]!, bestDist = Infinity, bestMs = Infinity;
  for (const index of indices) {
    const frame = frames[index];
    if (!frame) continue;
    const ms = Date.parse(frame.validTime), local = localTimeFromMs(ms, offsetMinutes);
    if (!local) continue;
    const dist = Math.abs(local.hour * 60 + local.minute - target);
    if (dist < bestDist || (dist === bestDist && ms < bestMs)) { best = index; bestDist = dist; bestMs = ms; }
  }
  return best;
}

function localMinutes(frames: readonly TimelineFrame[], indices: readonly number[], offsetMinutes: number): number[] {
  const minutes: number[] = [];
  for (const index of indices) {
    const frame = frames[index];
    if (!frame) continue;
    const local = localTimeFromMs(Date.parse(frame.validTime), offsetMinutes);
    if (local) minutes.push(local.hour * 60 + local.minute);
  }
  minutes.sort((left, right) => left - right);
  return minutes;
}

export function frameIndexForDayFraction(frames: readonly TimelineFrame[], indices: readonly number[], offsetMinutes: number, fraction: number): number {
  if (!Number.isFinite(fraction)) return -1;
  const minute = Math.round(Math.min(1, Math.max(0, fraction)) * 1440);
  return nearestFrameIndexForDay(frames, indices, offsetMinutes, Math.floor(minute / 60), minute % 60);
}

export function dayHatchFractions(frames: readonly TimelineFrame[], indices: readonly number[], offsetMinutes: number): { start: number; end: number }[] {
  const minutes = localMinutes(frames, indices, offsetMinutes);
  if (!minutes.length) return [];
  const segments: { start: number; end: number }[] = [];
  const push = (from: number, to: number) => { if (to > from) segments.push({ start: from, end: to }); };
  push(0, minutes[0]! / 1440);
  push(minutes[minutes.length - 1]! / 1440, 1);
  return segments;
}

export function coarseSpanFractions(frames: readonly TimelineFrame[], indices: readonly number[], offsetMinutes: number): { start: number; end: number }[] {
  const minutes = localMinutes(frames, indices, offsetMinutes);
  const spans: { start: number; end: number }[] = [];
  for (let i = 1; i < minutes.length; i++) {
    const previous = minutes[i - 1]!, next = minutes[i]!;
    if (next - previous > 60) spans.push({ start: previous / 1440, end: next / 1440 });
  }
  return spans;
}

function monotonicStops(stops: readonly RibbonStop[]): readonly RibbonStop[] {
  const ordered: RibbonStop[] = [];
  for (const stop of stops) {
    const at = Math.min(100, Math.max(ordered.at(-1)?.at ?? 0, stop.at));
    const previous = ordered.at(-1);
    if (previous && at === previous.at) ordered[ordered.length - 1] = { at, color: stop.color };
    else ordered.push({ at, color: stop.color });
  }
  if (ordered[0]?.at !== 0) ordered.unshift({ at: 0, color: ordered[0]?.color ?? NIGHT });
  if (ordered.at(-1)?.at !== 100) ordered.push({ at: 100, color: ordered.at(-1)?.color ?? NIGHT });
  return ordered;
}

function hexChannel(hex: string, index: number): number {
  return Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
}

function mixHex(from: string, to: string, amount: number): string {
  const t = Math.min(1, Math.max(0, amount));
  let out = '#';
  for (let index = 0; index < 3; index++) out += Math.round(hexChannel(from, index) + (hexChannel(to, index) - hexChannel(from, index)) * t).toString(16).padStart(2, '0');
  return out;
}

function radianceColor(relative: number): string {
  const t = Math.pow(Math.min(1, Math.max(0, relative)), 1.35);
  const upper = RADIANCE.findIndex(stop => stop[0] >= t);
  if (upper <= 0) return RADIANCE[0]![1];
  const [fromAt, from] = RADIANCE[upper - 1]!;
  const [toAt, to] = RADIANCE[upper]!;
  return mixHex(from, to, (t - fromAt) / (toAt - fromAt));
}

function channelDistance(left: string, right: string): number {
  let delta = 0;
  for (let index = 0; index < 3; index++) delta += Math.abs(hexChannel(left, index) - hexChannel(right, index));
  return delta;
}

export function solarRibbonStops(latitude: number, longitude: number, startMs: number, endMs: number): readonly RibbonStop[] | null {
  if (![latitude, longitude, startMs, endMs].every(Number.isFinite) || !(endMs > startMs) || Math.abs(latitude) > 90) return null;
  const span = endMs - startMs;
  const fluxes = Array.from({ length: FLUX_SAMPLES + 1 }, (_, index) => {
    const flux = solarFluxFactor(latitude, longitude, startMs + span * index / FLUX_SAMPLES);
    return Number.isFinite(flux) ? Math.max(0, flux) : 0;
  });
  let peakIndex = 0;
  for (let index = 1; index < fluxes.length; index++) if (fluxes[index]! > fluxes[peakIndex]!) peakIndex = index;
  const peak = fluxes[peakIndex]!;
  const peakAt = peakIndex / FLUX_SAMPLES * 100;
  if (peak <= 0) return [{ at: 0, color: NIGHT }, { at: 100, color: NIGHT }];
  const samples = fluxes.map((flux, index) => ({ at: index / FLUX_SAMPLES * 100, color: radianceColor(flux / peak) }));
  const kept: RibbonStop[] = [];
  for (const stop of samples) {
    const previous = kept.at(-1);
    if (!previous || Math.abs(stop.at - peakAt) < 1e-6 || channelDistance(previous.color, stop.color) >= 20) kept.push(stop);
  }
  return monotonicStops(kept);
}

function ribbonGradient(stops: readonly RibbonStop[]): string {
  return `linear-gradient(90deg, ${stops.map(stop => `${stop.color} ${Math.round(stop.at * 100) / 100}%`).join(', ')})`;
}

/** Sunrise and sunset as minutes after local midnight. Polar days and nights stay linear. */
export function solarMinuteBounds(latitude: number, longitude: number, day: string, offsetMinutes: number): NightBounds | null {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || !day) return null;
  const start = Date.parse(`${day}T00:00:00Z`) - offsetMinutes * 60_000;
  const span = sunriseSunsetInRange(latitude, longitude, start, start + DAY_MS);
  if (!span) return null;
  const minute = (ms: number) => Math.min(DAY_MINUTES, Math.max(0, (ms - start) / 60_000));
  const sunrise = minute(span.sunrise);
  const sunset = minute(span.sunset);
  if (!(sunset > sunrise + 30) || sunrise < 1 && sunset > DAY_MINUTES - 1) return null;
  return { sunrise, sunset };
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

function scaleAtWidth(scale: DayScale, width: number): DayScale {
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

function localDayGroups(frames: readonly TimelineFrame[], offsetMinutes: number): DayGroup[] {
  const present = new Map<string, number[]>();
  frames.forEach((frame, index) => {
    const day = placeDateKey(Date.parse(frame.validTime), offsetMinutes);
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

function dayButtonLabel(day: string): string {
  const weekday = new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', WEEKDAY);
  return `${weekday} ${Number(day.slice(8))}`;
}

function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

export function createCompactTimeline(host: HTMLElement, options: CompactTimelineOptions): CompactTimeline {
  const doc = host.ownerDocument;
  let offsetMinutes = Number.isFinite(options.offsetMinutes) ? options.offsetMinutes! : 0;
  let latitude = Number.isFinite(options.latitude) ? options.latitude! : Number.NaN;
  let longitude = Number.isFinite(options.longitude) ? options.longitude! : Number.NaN;
  let hasCenter = Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const btn = (cls: string, label: string, text?: string) => {
    const button = el('button', cls, text);
    button.type = 'button';
    button.setAttribute('aria-label', label);
    return button;
  };

  const root = el('div', 'compact-timeline');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Forecast timeline');
  const daysRow = el('div', 'ct-days');
  daysRow.setAttribute('role', 'group');
  daysRow.setAttribute('aria-label', 'Forecast days');
  const controls = el('div', 'ct-controls');
  const play = btn('ct-play', 'Play forecast');
  const playGlyph = el('span', 'ct-play-glyph');
  play.setAttribute('aria-pressed', 'false');
  playGlyph.setAttribute('aria-hidden', 'true');
  play.append(playGlyph);
  const timeLabel = el('time', 'ct-time');
  const localLabel = el('span', 'ct-time-local', '--:--'), utcLabel = el('span', 'ct-time-utc');
  timeLabel.append(localLabel, utcLabel);
  const track = el('div', 'ct-track');
  track.setAttribute('role', 'slider');
  track.setAttribute('aria-orientation', 'horizontal');
  track.setAttribute('aria-label', 'Forecast time');
  track.setAttribute('aria-valuemin', '0');
  const ribbon = el('div', 'ct-ribbon');
  const hatches = el('div', 'ct-hatches');
  const marks = el('div', 'ct-marks');
  const moons = el('div', 'ct-moons');
  const playhead = el('div', 'ct-playhead');
  const ticks = el('div', 'ct-ticks');
  for (const node of [ribbon, hatches, marks, moons, playhead, ticks]) node.setAttribute('aria-hidden', 'true');
  playhead.setAttribute('hidden', '');
  track.tabIndex = -1;
  track.append(ribbon, hatches, marks, moons, ticks, playhead);
  controls.append(play, timeLabel, track);
  root.append(daysRow, controls);
  host.append(root);

  let frames: readonly TimelineFrame[] = [], days: DayGroup[] = [], dayButtons: HTMLButtonElement[] = [];
  let daySignature = '', selectedIndex = -1, sceneIndex = -1, disabled = false, timer: ReturnType<typeof setInterval> | null = null, destroyed = false;
  let activePointer: number | null = null, gestureStart = -1, paintedWidth = -1, gestureScale: DayScale | null = null, gestureOriginX = Number.NaN, gestureMoved = false, lastPointerX = Number.NaN;
  let sceneRequest: number | null = null, gestureVersion = 0, gestureChanged = false;
  let framesRevision = 0, decorationKey = '';
  const solarCache = new Map<string, { stops: readonly RibbonStop[] | null; bounds: NightBounds | null }>();

  const controlsDisabled = () => disabled || !frames.length;
  const selectedGroup = (): DayGroup | undefined => {
    const day = selectedIndex >= 0 ? placeDateKey(Date.parse(frames[selectedIndex]!.validTime), offsetMinutes) : '';
    return days.find(group => group.day === day && group.indices.length) ?? days.find(group => group.indices.length);
  };

  function daySolar(day: string): { stops: readonly RibbonStop[] | null; bounds: NightBounds | null } {
    if (!hasCenter || !day) return { stops: null, bounds: null };
    const key = `${latitude.toFixed(2)},${longitude.toFixed(2)},${day},${offsetMinutes}`;
    const cached = solarCache.get(key);
    if (cached) return cached;
    const start = Date.parse(`${day}T00:00:00Z`) - offsetMinutes * 60_000;
    const solar = { stops: solarRibbonStops(latitude, longitude, start, start + DAY_MS), bounds: solarMinuteBounds(latitude, longitude, day, offsetMinutes) };
    solarCache.set(key, solar);
    if (solarCache.size > 24) solarCache.delete(solarCache.keys().next().value!);
    return solar;
  }

  function trackWidth(): number {
    const width = track.getBoundingClientRect().width;
    return width > 0 ? width : 320;
  }

  function liveScale(width: number): DayScale {
    const group = selectedGroup();
    const frame = selectedIndex >= 0 ? frames[selectedIndex] : undefined;
    const local = frame ? localTimeFromMs(Date.parse(frame.validTime), offsetMinutes) : null;
    const bounds = group ? daySolar(group.day).bounds : null;
    return buildDayScale(width, bounds, local ? local.hour * 60 + local.minute : null);
  }

  function currentScale(width: number): DayScale {
    if (!gestureScale) return liveScale(width);
    gestureScale = scaleAtWidth(gestureScale, width);
    return gestureScale;
  }

  function placeMinute(scale: DayScale, minute: number): number {
    return scale.width > 0 ? minuteToX(scale, minute) / scale.width : minute / DAY_MINUTES;
  }

  function paintRange(className: string, scale: DayScale, start: number, end: number): HTMLElement {
    const node = el('div', className);
    const left = placeMinute(scale, start * DAY_MINUTES);
    node.style.left = percent(left);
    node.style.width = percent(Math.max(0, placeMinute(scale, end * DAY_MINUTES) - left));
    return node;
  }

  function paintHatches(scale: DayScale, segments: readonly { start: number; end: number }[]): void {
    hatches.replaceChildren(...segments.map(segment => paintRange('ct-hatch', scale, segment.start, segment.end)));
  }

  function paintCoarse(scale: DayScale, spans: readonly { start: number; end: number }[]): void {
    const bars = new Set<number>();
    for (const span of spans) { bars.add(span.start); bars.add(span.end); }
    marks.replaceChildren(
      ...spans.map(span => paintRange('ct-coarse', scale, span.start, span.end)),
      ...[...bars].map(at => {
        const bar = el('div', 'ct-coarse-bar');
        bar.style.left = percent(placeMinute(scale, at * DAY_MINUTES));
        return bar;
      })
    );
  }

  function paintTicks(scale: DayScale): void {
    const day = scale.segments.find(segment => segment.kind === 'day' && !segment.folded);
    const visible = TICKS.filter(label => {
      if (scale.linear || !day) return true;
      const minute = Number(label) * 60;
      return minute >= day.start && minute <= day.end;
    });
    const minGap = scale.linear ? 0 : 18;
    const kept: string[] = [];
    for (const label of visible) {
      const minute = Number(label) * 60;
      const previous = kept.at(-1);
      if (minGap > 0 && previous !== undefined && minuteToX(scale, minute) - minuteToX(scale, Number(previous) * 60) < minGap) continue;
      kept.push(label);
    }
    ticks.classList.toggle('is-folded', !scale.linear);
    ticks.replaceChildren(...kept.map(label => {
      const minute = Number(label) * 60;
      const tick = el('span', `ct-tick${minute === 0 ? ' is-start' : minute === DAY_MINUTES ? ' is-end' : ''}`, label);
      tick.style.left = percent(placeMinute(scale, minute === DAY_MINUTES ? DAY_MINUTES - 0.001 : minute));
      return tick;
    }));
  }

  function paintMoons(scale: DayScale): void {
    moons.replaceChildren(...scale.segments.filter(segment => segment.folded).map(segment => {
      const moon = el('div', 'ct-moon');
      moon.style.left = percent(segment.x0 / scale.width);
      moon.style.width = percent((segment.x1 - segment.x0) / scale.width);
      const icon = el('span', 'ct-moon-icon');
      icon.innerHTML = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="#f6f1e4" d="M9.6 1.6a6.2 6.2 0 1 0 4.6 10.6A6.8 6.8 0 1 1 9.6 1.6z"/></svg>';
      moon.append(icon);
      return moon;
    }));
  }

  function reveal(button: HTMLButtonElement): void {
    if (daysRow.clientWidth <= 0 || button.offsetWidth <= 0) return;
    const right = button.offsetLeft + button.offsetWidth;
    if (button.offsetLeft < daysRow.scrollLeft) daysRow.scrollLeft = button.offsetLeft;
    else if (right > daysRow.scrollLeft + daysRow.clientWidth) daysRow.scrollLeft = right - daysRow.clientWidth;
  }

  function rebuildDays(): void {
    const focusedDay = dayButtons.includes(doc.activeElement as HTMLButtonElement) ? (doc.activeElement as HTMLButtonElement).dataset.day : undefined;
    dayButtons = days.map(group => {
      const label = dayButtonLabel(group.day);
      const button = btn('ct-day', group.indices.length ? label : `${label}, unavailable`, label);
      button.dataset.day = group.day;
      const targetForDay = (): number => {
        const current = selectedIndex >= 0 ? frames[selectedIndex] : undefined;
        const local = current ? localTimeFromMs(Date.parse(current.validTime), offsetMinutes) : null;
        return nearestFrameIndexForDay(frames, group.indices, offsetMinutes, local?.hour ?? 12, local?.minute ?? 0);
      };
      const prepareDay = () => {
        if (button.disabled || controlsDisabled() || !group.indices.length || !options.onPrepare) return;
        const idx = targetForDay();
        if (idx >= 0) options.onPrepare(idx);
      };
      button.addEventListener('pointerenter', prepareDay);
      button.addEventListener('focus', prepareDay);
      button.addEventListener('pointerdown', prepareDay);
      button.addEventListener('click', () => {
        if (button.disabled || controlsDisabled() || !group.indices.length) return;
        if (timer !== null) stopPlayback();
        select(targetForDay(), 'push', false);
      });
      return button;
    });
    daysRow.replaceChildren(...dayButtons);
    if (focusedDay) dayButtons.find(button => button.dataset.day === focusedDay)?.focus({ preventScroll: true });
  }

  function syncDays(): void {
    const next = localDayGroups(frames, offsetMinutes);
    const signature = next.map(group => `${group.day}:${group.indices.join('.')}`).join('|');
    if (signature === daySignature) return;
    days = next;
    daySignature = signature;
    rebuildDays();
  }

  function render(width = trackWidth()): void {
    const scale = currentScale(width);
    const selectedDay = selectedIndex >= 0 ? placeDateKey(Date.parse(frames[selectedIndex]!.validTime), offsetMinutes) : '';
    const off = controlsDisabled();
    dayButtons.forEach((button, index) => {
      const group = days[index];
      const available = Boolean(group?.indices.length);
      const selected = Boolean(group && group.day === selectedDay && available);
      button.classList.toggle('is-selected', selected);
      button.classList.toggle('is-unavailable', !available);
      button.setAttribute('aria-pressed', String(selected));
      button.disabled = off || !available;
    });
    const frame = selectedIndex >= 0 ? frames[selectedIndex] : undefined;
    const ms = frame ? Date.parse(frame.validTime) : Number.NaN;
    const local = frame && Number.isFinite(ms) ? localTimeFromMs(ms, offsetMinutes) : null;
    if (!frame || !Number.isFinite(ms)) {
      localLabel.textContent = '--:--'; utcLabel.textContent = '';
      timeLabel.removeAttribute('dateTime');
      track.setAttribute('aria-valuetext', 'No forecast time');
      playhead.setAttribute('hidden', '');
    } else {
      const clock = formatPlaceTime(ms, offsetMinutes, 'clock');
      const split = clock.indexOf(' (');
      localLabel.textContent = split < 0 ? clock : clock.slice(0, split);
      utcLabel.textContent = split < 0 ? '' : clock.slice(split);
      timeLabel.setAttribute('dateTime', frame.validTime);
      track.setAttribute('aria-valuetext', formatPlaceTime(ms, offsetMinutes, 'stamp'));
      if (local) {
        playhead.removeAttribute('hidden');
        playhead.style.left = percent(placeMinute(scale, local.hour * 60 + local.minute));
      } else playhead.setAttribute('hidden', '');
    }
    const group = selectedGroup();
    const latKey = hasCenter ? latitude.toFixed(2) : '';
    const lonKey = hasCenter ? longitude.toFixed(2) : '';
    const key = [framesRevision, group?.day, offsetMinutes, latKey, lonKey, Math.round(width),
      ...scale.segments.flatMap(segment => [segment.kind, segment.start, segment.end, segment.folded, Math.round(segment.x0 * 10), Math.round(segment.x1 * 10)])].join('|');
    if (key !== decorationKey) {
      decorationKey = key;
      const solar = group ? daySolar(group.day) : { stops: null, bounds: null };
      const warped = solar.stops ? solar.stops.map(stop => ({ color: stop.color, at: placeMinute(scale, stop.at / 100 * DAY_MINUTES) * 100 })) : null;
      ribbon.style.background = warped ? ribbonGradient(monotonicStops(warped)) : NEUTRAL;
      paintHatches(scale, group ? dayHatchFractions(frames, group.indices, offsetMinutes) : []);
      paintCoarse(scale, group ? coarseSpanFractions(frames, group.indices, offsetMinutes) : []);
      paintTicks(scale);
      paintMoons(scale);
    }
    paintedWidth = width;
    track.tabIndex = off ? -1 : 0;
    track.setAttribute('aria-disabled', String(off));
    track.setAttribute('aria-valuemax', String(Math.max(0, frames.length - 1)));
    track.setAttribute('aria-valuenow', String(Math.max(0, selectedIndex)));
    const playing = timer !== null;
    play.disabled = off;
    play.classList.toggle('is-playing', playing);
    play.setAttribute('aria-pressed', String(playing));
    play.setAttribute('aria-label', playing ? 'Pause forecast playback' : 'Play forecast');
    const selectedButton = dayButtons.find(button => button.classList.contains('is-selected'));
    if (selectedButton) reveal(selectedButton);
  }

  function cancelSceneRequest(): void {
    if (sceneRequest !== null) doc.defaultView?.cancelAnimationFrame(sceneRequest);
    sceneRequest = null;
  }

  function invalidateGesture(): void {
    gestureVersion++;
    cancelSceneRequest();
    activePointer = null;
    gestureStart = -1;
    gestureScale = null;
    gestureMoved = false;
    gestureChanged = false;
    gestureOriginX = Number.NaN;
    lastPointerX = Number.NaN;
  }

  function deliverScene(index: number, history: 'push' | 'replace' | 'none'): void {
    sceneIndex = index;
    options.onSelect(index, history);
  }

  function queueScene(): void {
    if (sceneRequest !== null) return;
    const view = doc.defaultView;
    if (!view || typeof view.requestAnimationFrame !== 'function' || typeof view.cancelAnimationFrame !== 'function') {
      if (selectedIndex !== sceneIndex) deliverScene(selectedIndex, 'none');
      return;
    }
    sceneRequest = view.requestAnimationFrame(() => {
      sceneRequest = null;
      if (!destroyed && activePointer !== null && selectedIndex !== sceneIndex) deliverScene(selectedIndex, 'none');
    });
  }

  function select(index: number, history: 'push' | 'replace' | 'none', moveFocus: boolean): void {
    if (destroyed || controlsDisabled() || index < 0 || index >= frames.length) return;
    const changed = activePointer !== null || index !== selectedIndex || index !== sceneIndex;
    invalidateGesture();
    selectedIndex = index;
    render();
    if (changed) deliverScene(index, history);
    if (moveFocus && !destroyed) track.focus({ preventScroll: true });
  }

  function seek(clientX: number, queue = true): void {
    const group = selectedGroup();
    if (!group || controlsDisabled()) return;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return;
    const minute = xToMinute(currentScale(rect.width), Math.min(rect.width, Math.max(0, clientX - rect.left)));
    const rounded = Math.min(DAY_MINUTES, Math.max(0, Math.round(minute)));
    const index = nearestFrameIndexForDay(frames, group.indices, offsetMinutes, Math.floor(rounded / 60), rounded % 60);
    if (index >= 0 && index !== selectedIndex) {
      const version = gestureVersion;
      selectedIndex = index;
      gestureChanged = true;
      render(rect.width);
      options.onIntent?.(index);
      if (destroyed || controlsDisabled() || activePointer === null || version !== gestureVersion) return;
      if (queue) queueScene();
    }
  }

  const stopPlayback = () => {
    const wasPlaying = timer !== null;
    if (timer !== null) { clearInterval(timer); timer = null; }
    if (wasPlaying) options.onPlayback?.(false);
    if (!destroyed) render();
  };

  play.addEventListener('click', () => {
    if (activePointer !== null) {
      if (selectedIndex >= 0) select(selectedIndex, 'replace', false);
      else invalidateGesture();
    }
    if (destroyed || controlsDisabled()) return;
    if (timer !== null) { stopPlayback(); return; }
    if (frames.length <= 1) { if (selectedIndex < 0) select(0, 'replace', false); if (!destroyed) render(); return; }
    if (selectedIndex < 0 || selectedIndex >= frames.length - 1) select(0, 'replace', false);
    if (destroyed || controlsDisabled()) return;
    timer = setInterval(() => {
      if (destroyed || selectedIndex >= frames.length - 1) { stopPlayback(); return; }
      select(selectedIndex + 1, 'replace', false);
      if (selectedIndex >= frames.length - 1) stopPlayback();
    }, PLAYBACK_INTERVAL_MS);
    options.onPlayback?.(true);
    if (!destroyed) render();
  });

  track.addEventListener('pointerdown', event => {
    const pointer = event as PointerEvent;
    if (destroyed || activePointer !== null || (pointer.button !== undefined && pointer.button !== 0) || controlsDisabled()) return;
    if (timer !== null) stopPlayback();
    if (destroyed || controlsDisabled() || activePointer !== null || timer !== null) return;
    gestureScale = null;
    gestureMoved = false;
    gestureOriginX = pointer.clientX;
    lastPointerX = pointer.clientX;
    gestureStart = selectedIndex;
    activePointer = pointer.pointerId ?? 1;
    const version = ++gestureVersion;
    if (typeof track.setPointerCapture === 'function' && pointer.pointerId !== undefined) track.setPointerCapture(pointer.pointerId);
    seek(pointer.clientX);
    if (destroyed || controlsDisabled() || activePointer === null || version !== gestureVersion) return;
    const width = track.getBoundingClientRect().width;
    if (width > 0) gestureScale = liveScale(width);
    if (!destroyed) render();
  });
  const movePointer = (event: Event) => {
    const pointer = event as PointerEvent;
    if (activePointer === null || (pointer.pointerId ?? 1) !== activePointer) return;
    if (!gestureMoved && Math.abs(pointer.clientX - gestureOriginX) < 1) return;
    gestureMoved = true;
    lastPointerX = pointer.clientX;
    seek(pointer.clientX);
  };
  const releasePointer = (event: Event) => {
    const pointer = event as PointerEvent;
    if (activePointer === null || (pointer.pointerId ?? 1) !== activePointer) return;
    const version = gestureVersion;
    if (event.type === 'pointerup' && pointer.clientX !== lastPointerX && (gestureMoved || Math.abs(pointer.clientX - gestureOriginX) >= 1)) seek(pointer.clientX, false);
    if (destroyed || controlsDisabled() || activePointer === null || version !== gestureVersion) return;
    const start = gestureStart;
    const changed = gestureChanged;
    invalidateGesture();
    const completedVersion = gestureVersion;
    if (changed && selectedIndex >= 0) deliverScene(selectedIndex, selectedIndex !== start ? 'push' : 'replace');
    if (destroyed || controlsDisabled() || completedVersion !== gestureVersion) return;
    render();
  };
  track.addEventListener('pointermove', movePointer);
  track.addEventListener('pointerup', releasePointer);
  track.addEventListener('pointercancel', releasePointer);
  const stepFromKey = (event: Event) => {
    const key = (event as KeyboardEvent).key;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key)) return;
    event.preventDefault();
    if (controlsDisabled()) return;
    if (timer !== null) stopPlayback();
    const current = selectedIndex < 0 ? 0 : selectedIndex;
    const index = key === 'Home' ? 0
      : key === 'End' ? frames.length - 1
        : key === 'ArrowLeft' || key === 'ArrowUp' ? Math.max(0, current - 1)
          : Math.min(frames.length - 1, selectedIndex < 0 ? 0 : current + 1);
    select(index, 'replace', true);
  };
  track.addEventListener('keydown', stepFromKey);
  root.addEventListener('keydown', event => { if (event.target !== track) stepFromKey(event); });

  const onVisibility = () => { if (doc.visibilityState === 'hidden') stopPlayback(); };
  doc.addEventListener('visibilitychange', onVisibility);
  doc.defaultView?.addEventListener('pagehide', stopPlayback);
  const resizeObserver = typeof ResizeObserver === 'function' && daysRow.nodeType === 1 ? new ResizeObserver(() => {
    if (destroyed) return;
    const selected = dayButtons.find(button => button.classList.contains('is-selected'));
    if (selected) reveal(selected);
    if (Math.abs(trackWidth() - paintedWidth) >= 0.5) render();
  }) : null;
  resizeObserver?.observe(daysRow);
  resizeObserver?.observe(track);

  return {
    cancelGesture() {
      if (destroyed || activePointer === null) return null;
      const state = { changed: gestureChanged, delivered: sceneIndex !== gestureStart };
      invalidateGesture();
      selectedIndex = sceneIndex;
      render();
      return state;
    },
    update(nextFrames, selectedFrame, nextDisabled = false) {
      if (destroyed) return;
      const nextIndex = nextFrames.findIndex(frame => frame.id === selectedFrame);
      const sameFrames = nextFrames.length === frames.length && nextFrames.every((frame, index) => frame.id === frames[index]?.id && frame.validTime === frames[index]?.validTime);
      if (paintedWidth >= 0 && sameFrames && nextDisabled === disabled && nextIndex === sceneIndex && (activePointer !== null || nextIndex === selectedIndex)) return;
      const echo = activePointer !== null && sameFrames && nextDisabled === disabled && nextIndex === sceneIndex;
      if (!echo && (activePointer !== null || !sameFrames || nextDisabled !== disabled || nextIndex !== sceneIndex)) invalidateGesture();
      if (!sameFrames) { frames = nextFrames.slice(); framesRevision++; }
      if (!echo) selectedIndex = nextIndex;
      sceneIndex = nextIndex;
      disabled = nextDisabled;
      if (!sameFrames) syncDays();
      render();
      if (controlsDisabled()) stopPlayback();
    },
    setOffsetMinutes(next: number) {
      if (destroyed || !Number.isFinite(next) || next === offsetMinutes) return;
      gestureScale = null;
      offsetMinutes = next;
      solarCache.clear();
      syncDays();
      render();
    },
    pause() {
      if (!destroyed && timer !== null) stopPlayback();
    },
    setMapCenter(nextLatitude: number, nextLongitude: number) {
      if (destroyed || !Number.isFinite(nextLatitude) || !Number.isFinite(nextLongitude) || Math.abs(nextLatitude) > 90) return;
      if (hasCenter && nextLatitude.toFixed(2) === latitude.toFixed(2) && nextLongitude.toFixed(2) === longitude.toFixed(2)) return;
      gestureScale = null;
      latitude = nextLatitude;
      longitude = nextLongitude;
      hasCenter = true;
      render();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      invalidateGesture();
      stopPlayback();
      resizeObserver?.disconnect();
      doc.removeEventListener('visibilitychange', onVisibility);
      doc.defaultView?.removeEventListener('pagehide', stopPlayback);
      solarCache.clear();
      root.remove();
    }
  };
}
