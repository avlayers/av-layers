import { DEFAULT_DOCK_VIEW, type DockViewId } from '../controls/bottom-dock-model';
import { DAY_MINUTES, nearestFrameIndexForDay, scaleAtWidth, xToMinute, type DayGroup, type DayScale } from './day-scale';
import { createDayPreviews, type DayPreviewSource } from './day-previews';
import { createFrameWindow } from './timeline-frame-window';
import { clearGesture, createGesture, dayAtX, pointerTravelled, releaseSeeks } from './timeline-gesture';
import type { TimelineFrame } from './timeline-model';
import { createTimelineView } from './timeline-view';


export interface CompactTimelineOptions {
  onSelect(index: number, history: 'push' | 'replace' | 'none'): void;
  onIntent?(index: number): void;
  onPrepare?(index: number): void;
  timeZone?: string;
  latitude?: number;
  longitude?: number;
  variant?: DockViewId;
  /** Draws day preview images; without it the days are plain date buttons. */
  preview?: DayPreviewSource;
}
export interface CompactTimeline {
  update(frames: readonly TimelineFrame[], selectedFrame: string | null, disabled?: boolean): void;
  cancelGesture(): { changed: boolean; delivered: boolean } | null;
  setTimeZone(timeZone: string): void;
  setMapCenter(latitude: number, longitude: number): void;
  setVariant?(variant: DockViewId): void;
  setReadiness?(ready: number, total: number, loading?: boolean): void;
  setHighlightedDays?(days: readonly string[] | null): void;
  /** Visible note while the map still shows another hour (see `shownTimeNote`); empty clears it. */
  setShowing?(text: string): void;
  /** Redraws day previews: call when preview readiness, the layer, the theme or the camera changes. */
  refreshPreviews?(): void;
  destroy(): void;
}

const DAY_KEYS = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
const RAIL_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];

/**
 * Compose the timeline: the frame window holds frames and selection, the gesture holds pointer state, and
 * the view paints. This module routes input between them.
 *
 * Day picks (tap, drag, keys) keep a comparison clock time, so moving through a sparse day that only has
 * 15:00 returns to 14:00 on the next day that has it. Rail input, a zone change and an outside selection
 * reset it to the selected frame's own clock.
 */
