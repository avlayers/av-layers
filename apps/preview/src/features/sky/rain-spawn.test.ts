import { describe, expect, it } from 'vitest';
import { mercY } from './mercator';
import type { PrecipField } from './precip-field';
import { buildViewportSpawnDistribution, pickFromCdf, rainVisualProfileForMmh } from './rain-spawn';

function gridField(cols: number, rows: number, mmh: number[]): PrecipField {
  const values = Float32Array.from(mmh);
  const wet = mmh.flatMap((v, i) => (v >= 0.15 ? [i] : []));
  return {
    key: 'grid',
    cols,
    rows,
    west: 0,
    south: 0,
    east: cols,
    north: rows,
    yNorth: mercY(rows),
    ySouth: mercY(0),
    mmh: values,
    maxMmh: Math.max(...mmh),
    wetFraction: wet.length / mmh.length,
    wetIndices: Uint32Array.from(wet),
    wetCdf: new Float32Array(wet.length)
  };
}

describe('buildViewportSpawnDistribution', () => {
  // 4x2 grid: row 0 = [0, 1, 0, 9], row 1 = [0.1, 1, 0, 0]
  const field = gridField(4, 2, [0, 1, 0, 9, 0.1, 1, 0, 0]);

  it('lists only wet cells, weights them by rate, and ends the CDF at 1', () => {
    const dist = buildViewportSpawnDistribution(field, { west: 0, south: 0, east: 4, north: 2 });
    expect(Array.from(dist.indices)).toEqual([1, 3, 5]);
    expect(dist.cdf[2]).toBe(1);
    const step = (i: number) => dist.cdf[i]! - (i > 0 ? dist.cdf[i - 1]! : 0);
    expect(step(1)).toBeGreaterThan(step(0) * 5);
    expect(step(0)).toBeCloseTo(step(2), 6);
    expect(dist.peakVisibleMmh).toBe(9);
    expect(dist.meanWetMmh).toBeCloseTo(11 / 3, 6);
    expect(dist.visibleWetFraction).toBeCloseTo(3 / 8, 6);
  });

  it('clips to the viewport columns', () => {
    const dist = buildViewportSpawnDistribution(field, { west: 0, south: 0, east: 1.5, north: 2 });
    expect(Array.from(dist.indices)).toEqual([1, 5]);
    expect(dist.peakVisibleMmh).toBe(1);
  });

  it('is empty for a dry field or a viewport outside the field', () => {
    const dry = gridField(2, 2, [0, 0, 0, 0]);
    expect(buildViewportSpawnDistribution(dry, { west: 0, south: 0, east: 2, north: 2 }).indices.length).toBe(0);
    const away = buildViewportSpawnDistribution(field, { west: 20, south: 0, east: 30, north: 2 });
    expect(away.indices.length).toBe(0);
    expect(away.visibleWetFraction).toBe(0);
  });
});

describe('pickFromCdf', () => {
  const cdf = Float32Array.from([0.1, 0.5, 1]);
  const indices = Uint32Array.from([7, 8, 9]);

  it('returns the first cell whose cumulative weight reaches u', () => {
    expect(pickFromCdf(cdf, indices, 0)).toBe(7);
    expect(pickFromCdf(cdf, indices, 0.1)).toBe(7);
    expect(pickFromCdf(cdf, indices, 0.11)).toBe(8);
    expect(pickFromCdf(cdf, indices, 0.99)).toBe(9);
  });
});

describe('rainVisualProfileForMmh', () => {
  it('steps tiers at 1, 4 and 10 mm/h', () => {
    expect([0.5, 1, 4, 10].map(v => rainVisualProfileForMmh(v).tier)).toEqual([0, 1, 2, 3]);
  });
});
