import { formatZoneTime } from '@av/client';
import { dockViewOption, type DockViewId } from '../controls/bottom-dock-model';
import { coarseSpanFractions, DAY_MINUTES, dayHatchFractions, localTimeFromMs, minuteToX, type DayGroup, type DayScale } from './day-scale';
import { monotonicStops, ribbonGradient } from './solar-day';
import type { FrameWindow } from './timeline-frame-window';
import './compact-timeline.css';

/** DOM for the compact timeline: builds the day row, track and controls, and paints a frame window onto them. */
interface TimelineView {
  readonly root: HTMLElement;
  readonly track: HTMLElement;
  readonly play: HTMLButtonElement;
  readonly stepPrev: HTMLButtonElement;
  readonly stepNext: HTMLButtonElement;
  render(paint: ViewPaint): void;
  rebuildDays(): void;
  trackWidth(): number;
  /** True once `render` has run. */
  painted(): boolean;
  setPull(px: number, armed: boolean): void;
  isPulled(): boolean;
  setBounce(direction: -1 | 1, parity: boolean): void;
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
  edgePull: -1 | 0 | 1;
  playing: boolean;
}

interface DayHandlers {
  prepareDay(group: DayGroup): void;
  pickDay(group: DayGroup): void;
  /** Track or day row changed width since the last paint. */
  resized(): void;
}

const NEUTRAL = '#e7edf2';
const TICKS = ['00', '03', '06', '09', '12', '15', '18', '21', '24'] as const;
const SNAP_GHOST_MIN_PX = 3.5;
const LOUPE_HALF_PX = 44;
const WEEKDAY: Intl.DateTimeFormatOptions = { timeZone: 'UTC', weekday: 'short' };
const MOON_SVG = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="#f6f1e4" d="M9.6 1.6a6.2 6.2 0 1 0 4.6 10.6A6.8 6.8 0 1 1 9.6 1.6z"/></svg>';

