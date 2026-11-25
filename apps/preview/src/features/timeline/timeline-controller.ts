import { DEFAULT_DOCK_VIEW, type DockViewId } from '../controls/bottom-dock-model';
import { DAY_MINUTES, localTimeFromMs, nearestFrameIndexForDay, scaleAtWidth, xToMinute, type DayGroup, type DayScale } from './day-scale';
import { createFrameWindow } from './timeline-frame-window';
import { clearGesture, createGesture, edgeStep, pointerTravelled, releaseSeeks } from './timeline-gesture';
import type { TimelineFrame } from './timeline-model';
import { createPlayback } from './timeline-playback';
import { createTimelineView } from './timeline-view';


export interface CompactTimelineOptions {
  onSelect(index: number, history: 'push' | 'replace' | 'none'): void;
  onIntent?(index: number): void;
  onPrepare?(index: number): void;
  onPlayback?(playing: boolean): void;
  offsetMinutes?: number;
  latitude?: number;
  longitude?: number;
  variant?: DockViewId;
}
export interface CompactTimeline {
  update(frames: readonly TimelineFrame[], selectedFrame: string | null, disabled?: boolean): void;
  cancelGesture(): { changed: boolean; delivered: boolean } | null;
  setOffsetMinutes(offsetMinutes: number): void;
  setMapCenter(latitude: number, longitude: number): void;
  setVariant?(variant: DockViewId): void;
  setReadiness?(ready: number, total: number, loading?: boolean): void;
  setHighlightedDays?(days: readonly string[] | null): void;
  pause(): void;
  destroy(): void;
}

/**
 * Compose the timeline: the frame window holds frames and selection, the gesture holds pointer
 * state, playback owns the timer, and the view paints. This module routes input between them.
 */
