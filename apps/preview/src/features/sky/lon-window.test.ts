import { describe, expect, it } from 'vitest';
import { alignedTo, lonWindow } from './lon-window';
import { scaleAdaptiveSampleBox, synopticFieldCoversView } from './synoptic-sampler';

describe('lonWindow', () => {
  it.each([
    [170, 190, -190, -170],
    [181, 191, -179, -169],
    [-191, -181, 169, 179],
    [530, 540, 170, 180],
    [-20, 10, -20, 10]
  ])('keeps %s..%s as one span with its centre inside ±180 (%s..%s)', (west, east, w, e) => {
    const window = lonWindow(west, 10, east, 20);
    expect(window.west).toBeCloseTo(w);
    expect(window.east).toBeCloseTo(e);
  });

  it('treats a world-spanning view as the whole world and clamps latitude', () => {
    expect(lonWindow(-400, -89, 400, 89)).toEqual({ west: -180, south: -85.05112878, east: 180, north: 85.05112878 });
  });

  it('pads across the seam without clamping at 180°', () => {
    const box = scaleAdaptiveSampleBox(lonWindow(175, 0, 185, 10));
    expect(box.east - box.west).toBeGreaterThan(10);
    expect((box.west + box.east) / 2).toBeCloseTo(-180);
  });

  it('gives equivalent ±360° views the same cache key', () => {
    const a = scaleAdaptiveSampleBox(lonWindow(10, 40, 20, 50));
    const b = scaleAdaptiveSampleBox(lonWindow(370, 40, 380, 50));
    const c = scaleAdaptiveSampleBox(lonWindow(-350, 40, -340, 50));
    expect(b.key).toBe(a.key);
    expect(c.key).toBe(a.key);
  });

  it('finds a cached field across the seam from either side', () => {
    const field = scaleAdaptiveSampleBox(lonWindow(172, 0, 188, 10));
    expect(synopticFieldCoversView(field, lonWindow(174, 2, 186, 8))).toBe(true);
    expect(synopticFieldCoversView(field, lonWindow(-186, 2, -174, 8))).toBe(true);
    expect(synopticFieldCoversView(field, lonWindow(10, 2, 22, 8))).toBe(false);
  });

  it('aligns a view to a reference by whole turns only', () => {
    expect(alignedTo({ west: -179, south: 0, east: -170, north: 1 }, { west: 170, south: 0, east: 200, north: 1 }).west).toBe(181);
  });
});
