import { describe, expect, it } from 'vitest';
import { findBestSoaringDayKey } from './point-view-mode.ts';

describe('findBestSoaringDayKey with missing inputs', () => {
  const days = ['d1', 'd2'];
  const hours = new Map(days.map(day => [day, [{ validAt: `${day}T12` }]]));
  const rank = (d1: Partial<{ terrainM: number | null; surfaceWindMps: number | null }>, d2: Partial<{ terrainM: number | null; surfaceWindMps: number | null }>) =>
    findBestSoaringDayKey(days, hours, new Map([
      ['d1T12', { usableLiftTopM: 3000, terrainM: 1000, thermalVelocityMps: 2, surfaceWindMps: 6, ...d1 }],
      ['d2T12', { usableLiftTopM: 3000, terrainM: 1000, thermalVelocityMps: 2, surfaceWindMps: 6, ...d2 }]
    ]));

  it('does not let missing surface wind beat a known moderate wind', () => {
    expect(rank({ surfaceWindMps: 6 }, { surfaceWindMps: null })).toBe('d1');
    expect(rank({ surfaceWindMps: null }, { surfaceWindMps: 6 })).toBe('d2');
  });

  it('does not count MSL height as depth when terrain is missing', () => {
    expect(rank({}, { terrainM: null })).toBe('d1');
    expect(rank({ terrainM: null }, {})).toBe('d2');
  });
});