export function createCompactTimeline(host: HTMLElement, options: CompactTimelineOptions): CompactTimeline {
  const doc = host.ownerDocument;
  let destroyed = false, sceneRequest: number | null = null, suppressClick = false;
  /** Local minute of day that day picks aim for; null follows the selected frame. */
  let comparisonMinute: number | null = null;
  const win = createFrameWindow(options);
  const gesture = createGesture();
  const previews = options.preview ? createDayPreviews(options.preview, doc.defaultView) : null;
  /** Day the enlarged preview shows (pressed, dragged, hovered or focused); null when closed. */
  let loupeDay: string | null = null, loupeHover: ReturnType<typeof setTimeout> | null = null;
  const view = createTimelineView(host, win, options.variant ?? DEFAULT_DOCK_VIEW, {
    prepareDay(group) {
      if (!options.onPrepare) return;
      const idx = targetForDay(group);
      if (idx >= 0) options.onPrepare(idx);
    },
    pickDay(group) {
      if (suppressClick) { suppressClick = false; return; }
      pickDay(group, false);
    },
    dayKey(event, group) { if (event.key === 'Escape') setLoupe(null); else dayKey(event, group); },
    hoverDay(group) {
      if (loupeHover !== null) clearTimeout(loupeHover);
      loupeHover = null;
      if (gesture.pointer !== null && gesture.kind === 'days') return;
      // A short grace lets the pointer cross the gap between buttons without the loupe flickering shut.
      if (group) setLoupe(group.day); else loupeHover = setTimeout(() => { loupeHover = null; setLoupe(null); }, 120);
    },
    resized: () => render()
  });
  const { track, daysRow } = view;
  // The loupe stays open while the pointer is on it, so hovering it never dismisses it.
  view.dayLoupe.addEventListener('pointerenter', () => { if (loupeHover !== null) clearTimeout(loupeHover); loupeHover = null; });
  view.dayLoupe.addEventListener('pointerleave', () => { if (gesture.pointer === null) setLoupe(null); });

  function targetMinute(): number | null {
    return comparisonMinute ?? win.selectedMinute();
  }

  function targetForDay(group: DayGroup): number {
    // The selected day keeps its exact frame, including the second of two repeated DST hours.
    if (group.indices.includes(win.selectedIndex)) return win.selectedIndex;
    const minute = targetMinute();
    return nearestFrameIndexForDay(win.frames, group.indices, win.timeZone, minute === null ? 12 : Math.floor(minute / 60), minute === null ? 0 : minute % 60);
  }

  /** Selects `group` at the comparison time, remembering that time first. */
  function pickDay(group: DayGroup, moveFocus: boolean): void {
    if (win.off() || !group.indices.length) return;
    comparisonMinute = targetMinute();
    const index = targetForDay(group);
    if (gesture.pointer === null && index === win.selectedIndex && index === win.sceneIndex) { if (moveFocus) view.focusDay(group.day); render(); return; }
    select(index, 'push', false);
    if (moveFocus && !destroyed) view.focusDay(group.day);
  }

  /** Day keys move between available days at the comparison time. */
  function dayKey(event: KeyboardEvent, focused: DayGroup): void {
    if (!DAY_KEYS.includes(event.key)) return;
    event.preventDefault();
    const available = win.days.filter(group => group.indices.length);
    const at = Math.max(0, available.findIndex(group => group.day === focused.day));
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1
      : Math.min(available.length - 1, Math.max(0, at + (event.key === 'ArrowRight' ? 1 : -1)));
    const group = available[next];
    if (group) pickDay(group, true);
  }

  function setLoupe(day: string | null): void {
    if (!previews || day === loupeDay) return;
    loupeDay = day;
    if (day === null) view.setDayLoupe(null);
    previews.schedule(paintPreviews);
  }

  /** Paints every day card at its target frame and the loupe, and asks the source to prepare those frames. */
  function paintPreviews(): void {
    if (!previews || destroyed) return;
    const targets: number[] = [];
    let loupeIndex = -1;
    for (const { group, canvas } of view.cards()) {
      const index = win.off() || !group.indices.length ? -1 : targetForDay(group);
      if (index >= 0) targets.push(index);
      if (group.day === loupeDay) loupeIndex = index;
      view.setThumb(group.day, previews.paint(canvas, index));
    }
    previews.prefer(targets);
    if (loupeDay === null) return;
    const state = previews.paint(view.loupeCanvas, loupeIndex);
    view.setDayLoupe(state === 'unavailable' ? null : loupeIndex);
  }

  function currentScale(width: number): DayScale {
    if (!gesture.scale) return win.liveScale(width);
    gesture.scale = scaleAtWidth(gesture.scale, width);
    return gesture.scale;
  }

  function render(width = view.trackWidth()): void {
    const scale = currentScale(width);
    view.render({ scale, width, scrubMinute: gesture.pointer !== null && gesture.kind === 'rail' ? gesture.scrubMinute : null, comparisonMinute });
    previews?.schedule(paintPreviews);
  }

  function syncDays(): void {
    if (win.syncDays()) view.rebuildDays();
  }

  function cancelSceneRequest(): void {
    if (sceneRequest !== null) doc.defaultView?.cancelAnimationFrame(sceneRequest);
    sceneRequest = null;
  }

  function invalidateGesture(): void {
    if (gesture.pointer !== null && gesture.kind === 'days') setLoupe(null);
    clearGesture(gesture);
    cancelSceneRequest();
  }

  function deliverScene(index: number, history: 'push' | 'replace' | 'none'): void {
    win.sceneIndex = index;
    options.onSelect(index, history);
  }

  function queueScene(): void {
    if (sceneRequest !== null) return;
    const frameClock = doc.defaultView;
    if (!frameClock || typeof frameClock.requestAnimationFrame !== 'function' || typeof frameClock.cancelAnimationFrame !== 'function') {
      if (win.selectedIndex !== win.sceneIndex) deliverScene(win.selectedIndex, 'none');
      return;
    }
    sceneRequest = frameClock.requestAnimationFrame(() => {
      sceneRequest = null;
      if (!destroyed && gesture.pointer !== null && win.selectedIndex !== win.sceneIndex) deliverScene(win.selectedIndex, 'none');
    });
  }

  function select(index: number, history: 'push' | 'replace' | 'none', moveFocus: boolean): void {
    if (destroyed || win.off() || index < 0 || index >= win.frames.length) return;
    const changed = gesture.pointer !== null || index !== win.selectedIndex || index !== win.sceneIndex;
    invalidateGesture();
    win.selectedIndex = index;
    render();
    if (changed) deliverScene(index, history);
    if (moveFocus && !destroyed) track.focus({ preventScroll: true });
  }

  /** Show a gesture-selected index; queue its scene unless the gesture ended meanwhile. */
  function scrubTo(index: number, width: number | undefined, queue: boolean): void {
    const version = gesture.version;
    win.selectedIndex = index;
    gesture.changed = true;
    render(width);
    options.onIntent?.(index);
    if (destroyed || win.off() || gesture.pointer === null || version !== gesture.version) return;
    if (queue) queueScene();
  }

  /** Rail scrub: the nearest frame to the pointer inside the selected day. */
  function seek(clientX: number, queue = true): void {
    const group = win.selectedGroup();
    if (!group || win.off()) return;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return;
    const rawMinute = Math.min(DAY_MINUTES, Math.max(0, xToMinute(currentScale(rect.width), Math.min(rect.width, Math.max(0, clientX - rect.left)))));
    const rounded = Math.min(DAY_MINUTES, Math.max(0, Math.round(rawMinute)));
    const index = nearestFrameIndexForDay(win.frames, group.indices, win.timeZone, Math.floor(rounded / 60), rounded % 60);
    const scrubMoved = gesture.scrubMinute === null || Math.abs(rawMinute - gesture.scrubMinute) >= 0.05;
    gesture.scrubMinute = rawMinute;
    comparisonMinute = null;
    if (index >= 0 && index !== win.selectedIndex) scrubTo(index, rect.width, queue);
    else if (scrubMoved) render(rect.width);
  }

  /** Day drag: the day under the pointer's x, at the comparison time. */
  function seekDay(clientX: number, queue = true): void {
    const group = gesture.days ? dayAtX(gesture.days, clientX) : undefined;
    if (!group || win.off()) return;
    const index = group.indices.includes(gesture.startIndex) ? gesture.startIndex : targetForDay(group);
    if (index < 0 || index === win.selectedIndex) return;
    loupeDay = group.day;
    doc.defaultView?.navigator?.vibrate?.(8);
    scrubTo(index, undefined, queue);
  }

  function beginGesture(pointer: PointerEvent, kind: 'rail' | 'days', target: HTMLElement): number | null {
    if (destroyed || gesture.pointer !== null || (pointer.button !== undefined && pointer.button !== 0) || win.off()) return null;
    gesture.kind = kind;
    gesture.scale = null;
    gesture.days = null;
    gesture.moved = false;
    gesture.originX = pointer.clientX;
    gesture.originY = pointer.clientY ?? 0;
    gesture.lastX = pointer.clientX;
    gesture.startIndex = win.selectedIndex;
    gesture.pointer = pointer.pointerId ?? 1;
    if (kind === 'rail' && typeof target.setPointerCapture === 'function' && pointer.pointerId !== undefined) target.setPointerCapture(pointer.pointerId);
    return ++gesture.version;
  }

  track.addEventListener('pointerdown', event => {
    const pointer = event as PointerEvent;
    const version = beginGesture(pointer, 'rail', track);
    if (version === null) return;
    seek(pointer.clientX);
    if (destroyed || win.off() || gesture.pointer === null || version !== gesture.version) return;
    const width = track.getBoundingClientRect().width;
    if (width > 0) gesture.scale = win.liveScale(width);
    if (!destroyed) render(width > 0 ? width : undefined);
  });

  daysRow.addEventListener('pointerdown', event => {
    const pointer = event as PointerEvent;
    suppressClick = false;
    if (beginGesture(pointer, 'days', daysRow) === null) return;
    comparisonMinute = targetMinute();
    gesture.days = view.dayTargets();
    // The enlarged preview opens on press, for the day under the finger.
    const pressed = gesture.days ? dayAtX(gesture.days, pointer.clientX) : undefined;
    if (pressed) setLoupe(pressed.day);
  });

  const movePointer = (event: Event) => {
    const pointer = event as PointerEvent;
    if (gesture.pointer === null || (pointer.pointerId ?? 1) !== gesture.pointer) return;
    if (!pointerTravelled(gesture, pointer.clientX, pointer.clientY)) return;
    if (gesture.kind === 'days') {
      if (!gesture.days) return;
      if (!gesture.moved && typeof daysRow.setPointerCapture === 'function' && pointer.pointerId !== undefined) daysRow.setPointerCapture(pointer.pointerId);
    }
    gesture.moved = true;
    gesture.lastX = pointer.clientX;
    if (gesture.kind === 'rail') seek(pointer.clientX);
    else seekDay(pointer.clientX);
  };
  const releasePointer = (event: Event) => {
    const pointer = event as PointerEvent;
    if (gesture.pointer === null || (pointer.pointerId ?? 1) !== gesture.pointer) return;
    const version = gesture.version, kind = gesture.kind, dragged = gesture.moved;
    if (releaseSeeks(gesture, event.type, pointer.clientX)) {
      if (kind === 'rail') seek(pointer.clientX, false);
      else if (dragged) seekDay(pointer.clientX, false);
    }
    if (destroyed || win.off() || gesture.pointer === null || version !== gesture.version) return;
    const start = gesture.startIndex;
    const changed = gesture.changed;
    invalidateGesture();
    // A drag across days ends with no click; a plain tap falls through to the button's click.
    if (kind === 'days' && dragged) suppressClick = event.type === 'pointerup';
    if (kind === 'days') setLoupe(null);
    const completedVersion = gesture.version;
    const history = event.type === 'pointercancel' ? 'replace' : win.selectedIndex !== start ? 'push' : 'replace';
    if (changed && win.selectedIndex >= 0) deliverScene(win.selectedIndex, history);
    if (destroyed || win.off() || completedVersion !== gesture.version) return;
    render();
  };
  for (const target of [track, daysRow]) {
    target.addEventListener('pointermove', movePointer);
    target.addEventListener('pointerup', releasePointer);
    target.addEventListener('pointercancel', releasePointer);
  }

  /** Rail keys step through the selected day's frames. */
  track.addEventListener('keydown', event => {
    const key = (event as KeyboardEvent).key;
    if (!RAIL_KEYS.includes(key)) return;
    event.preventDefault();
    const group = win.selectedGroup();
    if (win.off() || !group) return;
    const at = Math.max(0, group.indices.indexOf(win.selectedIndex));
    const next = key === 'Home' ? 0
      : key === 'End' ? group.indices.length - 1
        : key === 'ArrowLeft' || key === 'ArrowDown' ? Math.max(0, at - 1)
          : Math.min(group.indices.length - 1, win.selectedIndex < 0 ? 0 : at + 1);
    comparisonMinute = null;
    select(group.indices[next]!, 'replace', true);
  });

  return {
    cancelGesture() {
      if (destroyed || gesture.pointer === null) return null;
      const state = { changed: gesture.changed, delivered: win.sceneIndex !== gesture.startIndex };
      invalidateGesture();
      win.selectedIndex = win.sceneIndex;
      render();
      return state;
    },
    update(nextFrames, selectedFrame, nextDisabled = false) {
      if (destroyed) return;
      const nextIndex = nextFrames.findIndex(frame => frame.id === selectedFrame);
      const sameFrames = win.sameFrames(nextFrames);
      const active = gesture.pointer !== null;
      if (view.painted() && sameFrames && nextDisabled === win.disabled && nextIndex === win.sceneIndex && (active || nextIndex === win.selectedIndex)) return;
      const echo = active && sameFrames && nextDisabled === win.disabled && nextIndex === win.sceneIndex;
      if (!echo && (active || !sameFrames || nextDisabled !== win.disabled || nextIndex !== win.sceneIndex)) invalidateGesture();
      // A selection from outside (a point time, the URL, a new run) sets its own clock time.
      if (!echo && nextIndex !== win.sceneIndex) comparisonMinute = null;
      if (!sameFrames) win.setFrames(nextFrames);
      if (!echo) win.selectedIndex = nextIndex;
      win.sceneIndex = nextIndex;
      win.disabled = nextDisabled;
      if (!sameFrames) syncDays();
      render();
    },
    setTimeZone(next: string) {
      if (destroyed || !win.setTimeZone(next)) return;
      // Days regroup under the pointer: drop the gesture, keep the delivered frame, restart the clock target.
      if (gesture.pointer !== null) { invalidateGesture(); win.selectedIndex = win.sceneIndex; }
      comparisonMinute = null;
      gesture.scale = null;
      syncDays();
      render();
    },
    setVariant(next: DockViewId) {
      if (destroyed || !view.setVariant(next)) return;
      render();
    },
    setReadiness(ready: number, total: number, loading = false) {
      if (!destroyed) view.setReadiness(ready, total, loading);
    },
    setHighlightedDays(nextDays) {
      if (!destroyed) view.setHighlightedDays(nextDays);
    },
    setShowing(text) {
      if (!destroyed) view.setShowing(text);
    },
    refreshPreviews() {
      if (!destroyed) previews?.schedule(paintPreviews);
    },
    setMapCenter(nextLatitude: number, nextLongitude: number) {
      if (destroyed || !win.setCenter(nextLatitude, nextLongitude)) return;
      gesture.scale = null;
      render();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      invalidateGesture();
      if (loupeHover !== null) clearTimeout(loupeHover);
      previews?.destroy([view.loupeCanvas, ...view.cards().map(card => card.canvas)]);
      win.clearSolar();
      view.destroy();
    }
  };
}
