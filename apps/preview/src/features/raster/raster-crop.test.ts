import { describe, expect, it } from 'vitest';
import { boundsAreaKm2, createViewportWarmth, fullHorizonFor } from '../map/viewport-policy';
import { canonicalTileX, planRasterCrop, requiredSourceZoom } from './raster-crop';

const ARMENIA: [number, number, number, number] = [44.27798057856188, 40.104612670852696, 44.72201942143812, 40.29538732914732];

describe('viewport area policy', () => {
  it('computes the 800 km² Armenia rectangle from spherical geometry', () => {
    expect(boundsAreaKm2(ARMENIA)).toBeCloseTo(800, 6);
  });

  it('keeps a full-world longitude span instead of normalizing it to zero', () => {
    const area = boundsAreaKm2([-180, -85, 180, 85]);
    expect(area).toBeGreaterThan(300_000_000);
  });

  it('treats a dateline crossing rectangle as its shorter coherent span', () => {
    const area = boundsAreaKm2([170, -10, -170, 10]);
    expect(area).toBeGreaterThan(0);
    expect(area).toBeLessThan(boundsAreaKm2([-180, -10, 180, 10])!);
  });

  it('rejects nonfinite and degenerate geometry', () => {
    expect(boundsAreaKm2([0, 10, 1, 10])).toBeNull();
    expect(boundsAreaKm2([0, 10, 1, 9])).toBeNull();
    expect(boundsAreaKm2([0, Number.NaN, 1, 2])).toBeNull();
    expect(boundsAreaKm2([0, 0, 0, 10])).toBeNull();
  });

  it('applies the 800/1000 km² hysteresis band with boundary epsilon', () => {
    const warmth = createViewportWarmth();
    expect(warmth.update(801)).toBe(false);
    expect(warmth.update(799)).toBe(true);
    expect(warmth.update(999)).toBe(true);
    expect(warmth.update(1001)).toBe(false);
    expect(warmth.update(799.9999999)).toBe(true);
    expect(fullHorizonFor(800.0000000000045, false)).toBe(true);
    expect(fullHorizonFor(1000.0001, true)).toBe(false);
  });
});

describe('native raster crop', () => {
  it('matches the Armenia native-z10 fixture including margin and gutter', () => {
    const crop = planRasterCrop(ARMENIA, 10)!;
    expect(crop.visiblePixelSize).toEqual([324, 183]);
    expect([crop.retainedPixelSize[0] - 2, crop.retainedPixelSize[1] - 2]).toEqual([389, 219]);
    expect(crop.retainedPixelSize).toEqual([391, 221]);
    expect(crop.bytes).toBe(391 * 221 * 4);
    expect(crop.bytes * 48 / (1024 * 1024)).toBeCloseTo(15.8223, 4);
    expect(crop.tiles.length).toBeGreaterThan(0);
    expect(crop.tiles.every(tile => tile.drawX > -256 && tile.drawX < crop.width && tile.drawY > -256 && tile.drawY < crop.height)).toBe(true);
    expect(crop.tiles.every(tile => tile.canonicalX >= 0 && tile.canonicalX < 2 ** crop.zoom)).toBe(true);
  });

  it('keeps canonical URLs and coherent coordinates across the dateline', () => {
    const crop = planRasterCrop([170, -20, -170, 20], 3)!;
    expect(crop.tiles.every(tile => tile.canonicalX >= 0 && tile.canonicalX < 8)).toBe(true);
    expect(crop.tiles.some(tile => tile.x < 0 || tile.x >= 8)).toBe(true);
    const west = crop.coordinates[0][0], east = crop.coordinates[1][0];
    expect(east - west).toBeGreaterThan(0);
    expect((west + east) / 2).toBeGreaterThanOrEqual(-180);
    expect((west + east) / 2).toBeLessThan(180);
  });

  it('covers a full-world view without collapsing longitude', () => {
    const crop = planRasterCrop([-180, -85, 180, 85], 0)!;
    expect(crop.coordinates[1][0] - crop.coordinates[0][0]).toBeGreaterThanOrEqual(360);
    expect(crop.width).toBeGreaterThanOrEqual(256);
    expect(crop.tiles.length).toBeGreaterThan(0);
  });

  it('selects the highest canonical zoom from covering tiles', () => {
    expect(requiredSourceZoom([])).toBeNull();
    expect(requiredSourceZoom([{ z: 7 }, { z: 10 }, { z: 9 }])).toBe(10);
  });

  it('wraps canonical tile columns and rejects impossible crops', () => {
    expect(canonicalTileX(-1, 3)).toBe(7);
    expect(canonicalTileX(8, 3)).toBe(0);
    expect(planRasterCrop(ARMENIA, 10, { tileSize: 0 })).toBeNull();
    expect(planRasterCrop(ARMENIA, -1)).toBeNull();
    expect(planRasterCrop([Number.NaN, 0, 1, 1], 5)).toBeNull();
  });
});
