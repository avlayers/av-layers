import { formatPlaceTime, placeDateKey } from '@av/client';
import './compact-timeline.css';
import { PLAYBACK_STEP_MS } from './timeline';

export interface TimelineFrame { readonly id: string; readonly validTime: string }
export interface CompactTimelineOptions { onSelect(index: number): void; onPlayback?(playing: boolean): void; offsetMinutes?: number }
export interface CompactTimeline { update(frames: readonly TimelineFrame[], selectedFrame: string | null, disabled?: boolean): void; setOffsetMinutes(offsetMinutes: number): void; destroy(): void }

interface LocalTime { day: string; hour: number; minute: number }
interface DayGroup { day: string; indices: number[] }

const PLAYBACK_INTERVAL_MS = PLAYBACK_STEP_MS;
const DATE_LINE: Intl.DateTimeFormatOptions = { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' };

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
    const f = frames[index];
    if (!f) continue;
    const ms = Date.parse(f.validTime), local = localTimeFromMs(ms, offsetMinutes);
    if (!local) continue;
    const dist = Math.abs(local.hour * 60 + local.minute - target);
    if (dist < bestDist || (dist === bestDist && ms < bestMs)) { best = index; bestDist = dist; bestMs = ms; }
  }
  return best;
}

export function scrollLeftForDay(dayLeft: number, dayWidth: number, cellLeft: number, cellWidth: number, viewportWidth: number, contentWidth: number, scrollLeft: number): number {
  if (viewportWidth <= 0 || dayWidth <= 0 || cellWidth <= 0) return scrollLeft;
  const anchorLeft = dayWidth <= viewportWidth ? dayLeft : cellLeft;
  const anchorWidth = dayWidth <= viewportWidth ? dayWidth : cellWidth;
  let next = anchorLeft + anchorWidth / 2 - viewportWidth / 2;
  if (cellLeft < next) next = cellLeft;
  else if (cellLeft + cellWidth > next + viewportWidth) next = cellLeft + cellWidth - viewportWidth;
  return Math.min(Math.max(0, contentWidth - viewportWidth), Math.max(0, next));
}

function groupDays(frames: readonly TimelineFrame[], offsetMinutes: number): DayGroup[] {
  const groups = new Map<string, number[]>();
  frames.forEach((f, i) => { const d = placeDateKey(Date.parse(f.validTime), offsetMinutes); if (d) groups.set(d, [...(groups.get(d) ?? []), i]); });
  return [...groups.entries()].map(([day, indices]) => ({ day, indices }));
}

