import type { DayScale } from './day-scale';

/** Pointer scrub state and the edge-pull model that bounces a drag across to the neighbouring day. */
interface BounceLock { direction: -1 | 1; anchorOverPx: number }

interface Gesture {
  /** Captured pointer id; null between gestures. */
  pointer: number | null;
  /** Selected index when the pointer went down. */
  startIndex: number;
  /** Day scale frozen for the gesture so folds stay put under the finger. */
  scale: DayScale | null;
  originX: number;
  lastX: number;
  /** True once the pointer travels 1px from its origin. */
  moved: boolean;
  /** True once the gesture changed the selected index. */
  changed: boolean;
  /** Unsnapped playhead minute while scrubbing. */
  scrubMinute: number | null;
  /** Neighbour direction the track is pulled towards; 0 when the pull has no neighbour or none is active. */
  edgePull: -1 | 0 | 1;
  preparedBounceIndex: number;
  /** Set after a bounce; holds the selection until the pointer re-enters or pulls another step. */
  lock: BounceLock | null;
  /** Bumped on every start and invalidation; callbacks compare it to detect a superseded gesture. */
  version: number;
  /** Alternates the bounce animation name so repeated bounces restart it. */
  bounceParity: boolean;
}

type EdgeStep =
  | { kind: 'bounce'; direction: -1 | 1; overPx: number }
  | { kind: 'hold'; lock: BounceLock }
  | { kind: 'pull'; direction: -1 | 1; px: number; armed: boolean }
  | { kind: 'release' };

export interface EdgeInput {
  clientX: number;
  left: number;
  width: number;
  moved: boolean;
  lock: BounceLock | null;
  hasNeighbor(direction: -1 | 1): boolean;
}

const EDGE_PULL_DEADZONE_PX = 3;
const EDGE_BOUNCE_PX = 20;
const EDGE_REENTER_PX = 10;
const REBOUNCE_STEP_PX = 32;
const MAX_RUBBER_PX = 6;
const MAX_DEAD_STOP_PX = 2.5;

export function createGesture(): Gesture {
  return {
    pointer: null, startIndex: -1, scale: null, originX: Number.NaN, lastX: Number.NaN, moved: false, changed: false,
    scrubMinute: null, edgePull: 0, preparedBounceIndex: -1, lock: null, version: 0, bounceParity: false
  };
}

/** End the current gesture's per-pointer state. The caller resets the track pull and pending scene. */
export function clearGesture(gesture: Gesture): void {
  gesture.version++;
  gesture.pointer = null;
  gesture.scrubMinute = null;
  gesture.preparedBounceIndex = -1;
  gesture.lock = null;
  gesture.startIndex = -1;
  gesture.scale = null;
  gesture.moved = false;
  gesture.changed = false;
  gesture.originX = Number.NaN;
  gesture.lastX = Number.NaN;
}

/** A pointer that has not yet moved 1px from its origin is ignored. */
export function pointerTravelled(gesture: Gesture, clientX: number): boolean {
  return gesture.moved || Math.abs(clientX - gesture.originX) >= 1;
}

/** pointerup at a new x seeks once more unless a bounce holds the selection. */
export function releaseSeeks(gesture: Gesture, type: string, clientX: number): boolean {
  return type === 'pointerup' && gesture.lock === null && clientX !== gesture.lastX && pointerTravelled(gesture, clientX);
}

/** Decide what a pointer at clientX does at the track edges. */
export function edgeStep(input: EdgeInput): EdgeStep {
  const { clientX, left, width, moved, lock, hasNeighbor } = input;
  const right = left + width;
  const direction: -1 | 0 | 1 = clientX < left ? -1 : clientX > right ? 1 : 0;
  const overPx = direction < 0 ? left - clientX : direction > 0 ? clientX - right : 0;
  if (lock !== null) {
    if (direction === lock.direction) {
      if (overPx < lock.anchorOverPx + REBOUNCE_STEP_PX) return { kind: 'hold', lock };
      return hasNeighbor(direction) ? { kind: 'bounce', direction, overPx } : { kind: 'hold', lock: { direction, anchorOverPx: overPx } };
    }
    const reentered = direction !== 0 || (lock.direction > 0 ? right - clientX >= EDGE_REENTER_PX : clientX - left >= EDGE_REENTER_PX);
    if (!reentered) return { kind: 'hold', lock };
  }
  if (!moved || direction === 0) return { kind: 'release' };
  const neighbor = hasNeighbor(direction);
  if (neighbor && overPx >= EDGE_BOUNCE_PX) return { kind: 'bounce', direction, overPx };
  if (overPx <= EDGE_PULL_DEADZONE_PX) return { kind: 'release' };
  const maxPull = neighbor ? MAX_RUBBER_PX : MAX_DEAD_STOP_PX;
  const t = Math.min(1, (overPx - EDGE_PULL_DEADZONE_PX) / (EDGE_BOUNCE_PX - EDGE_PULL_DEADZONE_PX));
  const px = Math.round(direction * maxPull * (1 - (1 - t) * (1 - t)) * 10) / 10;
  return { kind: 'pull', direction, px, armed: neighbor };
}
