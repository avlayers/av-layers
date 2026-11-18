import { describe, expect, it } from 'vitest';
import { buildIsobarGeoJson } from './isobars';

describe('buildIsobarGeoJson', () => {
  it('extracts 2 hPa / 4 hPa contour polylines and H/L synoptic centers from an MSLP grid', () => {
    const cols = 12, rows = 8;
    const grid = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      const ny = (r / (rows - 1)) * 2 - 1;
      for (let c = 0; c < cols; c++) {
        const nx = (c / (cols - 1)) * 2 - 1;
        const high = 12 * Math.exp(-((nx + 0.45) ** 2 + (ny + 0.1) ** 2) * 3.5);
        const low = -14 * Math.exp(-((nx - 0.45) ** 2 + (ny - 0.1) ** 2) * 3.5);
        grid[r * cols + c] = 1013 + high + low;
      }
    }

    const geo = buildIsobarGeoJson(grid, cols, rows, { west: -70, south: -35, east: -40, north: -10 }, 5.5);
    expect(geo.lines.features.length).toBeGreaterThan(4);
    expect(geo.lines.features.some(f => f.properties.major)).toBe(true);
    expect(geo.lines.features.some(f => !f.properties.major)).toBe(true);

    const kinds = geo.centers.features.map(f => f.properties.kind);
    expect(kinds).toContain('H');
    expect(kinds).toContain('L');
  });

  it('masks outside-domain NaN cells cleanly without producing NaN coordinates', () => {
    const cols = 12, rows = 8;
    const grid = new Float32Array(cols * rows).fill(Number.NaN);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < 7; c++) {
        grid[r * cols + c] = 1008 + c * 2.5 + r * 0.8;
      }
    }
    const geo = buildIsobarGeoJson(grid, cols, rows, { west: -60, south: -30, east: -40, north: -15 }, 5);
    expect(geo.lines.features.length).toBeGreaterThan(0);
    for (const feature of geo.lines.features) {
      for (const [lon, lat] of feature.geometry.coordinates) {
        expect(Number.isFinite(lon)).toBe(true);
        expect(Number.isFinite(lat)).toBe(true);
      }
    }
  });
});
