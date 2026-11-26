import type { DayGroup, DayScale } from './day-scale';

/** Pointer state for one gesture: an hour scrub on the rail or a drag across the day buttons. */
export interface DayTarget { left: number; right: number; group: DayGroup }

interface Gesture {
  /** Captured pointer id; null between gestures. */
  pointer: number | null;
  /** Which control the pointer went down on. */
  kind: 'rail' | 'days';
  /** Selected index when the pointer went down. */
  startIndex: number;
  /** Day scale frozen for a rail gesture so folds stay put under the finger. */
  scale: DayScale | null;
  /** Day button spans frozen at pointer-down; null while the buttons wrap onto several rows. */
  days: DayTarget[] | null;
  originX: number;
  originY: number;
  lastX: number;
  /** True once the pointer travels far enough to count as a drag. */
  moved: boolean;
  /** True once the gesture changed the selected index. */
  changed: boolean;
  /** Unsnapped playhead minute while scrubbing the rail. */
  scrubMinute: number | null;
  /** Bumped on every start and invalidation; callbacks compare it to detect a superseded gesture. */
  version: number;
}

/** Horizontal travel that turns a day-button press into a drag. */
const DAY_DRAG_PX = 6;

export function createGesture(): Gesture {
  return {
    pointer: null, kind: 'rail', startIndex: -1, scale: null, days: null, originX: Number.NaN, originY: Number.NaN, lastX: Number.NaN,
    moved: false, changed: false, scrubMinute: null, version: 0
  };
}

/** End the current gesture's per-pointer state. The caller cancels the pending scene. */
export function clearGesture(gesture: Gesture): void {
  gesture.version++;
  gesture.pointer = null;
  gesture.kind = 'rail';
  gesture.scrubMinute = null;
  gesture.startIndex = -1;
  gesture.scale = null;
  gesture.days = null;
  gesture.moved = false;
  gesture.changed = false;
  gesture.originX = Number.NaN;
  gesture.originY = Number.NaN;
  gesture.lastX = Number.NaN;
}

/** A rail pointer that has not yet moved 1px from its origin is ignored; a day press needs a clear horizontal drag. */
export function pointerTravelled(gesture: Gesture, clientX: number, clientY = gesture.originY): boolean {
  if (gesture.moved) return true;
  const dx = Math.abs(clientX - gesture.originX);
  if (gesture.kind === 'rail') return dx >= 1;
  return dx >= DAY_DRAG_PX && dx >= Math.abs(clientY - gesture.originY);
}

/** pointerup at a new x seeks once more. */
export function releaseSeeks(gesture: Gesture, type: string, clientX: number): boolean {
  return type === 'pointerup' && clientX !== gesture.lastX && pointerTravelled(gesture, clientX);
}

/** The available day whose span is nearest to `clientX`; only x counts, so a finger drifting off the row still tracks. */
export function dayAtX(days: readonly DayTarget[], clientX: number): DayGroup | undefined {
  let best: DayTarget | undefined, bestDistance = Infinity;
  for (const day of days) {
    const distance = clientX < day.left ? day.left - clientX : clientX > day.right ? clientX - day.right : 0;
    if (distance < bestDistance) { best = day; bestDistance = distance; }
  }
  return best?.group;
}
