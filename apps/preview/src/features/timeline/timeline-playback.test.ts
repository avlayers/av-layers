import { afterEach, expect, it, vi } from 'vitest';
import { PLAYBACK_STEP_MS } from './timeline-model';
import { createPlayback } from './timeline-playback';

afterEach(() => { vi.useRealTimers(); });

it('advances one frame per step and finishes on reaching the last frame', () => {
  vi.useFakeTimers();
  let index = 0;
  const finish = vi.fn(() => { playback.stop(); });
  const playback = createPlayback({ atEnd: () => index >= 2, advance: () => { index++; }, finish });
  playback.start();
  expect(playback.playing).toBe(true);
  vi.advanceTimersByTime(PLAYBACK_STEP_MS);
  expect([index, finish.mock.calls.length]).toEqual([1, 0]);
  vi.advanceTimersByTime(PLAYBACK_STEP_MS);
  expect([index, finish.mock.calls.length, playback.playing]).toEqual([2, 1, false]);
  vi.advanceTimersByTime(PLAYBACK_STEP_MS * 3);
  expect(index).toBe(2);
});

it('reports whether stop cleared a running timer', () => {
  vi.useFakeTimers();
  const playback = createPlayback({ atEnd: () => false, advance: () => {}, finish: () => {} });
  expect(playback.stop()).toBe(false);
  playback.start();
  expect(playback.stop()).toBe(true);
  expect(playback.playing).toBe(false);
});
