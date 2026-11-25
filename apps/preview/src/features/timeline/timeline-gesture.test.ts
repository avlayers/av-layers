import { expect, it } from 'vitest';
import { clearGesture, createGesture, edgeStep, releaseSeeks, type EdgeInput } from './timeline-gesture';

const both = () => true;
const none = () => false;
const at = (clientX: number, extra: Partial<EdgeInput> = {}) => edgeStep({ clientX, left: 100, width: 200, moved: true, lock: null, hasNeighbor: both, ...extra });

it('releases inside the track, before the pointer moves, and within the 3px dead zone', () => {
  expect(at(150)).toEqual({ kind: 'release' });
  expect(at(320, { moved: false })).toEqual({ kind: 'release' });
  expect(at(303)).toEqual({ kind: 'release' });
});

it('pulls with an eased rubber band towards a neighbour and a 2.5px dead stop without one', () => {
  expect(at(311)).toEqual({ kind: 'pull', direction: 1, px: 4.3, armed: true });
  expect(at(89)).toEqual({ kind: 'pull', direction: -1, px: -4.3, armed: true });
  expect(at(330, { hasNeighbor: none })).toEqual({ kind: 'pull', direction: 1, px: 2.5, armed: false });
});

it('bounces at 20px overscroll only when a neighbour day exists', () => {
  expect(at(320)).toEqual({ kind: 'bounce', direction: 1, overPx: 20 });
  expect(at(70)).toEqual({ kind: 'bounce', direction: -1, overPx: 30 });
  expect(at(320, { hasNeighbor: none }).kind).toBe('pull');
});

it('holds a bounce until the pointer re-enters 10px or pulls another 32px', () => {
  const lock = { direction: 1 as const, anchorOverPx: 22 };
  expect(at(340, { lock })).toEqual({ kind: 'hold', lock });
  expect(at(354, { lock })).toEqual({ kind: 'bounce', direction: 1, overPx: 54 });
  expect(at(354, { lock, hasNeighbor: none })).toEqual({ kind: 'hold', lock: { direction: 1, anchorOverPx: 54 } });
  expect(at(295, { lock })).toEqual({ kind: 'hold', lock });
  expect(at(290, { lock })).toEqual({ kind: 'release' });
  expect(at(80, { lock })).toEqual({ kind: 'bounce', direction: -1, overPx: 20 });
});

it('re-seeks on pointerup only after travel, at a new x, with no bounce lock', () => {
  const gesture = createGesture();
  gesture.originX = 10;
  gesture.lastX = 10;
  expect(releaseSeeks(gesture, 'pointerup', 10.5)).toBe(false);
  expect(releaseSeeks(gesture, 'pointerup', 12)).toBe(true);
  expect(releaseSeeks(gesture, 'pointercancel', 12)).toBe(false);
  gesture.moved = true;
  gesture.lastX = 12;
  expect(releaseSeeks(gesture, 'pointerup', 12)).toBe(false);
  gesture.lock = { direction: 1, anchorOverPx: 20 };
  expect(releaseSeeks(gesture, 'pointerup', 30)).toBe(false);
});

it('clears per-pointer state, bumps the version, and keeps the bounce parity', () => {
  const gesture = createGesture();
  Object.assign(gesture, { pointer: 3, startIndex: 2, moved: true, changed: true, scrubMinute: 600, preparedBounceIndex: 4, lock: { direction: -1, anchorOverPx: 25 }, bounceParity: true, version: 5 });
  clearGesture(gesture);
  expect(gesture).toMatchObject({ pointer: null, startIndex: -1, moved: false, changed: false, scrubMinute: null, preparedBounceIndex: -1, lock: null, bounceParity: true, version: 6 });
});