export function createCompactTimeline(host: HTMLElement, options: CompactTimelineOptions): CompactTimeline {
  const doc = host.ownerDocument;
  let destroyed = false, sceneRequest: number | null = null;
  const win = createFrameWindow(options);
  const gesture = createGesture();
  const playback = createPlayback({
    atEnd: () => destroyed || win.selectedIndex >= win.frames.length - 1,
    advance: () => select(win.selectedIndex + 1, 'replace', false),
    finish: stopPlayback
  });
  const view = createTimelineView(host, win, options.variant ?? DEFAULT_DOCK_VIEW, {
    prepareDay(group) {
      if (!options.onPrepare) return;
      const idx = targetForDay(group);
      if (idx >= 0) options.onPrepare(idx);
    },
    pickDay(group) {
      if (playback.playing) stopPlayback();
      select(targetForDay(group), 'push', false);
    },
    resized: () => render()
  });
  const { track, play } = view;

  function targetForDay(group: DayGroup): number {
    const minute = win.selectedMinute();
    return nearestFrameIndexForDay(win.frames, group.indices, win.offsetMinutes, minute === null ? 12 : Math.floor(minute / 60), minute === null ? 0 : minute % 60);
  }

  function currentScale(width: number): DayScale {
    if (!gesture.scale) return win.liveScale(width);
    gesture.scale = scaleAtWidth(gesture.scale, width);
    return gesture.scale;
  }

  function render(width = view.trackWidth()): void {
    const scale = currentScale(width);
    view.render({ scale, width, scrubMinute: gesture.pointer !== null ? gesture.scrubMinute : null, edgePull: gesture.edgePull, playing: playback.playing });
  }

  function setTrackPull(px: number, armed: -1 | 0 | 1): void {
    view.setPull(px, armed !== 0);
    gesture.edgePull = armed;
  }

  function syncDays(): void {
    if (win.syncDays()) view.rebuildDays();
  }

  function cancelSceneRequest(): void {
    if (sceneRequest !== null) doc.defaultView?.cancelAnimationFrame(sceneRequest);
    sceneRequest = null;
  }

  function invalidateGesture(): void {
    clearGesture(gesture);
    cancelSceneRequest();
    setTrackPull(0, 0);
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

  /** Show a scrub-selected index; queue its scene unless the gesture ended meanwhile. */
  function scrubTo(index: number, width: number, queue: boolean, refreezeScale = false): void {
    const version = gesture.version;
    win.selectedIndex = index;
    gesture.changed = true;
    if (refreezeScale) gesture.scale = win.liveScale(width);
    render(width);
    options.onIntent?.(index);
    if (destroyed || win.off() || gesture.pointer === null || version !== gesture.version) return;
    if (queue) queueScene();
  }

  function bounceToDay(neighbor: DayGroup, direction: -1 | 1, overPx: number, width: number, queue: boolean): void {
    const targetIndex = direction > 0 ? neighbor.indices[0]! : neighbor.indices.at(-1)!;
    if (targetIndex < 0 || targetIndex >= win.frames.length) return;
    const targetFrame = win.frames[targetIndex];
    const targetLocal = targetFrame ? localTimeFromMs(Date.parse(targetFrame.validTime), win.offsetMinutes) : null;
    gesture.scrubMinute = targetLocal ? targetLocal.hour * 60 + targetLocal.minute : (direction > 0 ? 0 : DAY_MINUTES);
    gesture.preparedBounceIndex = -1;
    setTrackPull(0, 0);
    gesture.bounceParity = !gesture.bounceParity;
    view.setBounce(direction, gesture.bounceParity);
    gesture.lock = { direction, anchorOverPx: overPx };
    scrubTo(targetIndex, width, queue, true);
  }

  function seek(clientX: number, queue = true): void {
    const group = win.selectedGroup();
    if (!group || win.off()) return;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return;
    const step = edgeStep({ clientX, left: rect.left, width: rect.width, moved: gesture.moved, lock: gesture.lock, hasNeighbor: direction => win.adjacentGroup(direction) !== undefined });
    if (step.kind === 'hold') { gesture.lock = step.lock; return; }
    if (step.kind === 'bounce') { bounceToDay(win.adjacentGroup(step.direction)!, step.direction, step.overPx, rect.width, queue); return; }
    gesture.lock = null;
    const prevPull = gesture.edgePull;
    if (step.kind === 'pull') {
      setTrackPull(step.px, step.armed ? step.direction : 0);
      const neighbor = step.armed ? win.adjacentGroup(step.direction) : undefined;
      const previewIdx = neighbor ? (step.direction > 0 ? neighbor.indices[0]! : neighbor.indices.at(-1)!) : -1;
      if (previewIdx >= 0 && previewIdx !== gesture.preparedBounceIndex) {
        gesture.preparedBounceIndex = previewIdx;
        options.onPrepare?.(previewIdx);
      }
    } else if (gesture.edgePull !== 0 || view.isPulled()) {
      setTrackPull(0, 0);
    }
    const rawMinute = Math.min(DAY_MINUTES, Math.max(0, xToMinute(currentScale(rect.width), Math.min(rect.width, Math.max(0, clientX - rect.left)))));
    const rounded = Math.min(DAY_MINUTES, Math.max(0, Math.round(rawMinute)));
    const index = nearestFrameIndexForDay(win.frames, group.indices, win.offsetMinutes, Math.floor(rounded / 60), rounded % 60);
    const scrubMoved = gesture.scrubMinute === null || Math.abs(rawMinute - gesture.scrubMinute) >= 0.05;
    gesture.scrubMinute = rawMinute;
    if (index >= 0 && index !== win.selectedIndex) scrubTo(index, rect.width, queue);
    else if (scrubMoved || gesture.edgePull !== prevPull) render(rect.width);
  }

  function stopPlayback(): void {
    if (playback.stop()) options.onPlayback?.(false);
    if (!destroyed) render();
  }

  function wireStepper(button: HTMLButtonElement, delta: -1 | 1): void {
    const targetIndex = (): number => {
      if (!win.frames.length) return -1;
      if (win.selectedIndex < 0) return delta > 0 ? 0 : -1;
      return Math.max(0, Math.min(win.frames.length - 1, win.selectedIndex + delta));
    };
    const prepareStep = () => {
      if (button.disabled || win.off() || !options.onPrepare) return;
      const idx = targetIndex();
      if (idx >= 0 && idx !== win.selectedIndex) options.onPrepare(idx);
    };
    button.addEventListener('pointerenter', prepareStep);
    button.addEventListener('focus', prepareStep);
    button.addEventListener('pointerdown', prepareStep);
    button.addEventListener('click', () => {
      if (button.disabled || win.off()) return;
      if (playback.playing) stopPlayback();
      const idx = targetIndex();
      if (idx >= 0) select(idx, 'replace', false);
    });
  }
  wireStepper(view.stepPrev, -1);
  wireStepper(view.stepNext, 1);

  play.addEventListener('click', () => {
    if (gesture.pointer !== null) {
      if (win.selectedIndex >= 0) select(win.selectedIndex, 'replace', false);
      else invalidateGesture();
    }
    if (destroyed || win.off()) return;
    if (playback.playing) { stopPlayback(); return; }
    if (win.frames.length <= 1) { if (win.selectedIndex < 0) select(0, 'replace', false); if (!destroyed) render(); return; }
    if (win.selectedIndex < 0 || win.selectedIndex >= win.frames.length - 1) select(0, 'replace', false);
    if (destroyed || win.off()) return;
    playback.start();
    options.onPlayback?.(true);
    if (!destroyed) render();
  });

  track.addEventListener('pointerdown', event => {
    const pointer = event as PointerEvent;
    if (destroyed || gesture.pointer !== null || (pointer.button !== undefined && pointer.button !== 0) || win.off()) return;
    if (playback.playing) stopPlayback();
    if (destroyed || win.off() || gesture.pointer !== null || playback.playing) return;
    gesture.scale = null;
    gesture.moved = false;
    gesture.originX = pointer.clientX;
    gesture.lastX = pointer.clientX;
    gesture.startIndex = win.selectedIndex;
    gesture.pointer = pointer.pointerId ?? 1;
    const version = ++gesture.version;
    if (typeof track.setPointerCapture === 'function' && pointer.pointerId !== undefined) track.setPointerCapture(pointer.pointerId);
    seek(pointer.clientX);
    if (destroyed || win.off() || gesture.pointer === null || version !== gesture.version) return;
    const width = track.getBoundingClientRect().width;
    if (width > 0) gesture.scale = win.liveScale(width);
    if (!destroyed) render(width > 0 ? width : undefined);
  });
  const movePointer = (event: Event) => {
    const pointer = event as PointerEvent;
    if (gesture.pointer === null || (pointer.pointerId ?? 1) !== gesture.pointer) return;
    if (!pointerTravelled(gesture, pointer.clientX)) return;
    gesture.moved = true;
    gesture.lastX = pointer.clientX;
    seek(pointer.clientX);
  };
  const releasePointer = (event: Event) => {
    const pointer = event as PointerEvent;
    if (gesture.pointer === null || (pointer.pointerId ?? 1) !== gesture.pointer) return;
    const version = gesture.version;
    if (releaseSeeks(gesture, event.type, pointer.clientX)) seek(pointer.clientX, false);
    if (destroyed || win.off() || gesture.pointer === null || version !== gesture.version) return;
    const start = gesture.startIndex;
    const changed = gesture.changed;
    invalidateGesture();
    const completedVersion = gesture.version;
    if (changed && win.selectedIndex >= 0) deliverScene(win.selectedIndex, win.selectedIndex !== start ? 'push' : 'replace');
    if (destroyed || win.off() || completedVersion !== gesture.version) return;
    render();
  };
  track.addEventListener('pointermove', movePointer);
  track.addEventListener('pointerup', releasePointer);
  track.addEventListener('pointercancel', releasePointer);
  const stepFromKey = (event: Event) => {
    const key = (event as KeyboardEvent).key;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key)) return;
    event.preventDefault();
    if (win.off()) return;
    if (playback.playing) stopPlayback();
    const current = win.selectedIndex < 0 ? 0 : win.selectedIndex;
    const index = key === 'Home' ? 0
      : key === 'End' ? win.frames.length - 1
        : key === 'ArrowLeft' || key === 'ArrowUp' ? Math.max(0, current - 1)
          : Math.min(win.frames.length - 1, win.selectedIndex < 0 ? 0 : current + 1);
    select(index, 'replace', true);
  };
  track.addEventListener('keydown', stepFromKey);
  view.root.addEventListener('keydown', event => { if (event.target !== track) stepFromKey(event); });

  const onVisibility = () => { if (doc.visibilityState === 'hidden') stopPlayback(); };
  doc.addEventListener('visibilitychange', onVisibility);
  doc.defaultView?.addEventListener('pagehide', stopPlayback);

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
      if (!sameFrames) win.setFrames(nextFrames);
      if (!echo) win.selectedIndex = nextIndex;
      win.sceneIndex = nextIndex;
      win.disabled = nextDisabled;
      if (!sameFrames) syncDays();
      render();
      if (win.off()) stopPlayback();
    },
    setOffsetMinutes(next: number) {
      if (destroyed || !win.setOffsetMinutes(next)) return;
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
    pause() {
      if (!destroyed && playback.playing) stopPlayback();
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
      stopPlayback();
      doc.removeEventListener('visibilitychange', onVisibility);
      doc.defaultView?.removeEventListener('pagehide', stopPlayback);
      win.clearSolar();
      view.destroy();
    }
  };
}
