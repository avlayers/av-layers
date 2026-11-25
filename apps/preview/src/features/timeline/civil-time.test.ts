import { describe, expect, it } from 'vitest';
import { formatZoneTime, zoneDateKey } from '@av/client';
import { localDayGroups, localTimeFromMs } from './day-scale';

const hourly = (startIso: string, hours: number) =>
  Array.from({ length: hours }, (_, i) => ({ id: `h${i}`, validTime: new Date(Date.parse(startIso) + i * 3_600_000).toISOString() }));

describe('civil time on the map clock', () => {
  it('shows Yerevan at UTC+4', () => {
    expect(formatZoneTime(Date.parse('2026-11-25T09:00:00Z'), 'Asia/Yerevan', 'clock')).toMatch(/^13:00/);
  });

  it.each([
    ['America/New_York', '2026-07-01T12:00:00Z', '08:00'],
    ['America/New_York', '2026-12-01T12:00:00Z', '07:00'],
    ['Pacific/Auckland', '2026-01-10T00:00:00Z', '13:00'],
    ['Asia/Kolkata', '2026-11-25T00:00:00Z', '05:30'],
    ['UTC', '2026-11-25T00:00:00Z', '00:00']
  ])('uses the offset of each instant in %s', (zone, iso, clock) => {
    expect(formatZoneTime(Date.parse(iso), zone, 'clock').slice(0, 5)).toBe(clock);
  });

  it('groups a 25-hour fall-back day into one local day without losing frames', () => {
    const frames = hourly('2026-11-01T04:00:00Z', 25);
    const groups = localDayGroups(frames, 'America/New_York');
    expect(groups.map(g => g.day)).toEqual(['2026-11-01']);
    expect(groups[0]!.indices).toHaveLength(25);
    const clocks = frames.map(f => localTimeFromMs(Date.parse(f.validTime), 'America/New_York')!.hour);
    expect(clocks.slice(0, 4)).toEqual([0, 1, 1, 2]);
  });

  it('groups a 23-hour spring-forward day', () => {
    const frames = hourly('2026-03-08T05:00:00Z', 23);
    expect(localDayGroups(frames, 'America/New_York').map(g => [g.day, g.indices.length])).toEqual([['2026-03-08', 23]]);
  });

  it('keeps the local date of a UTC instant stable across a zone change', () => {
    const ms = Date.parse('2026-11-25T21:30:00Z');
    expect(zoneDateKey(ms, 'Asia/Yerevan')).toBe('2026-11-26');
    expect(zoneDateKey(ms, 'America/New_York')).toBe('2026-11-25');
  });
});
