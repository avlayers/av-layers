import { expect, it, vi } from 'vitest';
import { createFrameWindow } from './timeline-frame-window';
import * as solarDay from './solar-day';

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
  expect(win.setTimeZone('UTC')).toBe(false);
  expect(win.setTimeZone('Etc/GMT-1')).toBe(true);
  expect(createFrameWindow({}).centerKey()).toBe('|');
  expect(createFrameWindow({}).daySolar('2026-03-13')).toEqual({ stops: null, bounds: null });
});

it.each([
  ['America/Los_Angeles', '2026-03-08', '2026-03-08T08:00:00Z', '2026-03-09T07:00:00Z'],
  ['America/Los_Angeles', '2026-11-01', '2026-11-01T07:00:00Z', '2026-11-02T08:00:00Z'],
  ['Europe/Berlin', '2026-03-29', '2026-03-28T23:00:00Z', '2026-03-29T22:00:00Z'],
  ['Pacific/Auckland', '2026-09-27', '2026-09-26T12:00:00Z', '2026-09-27T11:00:00Z']
])('runs the %s ribbon from local midnight to local midnight on the DST day %s', (timeZone, day, start, end) => {
  const ribbon = vi.spyOn(solarDay, 'solarRibbonStops');
  const win = createFrameWindow({ latitude: 40, longitude: 0, timeZone });
  win.daySolar(day);
  expect(ribbon).toHaveBeenLastCalledWith(40, 0, Date.parse(start), Date.parse(end));
  ribbon.mockRestore();
});

it('places ribbon stops at their local clock time on a 25-hour day', () => {
  const win = createFrameWindow({ latitude: 47.4, longitude: 8.5, timeZone: 'Europe/Zurich' });
  const stops = win.daySolar('2026-10-25').stops!;
  const linear = solarDay.solarRibbonStops(47.4, 8.5, Date.parse('2026-10-24T22:00:00Z'), Date.parse('2026-10-25T23:00:00Z'))!;
  const noon = stops[Math.round(stops.length / 2)]!.at, elapsedNoon = linear[Math.round(linear.length / 2)]!.at;
  expect(noon).toBeLessThan(elapsedNoon);
  expect(stops.at(-1)!.at).toBe(100);
  expect(stops.every((stop, i) => i === 0 || stop.at >= stops[i - 1]!.at)).toBe(true);
});
