import { DEFAULT_DOCK_VIEW, type DockViewId } from '../controls/bottom-dock-model';
import { DAY_MINUTES, localTimeFromMs, nearestFrameIndexForDay, scaleAtWidth, xToMinute, type DayGroup, type DayScale } from './day-scale';
import { createDayPreviews, type DayPreviewSource } from './day-previews';
import { createFrameWindow } from './timeline-frame-window';
import { clearGesture, createGesture, dayAtX, pointerTravelled, releaseSeeks } from './timeline-gesture';
import type { TimelineFrame } from './timeline-model';
import { createTimelineView } from './timeline-view';


export interface CompactTimelineOptions {
  onSelect(index: number, history: 'push' | 'replace' | 'none'): void;
  onIntent?(index: number): void;
  onPrepare?(index: number): void;
  /** A committed timeline selection moved to another local day. */
  onDayChange?(): void;
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
const RAIL_TOUCH_PX = 4;
const PREFER_REST_MS = 150;

export function createCompactTimeline(host: HTMLElement, options: CompactTimelineOptions): CompactTimeline {
  const doc = host.ownerDocument;
  let destroyed = false, sceneRequest: number | null = null, suppressClickUntil = 0, lastPointerEvent: Event | null = null;
  /** Local minute of day that day picks aim for; null follows the selected frame. */
  let comparisonMinute: number | null = null;
  const win = createFrameWindow(options);
  const gesture = createGesture();
  const previews = options.preview ? createDayPreviews(options.preview, doc.defaultView) : null;
  /** Day the enlarged preview shows (pressed, dragged, hovered or focused); null when closed. */
  let loupeDay: string | null = null, preferTimer: ReturnType<typeof setTimeout> | null = null;
  /** A touch on the rail seeks only once it travels or lifts as a tap, so a finger reaching for a day doesn't move the hour. */
  let railTouch = false;
  /** Local day of the last selection the app committed (from here or outside), for telling when a pick changes day. */
  let committedDay: string | undefined;
  /** Escape shut the enlarged preview during this drag; it stays shut until release. */
  let loupeDismissed = false;
  let preferKey = '';
  const view = createTimelineView(host, win, options.variant ?? DEFAULT_DOCK_VIEW, {
    prepareDay(group) {
      if (!options.onPrepare) return;
      const idx = targetForDay(group);
      if (idx >= 0) options.onPrepare(idx);
    },
    pickDay(group) {
      // Only the click that trails a day drag is dropped; a later keyboard or assistive click still picks.
      if (Date.now() < suppressClickUntil) { suppressClickUntil = 0; return; }
      suppressClickUntil = 0;
      pickDay(group, false);
    },
    dayKey(event, group) {
      if (event.key !== 'Escape') { dayKey(event, group); return; }
      // Escape closes an open preview and nothing else, so the point card stays.
      if (loupeDay !== null) { event.preventDefault(); loupeDismissed = gesture.pointer !== null; setLoupe(null); }
    },
    resized: () => render()
  });
  const { track, daysRow } = view;

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
    if (day === null) { view.setDayLoupe(null); view.loupeCanvas.width = 0; view.loupeCanvas.height = 0; }
    previews.schedule(paintPreviews);
  }

  /** Paints every day card at its target frame and the loupe, and asks the source to prepare those frames. */
  function paintPreviews(): void {
    if (!previews || destroyed) return;
    const targets: number[] = [];
    let loupeIndex = -1, anyThumb = false;
    const aim = targetMinute();
    for (const { group, canvas } of view.cards()) {
      // Each day's card follows the compared hour (or the selected one while the rail scrubs) to that day's nearest frame.
      const index = win.off() || !group.indices.length ? -1 : targetForDay(group);
      if (index >= 0) targets.push(index);
      if (group.day === loupeDay) loupeIndex = index;
      const state = previews.paint(canvas, index);
      if (state !== 'unavailable') anyThumb = true;
      view.setThumb(group.day, state, index, aim);
    }
    view.setRowThumbs(anyThumb);
    // A rail scrub changes the targets every frame: they are asked for once the finger rests, so cards fill in
    // mid-scrub without re-sorting the overview queue on every frame.
    const key = targets.join(',');
    if (gesture.pointer === null || gesture.kind !== 'rail') {
      if (preferTimer !== null) clearTimeout(preferTimer);
      preferTimer = null; preferKey = '';
      previews.prefer(targets);
    } else if (key !== preferKey) {
      // Only a changed target set restarts the rest timer; repaints from loading frames don't hold it off.
      if (preferTimer !== null) clearTimeout(preferTimer);
      preferKey = key;
      preferTimer = setTimeout(() => { preferTimer = null; preferKey = ''; if (!destroyed) previews?.prefer(targets); }, PREFER_REST_MS);
    }
    if (loupeDay !== null) {
      // Shown before it is painted, so the canvas is sized to its real box.
      view.setDayLoupe(loupeIndex);
      const state = previews.paint(view.loupeCanvas, loupeIndex);
      if (state === 'unavailable') view.setDayLoupe(null);
    }
    // A card that just switched from a plain date to an image was sized while hidden: paint once more at its box.
    if (previews.drewHidden()) previews.schedule(paintPreviews);
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
    loupeDismissed = false;
    clearGesture(gesture);
    cancelSceneRequest();
  }

