import { formatPlaceTime, placeDateKey } from '@av/client';
import { solarPosition, sunriseSunsetInRange } from '@av/solar';
import './compact-timeline.css';

export interface TimelineFrame { readonly id: string; readonly validTime: string }
export interface CompactTimelineOptions {
  onSelect(index: number, history: 'push' | 'replace' | 'none'): void;
  offsetMinutes?: number;
  latitude?: number;
  longitude?: number;
}
export interface CompactTimeline {
  update(frames: readonly TimelineFrame[], selectedFrame: string | null, disabled?: boolean): void;
  setOffsetMinutes(offsetMinutes: number): void;
  setMapCenter(latitude: number, longitude: number): void;
  pause(): void;
  destroy(): void;
}
export interface RibbonStop { readonly at: number; readonly color: string }

interface LocalTime { day: string; hour: number; minute: number }
interface DayGroup { day: string; indices: number[] }

const PLAYBACK_INTERVAL_MS = 700;
const DAY_MS = 86_400_000;
const NIGHT = '#1c3358';
const DAWN = '#e8893a';
const DAYLIGHT = '#f6e27a';
const DUSK = '#d4652f';
const NEUTRAL = '#e7edf2';
const SHOULDER_PERCENT = 45 / 14.4;
const TICKS = ['00', '03', '06', '09', '12', '15', '18', '21', '24'] as const;
const WEEKDAY: Intl.DateTimeFormatOptions = { timeZone: 'UTC', weekday: 'short' };

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

export function frameIndexForDayFraction(frames: readonly TimelineFrame[], indices: readonly number[], offsetMinutes: number, fraction: number): number {
  if (!Number.isFinite(fraction)) return -1;
  const minute = Math.round(Math.min(1, Math.max(0, fraction)) * 1440);
  return nearestFrameIndexForDay(frames, indices, offsetMinutes, Math.floor(minute / 60), minute % 60);
}

