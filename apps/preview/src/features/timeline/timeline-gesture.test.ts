import { expect, it } from 'vitest';
import { clearGesture, createGesture, dayAtX, pointerTravelled, releaseSeeks } from './timeline-gesture';

it('re-seeks on pointerup only after travel and at a new x', () => {
  const gesture = createGesture();
  gesture.originX = 10;
  gesture.lastX = 10;
  expect(releaseSeeks(gesture, 'pointerup', 10.5)).toBe(false);
  expect(releaseSeeks(gesture, 'pointerup', 12)).toBe(true);
  expect(releaseSeeks(gesture, 'pointercancel', 12)).toBe(false);
  gesture.moved = true;
  gesture.lastX = 12;
  expect(releaseSeeks(gesture, 'pointerup', 12)).toBe(false);
});

it('turns a day press into a drag only after 6px of mostly horizontal travel', () => {
  const gesture = createGesture();
  Object.assign(gesture, { kind: 'days', originX: 100, originY: 50 });
  expect(pointerTravelled(gesture, 104, 50)).toBe(false);
  expect(pointerTravelled(gesture, 107, 60)).toBe(false);
  expect(pointerTravelled(gesture, 108, 54)).toBe(true);
});

it('picks the day by x alone, clamping past either end', () => {
  const day = (name: string) => ({ day: name, indices: [0] });
  const days = [{ left: 0, right: 50, group: day('a') }, { left: 54, right: 104, group: day('b') }, { left: 108, right: 158, group: day('c') }];
  expect(dayAtX(days, 70)?.day).toBe('b');
  expect(dayAtX(days, 52)?.day).toBe('a');
  expect(dayAtX(days, -40)?.day).toBe('a');
  expect(dayAtX(days, 400)?.day).toBe('c');
});

it('clears per-pointer state and bumps the version', () => {
  const gesture = createGesture();
  Object.assign(gesture, { pointer: 3, kind: 'days', startIndex: 2, moved: true, changed: true, scrubMinute: 600, days: [], version: 5 });
  clearGesture(gesture);
  expect(gesture).toMatchObject({ pointer: null, kind: 'rail', startIndex: -1, moved: false, changed: false, scrubMinute: null, days: null, version: 6 });
});