export function createCompactTimeline(host: HTMLElement, options: CompactTimelineOptions): CompactTimeline {
  const doc = host.ownerDocument;
  let offsetMinutes = Number.isFinite(options.offsetMinutes) ? options.offsetMinutes! : 0;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
    const n = doc.createElement(tag); n.className = cls; if (text !== undefined) n.textContent = text; return n;
  };
  const btn = (cls: string, label: string, text?: string) => { const b = el('button', cls, text); b.type = 'button'; b.setAttribute('aria-label', label); return b; };

  const root = el('div', 'compact-timeline'), dateBlock = el('div', 'ct-date');
  root.setAttribute('role', 'group'); root.setAttribute('aria-label', 'Forecast timeline');
  const dayButton = (cls: string, label: string, direction: 'prev' | 'next') => {
    const b = el('button', cls);
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${direction === 'prev' ? 'M10 3 5 8l5 5' : 'M6 3l5 5-5 5'}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    return b;
  };
  const previousDay = dayButton('ct-day ct-prev', 'Previous available day', 'prev'), nextDay = dayButton('ct-day ct-next', 'Next available day', 'next');
  const dateText = el('div', 'ct-date-text'), dateLine = el('span', 'ct-date-line', 'No forecast time');
  const timeLine = el('span', 'ct-time-line'), timeLabel = el('time', 'ct-time', '--:--');
  timeLine.append(timeLabel); dateText.append(dateLine, timeLine);
  dateBlock.append(previousDay, dateText, nextDay);

  const play = btn('ct-play', 'Play forecast'), playGlyph = el('span', 'ct-play-glyph');
  play.setAttribute('aria-pressed', 'false'); playGlyph.setAttribute('aria-hidden', 'true'); play.append(playGlyph);

  const hours = el('div', 'ct-hours');
  for (const [k, v] of [['role', 'radiogroup'], ['aria-label', 'Available forecast frames'], ['aria-orientation', 'horizontal']] as const) hours.setAttribute(k, v);
  root.append(dateBlock, play, hours); host.append(root);

  let frames: readonly TimelineFrame[] = [], days: DayGroup[] = [], cells: HTMLButtonElement[] = [];
  let selectedIndex = -1, disabled = false, timer: ReturnType<typeof setInterval> | null = null, destroyed = false;
  let placedFor = '', placedScroll = -1;

  const controlsDisabled = () => disabled || !frames.length;
  const dayPosition = () => selectedIndex < 0 ? -1 : days.findIndex(g => g.day === placeDateKey(Date.parse(frames[selectedIndex]!.validTime), offsetMinutes));
  const dateLabel = (ms: number) => new Date(ms + offsetMinutes * 60_000).toLocaleDateString('en-US', DATE_LINE);

  function rebuild(): void {
    const hadFocus = cells.includes(doc.activeElement as HTMLButtonElement), prevScroll = hours.scrollLeft;
    cells = frames.map((frame, index) => {
      const ms = Date.parse(frame.validTime), local = localTimeFromMs(ms, offsetMinutes), ok = Number.isFinite(ms);
      const cell = btn('ct-hour', ok ? formatPlaceTime(ms, offsetMinutes, 'stamp') : 'Unknown date');
      cell.setAttribute('role', 'radio'); cell.dataset.index = String(index);
      cell.append(el('span', 'ct-hour-label', local ? String(local.hour).padStart(2, '0') : '--'));
      cell.addEventListener('click', () => select(index, true, false));
      return cell;
    });
    hours.replaceChildren(...cells); hours.scrollLeft = prevScroll;
    if (hadFocus) (cells[selectedIndex] ?? cells[0])?.focus({ preventScroll: true });
  }

  function placeSelection(): void {
    const active = cells[selectedIndex];
    if (!active || hours.clientWidth <= 0) return;
    const signature = `${selectedIndex}:${frames[selectedIndex]?.validTime}:${offsetMinutes}:${Math.round(hours.clientWidth)}:${frames.length}:${frames[0]?.validTime}:${frames[frames.length - 1]?.validTime}`;
    if (signature === placedFor && Math.abs(hours.scrollLeft - placedScroll) > 1) return;
    const day = placeDateKey(Date.parse(frames[selectedIndex]!.validTime), offsetMinutes);
    const group = day ? cells.filter((_, index) => placeDateKey(Date.parse(frames[index]!.validTime), offsetMinutes) === day) : [active];
    const first = group[0] ?? active, last = group[group.length - 1] ?? active;
    const pad = Math.max(0, Math.round((hours.clientWidth - active.offsetWidth) / 2));
    hours.style.paddingLeft = `${pad}px`;
    hours.style.paddingRight = `${pad}px`;
    const origin = hours.getBoundingClientRect().left;
    const leftOf = (cell: HTMLButtonElement) => cell.getBoundingClientRect().left - origin + hours.scrollLeft;
    const dayLeft = leftOf(first), cellLeft = leftOf(active);
    hours.scrollLeft = scrollLeftForDay(dayLeft, leftOf(last) + last.offsetWidth - dayLeft, cellLeft, active.offsetWidth, hours.clientWidth, hours.scrollWidth, hours.scrollLeft);
    placedFor = signature;
    placedScroll = hours.scrollLeft;
  }

  function render(): void {
    cells.forEach((cell, i) => {
      const sel = i === selectedIndex;
      cell.classList.toggle('is-selected', sel);
      cell.setAttribute('aria-checked', String(sel));
      cell.tabIndex = sel || (selectedIndex < 0 && i === 0) ? 0 : -1;
    });
    placeSelection();
    const frame = selectedIndex >= 0 ? frames[selectedIndex] : undefined, ms = frame ? Date.parse(frame.validTime) : NaN;
    if (!frame || !Number.isFinite(ms)) {
      dateLine.textContent = 'No forecast time'; timeLabel.textContent = '--:--'; timeLabel.removeAttribute('dateTime');
    } else {
      dateLine.textContent = dateLabel(ms); timeLabel.textContent = formatPlaceTime(ms, offsetMinutes, 'clock'); timeLabel.setAttribute('dateTime', frame.validTime);
    }
    const off = controlsDisabled(), pos = dayPosition(), playing = timer !== null;
    play.disabled = off; hours.setAttribute('aria-disabled', String(off));
    for (const c of cells) c.disabled = off;
    previousDay.disabled = off || pos <= 0; nextDay.disabled = off || pos < 0 || pos >= days.length - 1;
    play.classList.toggle('is-playing', playing);
    play.setAttribute('aria-pressed', String(playing));
    play.setAttribute('aria-label', playing ? 'Pause forecast playback' : 'Play forecast');
  }

  function select(index: number, notify: boolean, moveFocus: boolean): void {
    if (destroyed || controlsDisabled() || index < 0 || index >= frames.length) return;
    selectedIndex = index; render();
    if (moveFocus) cells[index]?.focus({ preventScroll: true });
    if (notify) options.onSelect(index);
  }

  const stopPlayback = () => {
    const wasPlaying = timer !== null;
    if (timer !== null) { clearInterval(timer); timer = null; }
    if (wasPlaying) options.onPlayback?.(false);
    if (!destroyed) render();
  };
  const moveDay = (dir: number) => {
    const pos = dayPosition(), target = pos >= 0 ? days[pos + dir] : undefined, cur = frames[selectedIndex];
    const local = cur ? localTimeFromMs(Date.parse(cur.validTime), offsetMinutes) : null;
    if (target && local) select(nearestFrameIndexForDay(frames, target.indices, offsetMinutes, local.hour, local.minute), true, false);
  };
  previousDay.addEventListener('click', () => moveDay(-1));
  nextDay.addEventListener('click', () => moveDay(1));

  play.addEventListener('click', () => {
    if (timer !== null) { stopPlayback(); return; }
    if (controlsDisabled()) return;
    if (frames.length <= 1) { if (selectedIndex < 0) select(0, true, false); render(); return; }
    if (selectedIndex < 0 || selectedIndex >= frames.length - 1) select(0, true, false);
    timer = setInterval(() => {
      if (selectedIndex >= frames.length - 1) { stopPlayback(); return; }
      select(selectedIndex + 1, true, false);
      if (selectedIndex >= frames.length - 1) stopPlayback();
    }, PLAYBACK_INTERVAL_MS);
    options.onPlayback?.(true);
    render();
  });

  hours.addEventListener('keydown', event => {
    const k = (event as KeyboardEvent).key;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(k)) return;
    event.preventDefault();
    if (controlsDisabled()) return;
    const s = selectedIndex < 0 ? 0 : selectedIndex;
    select(k === 'Home' ? 0 : k === 'End' ? frames.length - 1 : k === 'ArrowLeft' || k === 'ArrowUp' ? Math.max(0, s - 1) : Math.min(frames.length - 1, s + 1), true, true);
  });

  const onVisibility = () => { if (doc.visibilityState === 'hidden') stopPlayback(); };
  doc.addEventListener('visibilitychange', onVisibility);
  doc.defaultView?.addEventListener('pagehide', stopPlayback);
  const resizeObserver = typeof ResizeObserver === 'function' && hours.nodeType === 1 ? new ResizeObserver(() => { if (!destroyed) placeSelection(); }) : null;
  resizeObserver?.observe(hours, { box: 'border-box' });

  return {
    update(nextFrames, selectedFrame, nextDisabled = false) {
      if (destroyed) return;
      const changed = frames.length !== nextFrames.length || frames.some((f, i) => f.id !== nextFrames[i]!.id || f.validTime !== nextFrames[i]!.validTime);
      frames = nextFrames.slice(); days = groupDays(frames, offsetMinutes);
      selectedIndex = frames.findIndex(f => f.id === selectedFrame); disabled = nextDisabled;
      if (changed) rebuild();
      render();
      if (controlsDisabled()) stopPlayback();
    },
    setOffsetMinutes(next: number) {
      if (destroyed || !Number.isFinite(next) || next === offsetMinutes) return;
      offsetMinutes = next; days = groupDays(frames, offsetMinutes);
      rebuild(); render();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true; stopPlayback(); resizeObserver?.disconnect();
      doc.removeEventListener('visibilitychange', onVisibility);
      doc.defaultView?.removeEventListener('pagehide', stopPlayback);
      root.remove();
    }
  };
}
