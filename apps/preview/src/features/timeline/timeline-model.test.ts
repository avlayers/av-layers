import { describe, expect, it } from 'vitest';
import { frameIndexFor } from './timeline-model';

const frames = [
  { validTime: '2026-01-01T09:00:00.000Z' },
  { validTime: '2026-01-01T12:00:00.000Z' },
  { validTime: '2026-01-01T15:00:00.000Z' }
];

describe('frameIndexFor', () => {
  it('prefers an exact requested time', () => {
    expect(frameIndexFor(frames, frames[1]!.validTime, Date.parse('2026-01-01T00:00:00Z'))).toBe(1);
  });

  it('chooses the nearest requested time', () => {
    expect(frameIndexFor(frames, '2026-01-01T13:00:00.000Z', 0)).toBe(1);
    expect(frameIndexFor(frames, '2026-01-01T14:00:00.000Z', 0)).toBe(2);
  });

  it('falls back to the latest frame at or before now', () => {
    expect(frameIndexFor(frames, null, Date.parse('2026-01-01T13:30:00Z'))).toBe(1);
    expect(frameIndexFor(frames, null, Date.parse('2026-01-02T00:00:00Z'))).toBe(2);
  });
});
