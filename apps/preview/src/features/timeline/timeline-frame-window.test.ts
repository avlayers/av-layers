import { expect, it } from 'vitest';
import { createFrameWindow } from './timeline-frame-window';

const frames = ['2026-03-13T09:00:00Z', '2026-03-13T18:00:00Z', '2026-03-15T09:00:00Z'].map((validTime, index) => ({ id: `f${index}`, validTime }));

it('groups local days with gap days and steps to the next day that has frames', () => {
  const win = createFrameWindow({});
  win.setFrames(frames);
  expect(win.syncDays()).toBe(true);
  expect(win.syncDays()).toBe(false);
  expect(win.days.map(group => [group.day, group.indices])).toEqual([['2026-03-13', [0, 1]], ['2026-03-14', []], ['2026-03-15', [2]]]);
  win.selectedIndex = 1;
  expect(win.selectedMinute()).toBe(18 * 60);
  expect(win.adjacentGroup(1)?.day).toBe('2026-03-15');
  expect(win.adjacentGroup(-1)).toBeUndefined();
});

it('matches frames by id and valid time, and bumps the revision on replace', () => {
  const win = createFrameWindow({});
  expect(win.off()).toBe(true);
  win.setFrames(frames);
  expect(win.revision).toBe(1);
  expect(win.sameFrames(frames.map(frame => ({ ...frame })))).toBe(true);
  expect(win.sameFrames([...frames.slice(0, 2), { id: 'f2', validTime: '2026-03-15T12:00:00Z' }])).toBe(false);
  expect(win.off()).toBe(false);
  win.disabled = true;
  expect(win.off()).toBe(true);
});

it('ignores repeat offsets and centres that round to the same 0.01 degree', () => {
  const win = createFrameWindow({ latitude: 47.001, longitude: 8.002 });
  expect(win.centerKey()).toBe('47.00|8.00');
  expect(win.setCenter(47.004, 8.001)).toBe(false);
  expect(win.setCenter(91, 8)).toBe(false);
  expect(win.setCenter(47.02, 8)).toBe(true);
  expect(win.setOffsetMinutes(0)).toBe(false);
  expect(win.setOffsetMinutes(60)).toBe(true);
  expect(createFrameWindow({}).centerKey()).toBe('|');
  expect(createFrameWindow({}).daySolar('2026-03-13')).toEqual({ stops: null, bounds: null });
});