function dayButtonLabel(day: string): string {
  const weekday = new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', WEEKDAY);
  return `${weekday} ${Number(day.slice(8))}`;
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

  const steppers = el('div', 'ct-steppers');
  steppers.setAttribute('role', 'group');
  steppers.setAttribute('aria-label', 'Step forecast hour');
  const stepPrev = btn('ct-step ct-step-prev', 'Previous forecast time', '‹');
  const stepNext = btn('ct-step ct-step-next', 'Next forecast time', '›');
  steppers.append(stepPrev, stepNext);
  if (!dockViewOption(variant).showSteppers) steppers.setAttribute('hidden', '');

  controls.append(play, timeLabel, track, steppers);
  root.append(daysRow, controls);
  host.append(root);

  let dayButtons: HTMLButtonElement[] = [];
  let highlightedDays = new Set<string>(), highlightedKey = '';
  let paintedWidth = -1, decorationKey = '', destroyed = false;

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

  function paintLoupe(headFraction: number, width: number, baseText: string, edgePull: -1 | 0 | 1): void {
    const minFrac = width > LOUPE_HALF_PX * 2 ? LOUPE_HALF_PX / width : 0.5;
    const clampedLoupe = Math.min(1 - minFrac, Math.max(minFrac, headFraction));
    const neighbor = edgePull !== 0 ? win.adjacentGroup(edgePull) : undefined;
    loupeText.textContent = neighbor
      ? edgePull > 0
        ? `${baseText} → ${dayButtonLabel(neighbor.day)}`
        : `${dayButtonLabel(neighbor.day)} ← ${baseText}`
      : baseText;
    loupe.style.left = percent(clampedLoupe);
    loupe.removeAttribute('hidden');
  }

  function paintTime({ scale, width, scrubMinute, edgePull }: ViewPaint): void {
    const frame = win.selectedIndex >= 0 ? win.frames[win.selectedIndex] : undefined;
    const ms = frame ? Date.parse(frame.validTime) : Number.NaN;
    if (!frame || !Number.isFinite(ms)) {
      localLabel.textContent = '--:--'; utcLabel.textContent = '';
      timeLabel.removeAttribute('dateTime');
      track.setAttribute('aria-valuetext', 'No forecast time');
      hideMarkers();
      return;
    }
    const local = localTimeFromMs(ms, win.timeZone);
    const clock = formatZoneTime(ms, win.timeZone, 'clock');
    const split = clock.indexOf(' (');
    const localClock = split < 0 ? clock : clock.slice(0, split);
    localLabel.textContent = localClock;
    utcLabel.textContent = split < 0 ? '' : clock.slice(split);
    timeLabel.setAttribute('dateTime', frame.validTime);
    track.setAttribute('aria-valuetext', formatZoneTime(ms, win.timeZone, 'stamp'));
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
    if (scrubMinute !== null && dockViewOption(variant).showLoupe) paintLoupe(headFraction, width, `${dayButtonLabel(local.day)} · ${localClock}`, edgePull);
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

  function reveal(button: HTMLButtonElement): void {
    if (daysRow.clientWidth <= 0 || button.offsetWidth <= 0) return;
    const right = button.offsetLeft + button.offsetWidth;
    if (button.offsetLeft < daysRow.scrollLeft) daysRow.scrollLeft = button.offsetLeft;
    else if (right > daysRow.scrollLeft + daysRow.clientWidth) daysRow.scrollLeft = right - daysRow.clientWidth;
  }

  function revealSelected(): void {
    const selected = dayButtons.find(button => button.classList.contains('is-selected'));
    if (selected) reveal(selected);
  }

  function render(paint: ViewPaint): void {
    const { scale, width, playing } = paint;
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
    play.disabled = off;
    play.classList.toggle('is-playing', playing);
    play.setAttribute('aria-pressed', String(playing));
    play.setAttribute('aria-label', playing ? 'Pause forecast playback' : 'Play forecast');
    stepPrev.disabled = off || win.selectedIndex <= 0;
    stepNext.disabled = off || win.selectedIndex < 0 || win.selectedIndex >= win.frames.length - 1;
    revealSelected();
  }

  function rebuildDays(): void {
    const focusedDay = dayButtons.includes(doc.activeElement as HTMLButtonElement) ? (doc.activeElement as HTMLButtonElement).dataset.day : undefined;
    dayButtons = win.days.map(group => {
      const label = dayButtonLabel(group.day);
      const button = btn('ct-day', group.indices.length ? label : `${label}, unavailable`, label);
      button.dataset.day = group.day;
      const usable = () => !button.disabled && !win.off() && group.indices.length > 0;
      const prepareDay = () => { if (usable()) handlers.prepareDay(group); };
      button.addEventListener('pointerenter', prepareDay);
      button.addEventListener('focus', prepareDay);
      button.addEventListener('pointerdown', prepareDay);
      button.addEventListener('click', () => { if (usable()) handlers.pickDay(group); });
      return button;
    });
    daysRow.replaceChildren(...dayButtons);
    if (focusedDay) dayButtons.find(button => button.dataset.day === focusedDay)?.focus({ preventScroll: true });
  }

  const resizeObserver = typeof ResizeObserver === 'function' && daysRow.nodeType === 1 ? new ResizeObserver(() => {
    if (destroyed) return;
    revealSelected();
    if (Math.abs(trackWidth() - paintedWidth) >= 0.5) handlers.resized();
  }) : null;
  resizeObserver?.observe(daysRow);
  resizeObserver?.observe(track);

  return {
    root, track, play, stepPrev, stepNext, render, rebuildDays, trackWidth,
    painted: () => paintedWidth >= 0,
    setPull(px, armed) {
      const transform = px ? `translateX(${px}px)` : '';
      track.style.transform = transform;
      root.classList.toggle('is-track-pulled', Boolean(transform));
      root.classList.toggle('is-edge-armed', armed);
    },
    isPulled: () => Boolean(track.style.transform),
    setBounce(direction, parity) {
      root.dataset.bounce = direction > 0 ? (parity ? 'next-a' : 'next-b') : (parity ? 'prev-a' : 'prev-b');
    },
    setVariant(next) {
      if (next === variant) return false;
      variant = next;
      root.dataset.variant = next;
      if (dockViewOption(next).showSteppers) steppers.removeAttribute('hidden');
      else steppers.setAttribute('hidden', '');
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
