import { formatZoneTime } from '@av/client';
import { dockViewOption, type DockViewId } from '../controls/bottom-dock-model';
import { coarseSpanFractions, DAY_MINUTES, dayHatchFractions, localTimeFromMs, minuteToX, type DayGroup, type DayScale } from './day-scale';
import { monotonicStops, ribbonGradient } from './solar-day';
import type { FrameWindow } from './timeline-frame-window';
import type { DayTarget } from './timeline-gesture';
import type { PreviewDraw } from '../raster/raster-overview';
import './compact-timeline.css';

/**
 * DOM for the timeline: a date/time readout, the intraday hour rail and one button per local day, in that
 * order (also the focus order). The dock's CSS grid places the three; this module paints a frame window onto them.
 */
interface TimelineView {
  readonly root: HTMLElement;
  readonly track: HTMLElement;
  readonly daysRow: HTMLElement;
  render(paint: ViewPaint): void;
  rebuildDays(): void;
  trackWidth(): number;
  /** True once `render` has run. */
  painted(): boolean;
  /** Available day buttons' horizontal spans, or null while they wrap onto more than one row. */
  dayTargets(): DayTarget[] | null;
  /** Visible note that the map still shows another hour; empty clears it. */
  setShowing(text: string): void;
  /** Each day button's preview canvas. */
  cards(): { group: DayGroup; canvas: HTMLCanvasElement }[];
  /** Shows the preview state on a day button: an image, a neutral placeholder, or a plain date. */
  setThumb(day: string, state: PreviewDraw): void;
  readonly loupeCanvas: HTMLCanvasElement;
  readonly dayLoupe: HTMLElement;
  /** Opens the enlarged day preview titled for frame `index`, or closes it with null. */
  setDayLoupe(index: number | null): void;
  focusDay(day: string): void;
  setVariant(next: DockViewId): boolean;
  setReadiness(ready: number, total: number, loading: boolean): void;
  setHighlightedDays(days: readonly string[] | null): void;
  destroy(): void;
}

interface ViewPaint {
  scale: DayScale;
  width: number;
  /** Unsnapped playhead minute while a pointer scrubs; null otherwise. */
  scrubMinute: number | null;
  /** Clock time day picks aim for; the readout notes it when the selected frame differs. */
  comparisonMinute: number | null;
}

interface DayHandlers {
  prepareDay(group: DayGroup): void;
  pickDay(group: DayGroup): void;
  /** A pointer rests on, or keyboard focus reaches, a day (null when it leaves). */
  hoverDay(group: DayGroup | null): void;
  dayKey(event: KeyboardEvent, group: DayGroup): void;
  /** Track or day row changed width since the last paint. */
  resized(): void;
}

