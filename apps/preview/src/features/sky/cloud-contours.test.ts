import { describe, expect, it } from 'vitest';
import { buildCloudContourGeoJson, CLOUD_CONTOUR_LEVELS } from './cloud-layer';
import type { SynopticField } from './synoptic-sampler';

const cols = 8, rows = 6;
function field(total: (c: number, r: number) => number, low: (c: number, r: number) => number = () => Number.NaN): SynopticField {
  const t = new Float32Array(cols * rows), l = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { t[r * cols + c] = total(c, r); l[r * cols + c] = low(c, r); }
  return { id: 'f', buildId: 'b', frame: 'f0', cols, rows, west: 0, south: 0, east: 10, north: 8, total: t, low: l, mslp: new Float32Array(cols * rows), hasClouds: true, hasMslp: false };
}
const ramp = (c: number) => c / (cols - 1);

describe('cloud contours', () => {
  it('draw total cloud at the shared 65 % and 85 % sky-cover tiers', () => {
    expect(CLOUD_CONTOUR_LEVELS.map(level => level.percent)).toEqual([65, 85]);
    const tiers = new Set(buildCloudContourGeoJson(field(ramp)).features.map(f => f.properties.tier));
    expect([...tiers].sort()).toEqual(['broken', 'overcast']);
  });

  it('follow total cloud whatever the low cloud is', () => {
    const withLow = buildCloudContourGeoJson(field(ramp, () => 0.9));
    const withoutLow = buildCloudContourGeoJson(field(ramp));
    expect(withLow).toEqual(withoutLow);
  });

  it('draw high-only cloud with no low cloud', () => {
    expect(buildCloudContourGeoJson(field(ramp, () => 0)).features.length).toBeGreaterThan(0);
  });

  it('draw nothing through unknown total cloud', () => {
    const unknownEast = field(c => c >= 4 ? Number.NaN : 0.95 - c * 0.3);
    for (const feature of buildCloudContourGeoJson(unknownEast).features) {
      for (const [lon] of feature.geometry.coordinates) expect(lon).toBeLessThan(10 * 3 / 7 + 1e-6);
    }
  });
});