  function deliverScene(index: number, history: 'push' | 'replace' | 'none'): void {
    win.sceneIndex = index;
    const day = dayOf(index);
    const dayChanged = history !== 'none' && committedDay !== undefined && day !== committedDay;
    if (history !== 'none') committedDay = day;
    options.onSelect(index, history);
    if (dayChanged && !destroyed) options.onDayChange?.();
  }

  /** The frame's own local date, so a reindexed new run or regrouped zone can't skew the comparison. */
  function dayOf(index: number): string | undefined {
    const frame = index >= 0 ? win.frames[index] : undefined;
    return frame ? localTimeFromMs(Date.parse(frame.validTime), win.timeZone)?.day : undefined;
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
    if (index < 0) return;
    if (!loupeDismissed) setLoupe(group.day);
    if (index === win.selectedIndex) return;
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
    railTouch = pointer.pointerType === 'touch';
    if (!railTouch) seek(pointer.clientX);
    if (destroyed || win.off() || gesture.pointer === null || version !== gesture.version) return;
    const width = track.getBoundingClientRect().width;
    if (width > 0) gesture.scale = win.liveScale(width);
    if (!destroyed) render(width > 0 ? width : undefined);
  });

  daysRow.addEventListener('pointerdown', event => {
    const pointer = event as PointerEvent;
    suppressClickUntil = 0;
    if (beginGesture(pointer, 'days', daysRow) === null) return;
    comparisonMinute = targetMinute();
    gesture.days = view.dayTargets();
    // The enlarged preview appears only once the press becomes a drag (`seekDay`), so a tap or click never flashes it.
  });

  // Pointer events are heard on the rail and day row and again on the document, so a press released
  // off the timeline (a day press slid up onto the loupe or map before it is captured) still ends.
  const once = (event: Event) => { if (event === lastPointerEvent) return false; lastPointerEvent = event; return true; };
  const movePointer = (event: Event) => {
    const pointer = event as PointerEvent;
    if (!once(event)) return;
    if (gesture.pointer === null || (pointer.pointerId ?? 1) !== gesture.pointer) return;
    if (!pointerTravelled(gesture, pointer.clientX, pointer.clientY)) return;
    if (gesture.kind === 'rail' && railTouch && !gesture.moved && Math.abs(pointer.clientX - gesture.originX) < RAIL_TOUCH_PX) return;
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
    if (!once(event)) return;
    if (gesture.pointer === null || (pointer.pointerId ?? 1) !== gesture.pointer) return;
    const version = gesture.version, kind = gesture.kind, dragged = gesture.moved;
    if (kind === 'rail' && railTouch && !dragged && event.type === 'pointerup') seek(pointer.clientX, false);
    else if (releaseSeeks(gesture, event.type, pointer.clientX)) {
      if (kind === 'rail') seek(pointer.clientX, false);
      else if (dragged) seekDay(pointer.clientX, false);
    }
    if (destroyed || win.off() || gesture.pointer === null || version !== gesture.version) return;
    const start = gesture.startIndex;
    const changed = gesture.changed;
    invalidateGesture();
    // A drag across days ends with no click; a plain tap falls through to the button's click.
    if (kind === 'days' && dragged && event.type === 'pointerup') suppressClickUntil = Date.now() + 400;
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
  for (const [type, listener] of [['pointermove', movePointer], ['pointerup', releasePointer], ['pointercancel', releasePointer]] as const) doc.addEventListener(type, listener);

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
      if (!echo) committedDay = dayOf(nextIndex);
      win.disabled = nextDisabled;
      if (!sameFrames) syncDays();
      render();
    },
    setTimeZone(next: string) {
      if (destroyed || !win.setTimeZone(next)) return;
      // Days regroup under the pointer: drop the gesture, keep the delivered frame, restart the clock target.
      if (gesture.pointer !== null) {
        const changed = gesture.changed;
        invalidateGesture();
        win.selectedIndex = win.sceneIndex;
        // A frame the drag already put on screen is kept and committed, so the URL matches the map.
        if (changed && win.sceneIndex >= 0) deliverScene(win.sceneIndex, 'replace');
      }
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
      if (preferTimer !== null) clearTimeout(preferTimer);
      for (const [type, listener] of [['pointermove', movePointer], ['pointerup', releasePointer], ['pointercancel', releasePointer]] as const) doc.removeEventListener(type, listener);
      previews?.destroy([view.loupeCanvas, ...view.cards().map(card => card.canvas)]);
      win.clearSolar();
      view.destroy();
    }
  };
}