const NEUTRAL = '#e7edf2';
const TICKS = ['00', '03', '06', '09', '12', '15', '18', '21', '24'] as const;
const SNAP_GHOST_MIN_PX = 3.5;
const LOUPE_HALF_PX = 44;
const WEEKDAY: Intl.DateTimeFormatOptions = { timeZone: 'UTC', weekday: 'short' };
const LONG_DAY: Intl.DateTimeFormatOptions = { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' };
const MOON_SVG = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="#f6f1e4" d="M9.6 1.6a6.2 6.2 0 1 0 4.6 10.6A6.8 6.8 0 1 1 9.6 1.6z"/></svg>';

function dayButtonLabel(day: string): string {
  const weekday = new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', WEEKDAY);
  return `${weekday} ${Number(day.slice(8))}`;
}

/** `Thu 26 Nov` for a local day key, read as a calendar date. */
function readoutDate(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', LONG_DAY).replace(',', '');
}

function clockLabel(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function placeMinute(scale: DayScale, minute: number): number {
  return scale.width > 0 ? minuteToX(scale, minute) / scale.width : minute / DAY_MINUTES;
}

export function createTimelineView(host: HTMLElement, win: FrameWindow, initialVariant: DockViewId, handlers: DayHandlers): TimelineView {
  const doc = host.ownerDocument;
  let variant = initialVariant;

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
  root.dataset.variant = variant;
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Forecast timeline');
  const daysRow = el('div', 'ct-days');
  daysRow.setAttribute('role', 'group');
  daysRow.setAttribute('aria-label', 'Forecast days');
  const readout = el('div', 'ct-readout');
  const dateLabel = el('span', 'ct-date');
  const timeLabel = el('time', 'ct-time');
  const localLabel = el('span', 'ct-time-local', '--:--'), utcLabel = el('span', 'ct-time-utc');
  timeLabel.append(localLabel, utcLabel);
  const note = el('span', 'ct-note');
  note.setAttribute('hidden', '');
  readout.append(dateLabel, timeLabel, note);
  const track = el('div', 'ct-track');
  track.setAttribute('role', 'slider');
  track.setAttribute('aria-orientation', 'horizontal');
  track.setAttribute('aria-label', 'Forecast time');
  track.setAttribute('aria-valuemin', '0');
  const ribbon = el('div', 'ct-ribbon');
  const hatches = el('div', 'ct-hatches');
  const marks = el('div', 'ct-marks');
  const moons = el('div', 'ct-moons');
  const snapGhost = el('div', 'ct-snap-ghost');
  const playhead = el('div', 'ct-playhead');
  const ticks = el('div', 'ct-ticks');
  const loupe = el('div', 'ct-loupe');
  const loupeText = el('span', 'ct-loupe-text');
  loupe.append(loupeText);
  const progress = el('div', 'ct-progress');
  const progressBar = el('div', 'ct-progress-bar');
  progress.append(progressBar);
  for (const node of [ribbon, hatches, marks, moons, snapGhost, playhead, ticks, loupe, progress]) node.setAttribute('aria-hidden', 'true');
  snapGhost.setAttribute('hidden', '');
  playhead.setAttribute('hidden', '');
  loupe.setAttribute('hidden', '');
  progress.setAttribute('hidden', '');
  track.tabIndex = -1;
  track.append(ribbon, hatches, marks, moons, ticks, snapGhost, playhead, progress, loupe);

  const dayLoupe = el('div', 'ct-day-loupe');
  const dayLoupeTitle = el('span', 'ct-day-loupe-title');
  const loupeCanvas = el('canvas', 'ct-day-loupe-canvas');
  dayLoupe.append(loupeCanvas, dayLoupeTitle);
  dayLoupe.setAttribute('aria-hidden', 'true');
  dayLoupe.setAttribute('hidden', '');
  root.append(readout, track, daysRow, dayLoupe);
  host.append(root);

  let dayButtons: HTMLButtonElement[] = [];
  const canvases = new WeakMap<HTMLButtonElement, HTMLCanvasElement>();
  let highlightedDays = new Set<string>(), highlightedKey = '';
  let paintedWidth = -1, decorationKey = '', destroyed = false, showing = '';
  let lastNote: { local: { hour: number; minute: number } | null; comparisonMinute: number | null } = { local: null, comparisonMinute: null };

  function trackWidth(): number {
    const width = track.getBoundingClientRect().width;
    return width > 0 ? width : 320;
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
      icon.innerHTML = MOON_SVG;
      moon.append(icon);
      return moon;
    }));
  }

  function paintDecorations(scale: DayScale, width: number): void {
    const group = win.selectedGroup();
    const key = [win.revision, group?.day, win.timeZone, win.centerKey(), Math.round(width),
      ...scale.segments.flatMap(segment => [segment.kind, segment.start, segment.end, segment.folded, Math.round(segment.x0 * 10), Math.round(segment.x1 * 10)])].join('|');
    if (key === decorationKey) return;
    decorationKey = key;
    const solar = group ? win.daySolar(group.day) : { stops: null, bounds: null };
    const warped = solar.stops ? solar.stops.map(stop => ({ color: stop.color, at: placeMinute(scale, stop.at / 100 * DAY_MINUTES) * 100 })) : null;
    ribbon.style.background = warped ? ribbonGradient(monotonicStops(warped)) : NEUTRAL;
    paintHatches(scale, group ? dayHatchFractions(win.frames, group.indices, win.timeZone) : []);
    paintCoarse(scale, group ? coarseSpanFractions(win.frames, group.indices, win.timeZone) : []);
    paintTicks(scale);
    paintMoons(scale);
  }

  function hideMarkers(): void {
    playhead.setAttribute('hidden', '');
    snapGhost.setAttribute('hidden', '');
    loupe.setAttribute('hidden', '');
  }

  function paintLoupe(headFraction: number, width: number, text: string): void {
    const minFrac = width > LOUPE_HALF_PX * 2 ? LOUPE_HALF_PX / width : 0.5;
    loupeText.textContent = text;
    loupe.style.left = percent(Math.min(1 - minFrac, Math.max(minFrac, headFraction)));
    loupe.removeAttribute('hidden');
  }

  /** The readout note: what the map still shows while loading, else the comparison time a day pick snapped from. */
  function paintNote(local: { hour: number; minute: number } | null, comparisonMinute: number | null): void {
    lastNote = { local, comparisonMinute };
    const snapped = comparisonMinute !== null && !!local && local.hour * 60 + local.minute !== comparisonMinute;
    const text = showing || (snapped ? `Nearest to ${clockLabel(comparisonMinute)}` : '');
    note.textContent = text;
    note.classList.toggle('is-showing', Boolean(showing));
    if (text) note.removeAttribute('hidden'); else note.setAttribute('hidden', '');
  }

  function paintTime({ scale, width, scrubMinute, comparisonMinute }: ViewPaint): void {
    const frame = win.selectedIndex >= 0 ? win.frames[win.selectedIndex] : undefined;
    const ms = frame ? Date.parse(frame.validTime) : Number.NaN;
    if (!frame || !Number.isFinite(ms)) {
      localLabel.textContent = '--:--'; utcLabel.textContent = ''; dateLabel.textContent = '';
      timeLabel.removeAttribute('dateTime');
      track.setAttribute('aria-valuetext', 'No forecast time');
      paintNote(null, null);
      hideMarkers();
      return;
    }
    const local = localTimeFromMs(ms, win.timeZone);
    const clock = formatZoneTime(ms, win.timeZone, 'clock');
    const split = clock.indexOf(' (');
    const localClock = split < 0 ? clock : clock.slice(0, split);
    localLabel.textContent = localClock;
    dateLabel.textContent = local ? readoutDate(local.day) : '';
    utcLabel.textContent = split < 0 ? '' : clock.slice(split);
    timeLabel.setAttribute('dateTime', frame.validTime);
    track.setAttribute('aria-valuetext', formatZoneTime(ms, win.timeZone, 'stamp'));
    paintNote(local, comparisonMinute);
    if (!local) { hideMarkers(); return; }
    const frameFraction = placeMinute(scale, local.hour * 60 + local.minute);
    const headFraction = scrubMinute !== null ? placeMinute(scale, scrubMinute) : frameFraction;
    playhead.removeAttribute('hidden');
    playhead.style.left = percent(headFraction);
    if (scrubMinute !== null && Math.abs(headFraction - frameFraction) * width >= SNAP_GHOST_MIN_PX) {
      snapGhost.removeAttribute('hidden');
      snapGhost.style.left = percent(frameFraction);
    } else {
      snapGhost.setAttribute('hidden', '');
    }
    if (scrubMinute !== null && dockViewOption(variant).showLoupe) paintLoupe(headFraction, width, `${dayButtonLabel(local.day)} · ${localClock}`);
    else loupe.setAttribute('hidden', '');
  }

  function paintDayButtons(off: boolean): void {
    const selectedDay = win.selectedDay();
    dayButtons.forEach((button, index) => {
      const group = win.days[index];
      const available = Boolean(group?.indices.length);
      const selected = Boolean(group && group.day === selectedDay && available);
      const inWindow = Boolean(group && available && highlightedDays.has(group.day));
      button.classList.toggle('is-selected', selected);
      button.classList.toggle('is-in-window', inWindow);
      button.classList.toggle('is-unavailable', !available);
      button.setAttribute('aria-pressed', String(selected));
      button.disabled = off || !available;
    });
  }

  function render(paint: ViewPaint): void {
    const { scale, width } = paint;
    root.classList.toggle('is-scrubbing', paint.scrubMinute !== null);
    const off = win.off();
    paintDayButtons(off);
    paintTime(paint);
    paintDecorations(scale, width);
    paintedWidth = width;
    track.tabIndex = off ? -1 : 0;
    track.setAttribute('aria-disabled', String(off));
    track.setAttribute('aria-valuemax', String(Math.max(0, win.frames.length - 1)));
    track.setAttribute('aria-valuenow', String(Math.max(0, win.selectedIndex)));
  }

  function rebuildDays(): void {
    const focusedDay = dayButtons.includes(doc.activeElement as HTMLButtonElement) ? (doc.activeElement as HTMLButtonElement).dataset.day : undefined;
    dayButtons = win.days.map(group => {
      const label = dayButtonLabel(group.day);
      const button = btn('ct-day', group.indices.length ? label : `${label}, unavailable`);
      const thumb = el('span', 'ct-day-thumb');
      thumb.setAttribute('aria-hidden', 'true');
      const canvas = el('canvas', 'ct-day-canvas');
      canvases.set(button, canvas);
      thumb.append(canvas);
      button.append(thumb, el('span', 'ct-day-label', label));
      button.dataset.day = group.day;
      const usable = () => !button.disabled && !win.off() && group.indices.length > 0;
      const prepareDay = () => { if (usable()) handlers.prepareDay(group); };
      const hover = (event: Event) => { prepareDay(); if (usable() && (event as PointerEvent).pointerType !== 'touch') handlers.hoverDay(group); };
      button.addEventListener('pointerenter', hover);
      // Keyboard focus opens the enlarged preview; focus that follows a tap or click does not.
      button.addEventListener('focus', () => { prepareDay(); if (usable() && focusVisible(button)) handlers.hoverDay(group); });
      button.addEventListener('pointerleave', () => handlers.hoverDay(null));
      button.addEventListener('blur', () => handlers.hoverDay(null));
      button.addEventListener('pointerdown', prepareDay);
      button.addEventListener('click', () => { if (usable()) handlers.pickDay(group); });
      button.addEventListener('keydown', event => { if (usable()) handlers.dayKey(event as KeyboardEvent, group); });
      return button;
    });
    daysRow.replaceChildren(...dayButtons);
    // One day needs no picker: the readout already names it.
    if (dayButtons.length > 1) daysRow.removeAttribute('hidden'); else daysRow.setAttribute('hidden', '');
    if (focusedDay) dayButtons.find(button => button.dataset.day === focusedDay)?.focus({ preventScroll: true });
  }

  const resizeObserver = typeof ResizeObserver === 'function' && track.nodeType === 1 ? new ResizeObserver(() => {
    if (destroyed) return;
    if (Math.abs(trackWidth() - paintedWidth) >= 0.5) handlers.resized();
  }) : null;
  resizeObserver?.observe(track);

  return {
    root, track, daysRow, render, rebuildDays, trackWidth,
    painted: () => paintedWidth >= 0,
    dayTargets() {
      const spans = dayButtons.flatMap((button, index) => {
        const group = win.days[index], rect = button.getBoundingClientRect();
        return group?.indices.length && !button.disabled && rect.width > 0 ? [{ left: rect.left, right: rect.left + rect.width, top: rect.top ?? 0, group }] : [];
      });
      if (!spans.length || spans.some(span => span.top !== spans[0]!.top)) return null;
      return spans.map(({ left, right, group }) => ({ left, right, group }));
    },
    loupeCanvas, dayLoupe,
    cards() {
      return dayButtons.flatMap((button, index) => {
        const group = win.days[index], canvas = canvases.get(button);
        return group && canvas ? [{ group, canvas }] : [];
      });
    },
    setThumb(day, state) {
      const button = dayButtons.find(candidate => candidate.dataset.day === day);
      if (!button) return;
      button.classList.toggle('has-thumb', state !== 'unavailable');
      button.classList.toggle('is-pending', state === 'pending');
    },
    setDayLoupe(index) {
      const frame = index === null ? undefined : win.frames[index];
      const ms = frame ? Date.parse(frame.validTime) : Number.NaN, local = localTimeFromMs(ms, win.timeZone);
      if (!local) { dayLoupe.setAttribute('hidden', ''); return; }
      dayLoupeTitle.textContent = `${readoutDate(local.day)} · ${clockLabel(local.hour * 60 + local.minute)}`;
      dayLoupe.removeAttribute('hidden');
    },
    setShowing(text) {
      if (text === showing) return;
      showing = text;
      paintNote(lastNote.local, lastNote.comparisonMinute);
    },
    focusDay(day) {
      dayButtons.find(button => button.dataset.day === day)?.focus({ preventScroll: true });
    },
    setVariant(next) {
      if (next === variant) return false;
      variant = next;
      root.dataset.variant = next;
      return true;
    },
    setReadiness(ready, total, loading) {
      if (!(total > 0) || (ready >= total && !loading)) {
        progress.setAttribute('hidden', '');
        progress.classList.toggle('is-loading', false);
        return;
      }
      const ratio = ready >= total ? 1 : Math.min(1, Math.max(0.06, ready / total));
      progressBar.style.transform = `scaleX(${Math.round(ratio * 1000) / 1000})`;
      progress.classList.toggle('is-loading', Boolean(loading && ready >= total));
      progress.removeAttribute('hidden');
    },
    setHighlightedDays(nextDays) {
      const nextKey = nextDays?.length ? nextDays.join(',') : '';
      if (nextKey === highlightedKey) return;
      highlightedKey = nextKey;
      highlightedDays = new Set(nextDays ?? []);
      dayButtons.forEach((button, index) => {
        const group = win.days[index];
        const available = Boolean(group?.indices.length);
        button.classList.toggle('is-in-window', Boolean(group && available && highlightedDays.has(group.day)));
      });
    },
    destroy() {
      destroyed = true;
      resizeObserver?.disconnect();
      root.remove();
    }
  };
}

function focusVisible(element: HTMLElement): boolean {
  try { return typeof element.matches !== 'function' || element.matches(':focus-visible'); } catch { return true; }
}