export function dayCoverageFractions(frames: readonly TimelineFrame[], indices: readonly number[], offsetMinutes: number): { start: number; end: number } | null {
  let start = Infinity, end = -Infinity;
  for (const index of indices) {
    const frame = frames[index];
    if (!frame) continue;
    const local = localTimeFromMs(Date.parse(frame.validTime), offsetMinutes);
    if (!local) continue;
    const minute = local.hour * 60 + local.minute;
    if (minute < start) start = minute;
    if (minute > end) end = minute;
  }
  return Number.isFinite(start) && end >= start ? { start: start / 1440, end: end / 1440 } : null;
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

export function solarRibbonStops(latitude: number, longitude: number, startMs: number, endMs: number): readonly RibbonStop[] | null {
  if (![latitude, longitude, startMs, endMs].every(Number.isFinite) || !(endMs > startMs) || Math.abs(latitude) > 90) return null;
  const span = sunriseSunsetInRange(latitude, longitude, startMs, endMs);
  if (!span) {
    const noon = solarPosition(latitude, longitude, startMs + (endMs - startMs) / 2);
    if (!Number.isFinite(noon.elevationDeg)) return null;
    const color = noon.isDaylight ? DAYLIGHT : NIGHT;
    return [{ at: 0, color }, { at: 100, color }];
  }
  const percent = (ms: number) => Math.min(100, Math.max(0, (ms - startMs) / (endMs - startMs) * 100));
  const sunrise = percent(span.sunrise);
  const sunset = percent(span.sunset);
  const noon = (sunrise + sunset) / 2;
  const shoulder = Math.min(SHOULDER_PERCENT, Math.max(0, sunset - sunrise) / 4);
  return monotonicStops([
    { at: 0, color: NIGHT },
    { at: sunrise - shoulder, color: NIGHT },
    { at: sunrise, color: DAWN },
    { at: Math.min(noon, sunrise + shoulder * 2), color: DAYLIGHT },
    { at: noon, color: DAYLIGHT },
    { at: Math.max(noon, sunset - shoulder * 2), color: DAYLIGHT },
    { at: sunset, color: DUSK },
    { at: sunset + shoulder, color: NIGHT },
    { at: 100, color: NIGHT }
  ]);
}

function ribbonGradient(stops: readonly RibbonStop[]): string {
  return `linear-gradient(90deg, ${stops.map(stop => `${stop.color} ${Math.round(stop.at * 100) / 100}%`).join(', ')})`;
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
  const timeLabel = el('time', 'ct-time', '--:--');
  const track = el('div', 'ct-track');
  track.setAttribute('role', 'slider');
  track.setAttribute('aria-orientation', 'horizontal');
  track.setAttribute('aria-label', 'Forecast time');
  track.setAttribute('aria-valuemin', '0');
  const ribbon = el('div', 'ct-ribbon');
  const hatchStart = el('div', 'ct-hatch');
  const hatchEnd = el('div', 'ct-hatch');
  const playhead = el('div', 'ct-playhead');
  const ticks = el('div', 'ct-ticks');
  for (const node of [ribbon, hatchStart, hatchEnd, playhead, ticks]) node.setAttribute('aria-hidden', 'true');
  playhead.setAttribute('hidden', '');
  hatchStart.setAttribute('hidden', '');
  hatchEnd.setAttribute('hidden', '');
  track.tabIndex = -1;
  ticks.append(...TICKS.map(label => el('span', 'ct-tick', label)));
  track.append(ribbon, hatchStart, hatchEnd, ticks, playhead);
  controls.append(play, timeLabel, track);
  root.append(daysRow, controls);
  host.append(root);

  let frames: readonly TimelineFrame[] = [], days: DayGroup[] = [], dayButtons: HTMLButtonElement[] = [];
  let daySignature = '', selectedIndex = -1, disabled = false, timer: ReturnType<typeof setInterval> | null = null, destroyed = false;
  let activePointer: number | null = null, gestureStart = -1;
  const ribbonCache = new Map<string, string>();

  const controlsDisabled = () => disabled || !frames.length;
  const selectedGroup = (): DayGroup | undefined => {
    const day = selectedIndex >= 0 ? placeDateKey(Date.parse(frames[selectedIndex]!.validTime), offsetMinutes) : '';
    return days.find(group => group.day === day && group.indices.length) ?? days.find(group => group.indices.length);
  };

  function ribbonCss(day: string): string {
    if (!hasCenter || !day) return NEUTRAL;
    const key = `${latitude.toFixed(2)},${longitude.toFixed(2)},${day},${offsetMinutes}`;
    const cached = ribbonCache.get(key);
    if (cached) return cached;
    const start = Date.parse(`${day}T00:00:00Z`) - offsetMinutes * 60_000;
    const stops = solarRibbonStops(latitude, longitude, start, start + DAY_MS);
    const css = stops ? ribbonGradient(stops) : NEUTRAL;
    ribbonCache.set(key, css);
    if (ribbonCache.size > 24) ribbonCache.delete(ribbonCache.keys().next().value!);
    return css;
  }

  function placeHatch(hatch: HTMLElement, from: number, to: number): void {
    const width = Math.max(0, to - from);
    if (width < 0.004) {
      hatch.setAttribute('hidden', '');
      return;
    }
    hatch.removeAttribute('hidden');
    hatch.style.left = percent(from);
    hatch.style.width = percent(width);
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
      button.addEventListener('click', () => {
        if (button.disabled || controlsDisabled() || !group.indices.length) return;
        if (timer !== null) stopPlayback();
        const current = selectedIndex >= 0 ? frames[selectedIndex] : undefined;
        const local = current ? localTimeFromMs(Date.parse(current.validTime), offsetMinutes) : null;
        select(nearestFrameIndexForDay(frames, group.indices, offsetMinutes, local?.hour ?? 12, local?.minute ?? 0), 'push', false);
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

  function render(): void {
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
      timeLabel.textContent = '--:--';
      timeLabel.removeAttribute('dateTime');
      track.setAttribute('aria-valuetext', 'No forecast time');
      playhead.setAttribute('hidden', '');
    } else {
      timeLabel.textContent = formatPlaceTime(ms, offsetMinutes, 'clock');
      timeLabel.setAttribute('dateTime', frame.validTime);
      track.setAttribute('aria-valuetext', formatPlaceTime(ms, offsetMinutes, 'stamp'));
      if (local) {
        playhead.removeAttribute('hidden');
        playhead.style.left = percent((local.hour * 60 + local.minute) / 1440);
      } else playhead.setAttribute('hidden', '');
    }
    const group = selectedGroup();
    const coverage = group ? dayCoverageFractions(frames, group.indices, offsetMinutes) : null;
    ribbon.style.background = group ? ribbonCss(group.day) : NEUTRAL;
    placeHatch(hatchStart, 0, coverage?.start ?? 0);
    placeHatch(hatchEnd, coverage?.end ?? 1, 1);
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

  function select(index: number, history: 'push' | 'replace' | 'none', moveFocus: boolean): void {
    if (destroyed || controlsDisabled() || index < 0 || index >= frames.length) return;
    if (index !== selectedIndex) {
      selectedIndex = index;
      render();
      options.onSelect(index, history);
    }
    if (moveFocus) track.focus({ preventScroll: true });
  }

  function seek(clientX: number): void {
    const group = selectedGroup();
    if (!group || controlsDisabled()) return;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return;
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const index = frameIndexForDayFraction(frames, group.indices, offsetMinutes, fraction);
    if (index >= 0) select(index, 'none', false);
  }

  const stopPlayback = () => {
    if (timer !== null) { clearInterval(timer); timer = null; }
    if (!destroyed) render();
  };

  play.addEventListener('click', () => {
    if (timer !== null) { stopPlayback(); return; }
    if (controlsDisabled()) return;
    if (frames.length <= 1) { if (selectedIndex < 0) select(0, 'replace', false); render(); return; }
    if (selectedIndex < 0 || selectedIndex >= frames.length - 1) select(0, 'replace', false);
    timer = setInterval(() => {
      if (destroyed || selectedIndex >= frames.length - 1) { stopPlayback(); return; }
      select(selectedIndex + 1, 'replace', false);
      if (selectedIndex >= frames.length - 1) stopPlayback();
    }, PLAYBACK_INTERVAL_MS);
    render();
  });

  track.addEventListener('pointerdown', event => {
    const pointer = event as PointerEvent;
    if ((pointer.button !== undefined && pointer.button !== 0) || controlsDisabled()) return;
    if (timer !== null) stopPlayback();
    gestureStart = selectedIndex;
    activePointer = pointer.pointerId ?? 1;
    if (typeof track.setPointerCapture === 'function' && pointer.pointerId !== undefined) track.setPointerCapture(pointer.pointerId);
    seek(pointer.clientX);
  });
  const movePointer = (event: Event) => {
    const pointer = event as PointerEvent;
    if (activePointer === null || (pointer.pointerId ?? 1) !== activePointer) return;
    seek(pointer.clientX);
  };
  const releasePointer = (event: Event) => {
    const pointer = event as PointerEvent;
    if (activePointer === null || (pointer.pointerId ?? 1) !== activePointer) return;
    activePointer = null;
    if (!destroyed && !controlsDisabled() && gestureStart >= 0 && selectedIndex >= 0 && selectedIndex !== gestureStart) options.onSelect(selectedIndex, 'push');
    gestureStart = -1;
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
  }) : null;
  resizeObserver?.observe(daysRow);

  return {
    update(nextFrames, selectedFrame, nextDisabled = false) {
      if (destroyed) return;
      frames = nextFrames.slice();
      selectedIndex = frames.findIndex(frame => frame.id === selectedFrame);
      disabled = nextDisabled;
      syncDays();
      render();
      if (controlsDisabled()) stopPlayback();
    },
    setOffsetMinutes(next: number) {
      if (destroyed || !Number.isFinite(next) || next === offsetMinutes) return;
      offsetMinutes = next;
      ribbonCache.clear();
      syncDays();
      render();
    },
    pause() {
      if (!destroyed && timer !== null) stopPlayback();
    },
    setMapCenter(nextLatitude: number, nextLongitude: number) {
      if (destroyed || !Number.isFinite(nextLatitude) || !Number.isFinite(nextLongitude) || Math.abs(nextLatitude) > 90) return;
      if (hasCenter && nextLatitude.toFixed(2) === latitude.toFixed(2) && nextLongitude.toFixed(2) === longitude.toFixed(2)) return;
      latitude = nextLatitude;
      longitude = nextLongitude;
      hasCenter = true;
      render();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (timer !== null) { clearInterval(timer); timer = null; }
      activePointer = null;
      gestureStart = -1;
      resizeObserver?.disconnect();
      doc.removeEventListener('visibilitychange', onVisibility);
      doc.defaultView?.removeEventListener('pagehide', stopPlayback);
      ribbonCache.clear();
      root.remove();
    }
  };
}
