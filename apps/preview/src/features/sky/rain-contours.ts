import { contourLines, type GeoPt } from './contours';
import { invMercY } from './mercator';
import type { PrecipField } from './precip-field';

const SHOWER_CONTOUR_MMH = 0.65;
const SQUALL_CONTOUR_MMH = 8.0;
const CONTOUR_COLS = 80;
const CONTOUR_ROWS = 80;

export interface RainContourGeoJson {
  readonly type: 'FeatureCollection';
  readonly features: Array<{
    readonly type: 'Feature';
    readonly properties: { readonly tier: 'shower' | 'squall'; readonly mmh: number };
    readonly geometry: { readonly type: 'LineString'; readonly coordinates: Array<[number, number]> };
  }>;
}

/** Extracts oriented storm-cell perimeter contours: a crisp dry-halo perimeter plus the squall core. */
export function buildRainContourGeoJson(field: PrecipField): RainContourGeoJson {
  if (field.maxMmh < SHOWER_CONTOUR_MMH || field.cols < 2 || field.rows < 2) {
    return { type: 'FeatureCollection', features: [] };
  }
  const cols = Math.min(CONTOUR_COLS, field.cols);
  const rows = Math.min(CONTOUR_ROWS, field.rows);
  const grid = new Float32Array(cols * rows);
  for (let y = 0; y < rows; y++) {
    const sy = (y / (rows - 1)) * (field.rows - 1);
    const y0 = sy | 0, y1 = Math.min(field.rows - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < cols; x++) {
      const sx = (x / (cols - 1)) * (field.cols - 1);
      const x0 = sx | 0, x1 = Math.min(field.cols - 1, x0 + 1), fx = sx - x0;
      const v00 = field.mmh[y0 * field.cols + x0]!;
      const v10 = field.mmh[y0 * field.cols + x1]!;
      const v01 = field.mmh[y1 * field.cols + x0]!;
      const v11 = field.mmh[y1 * field.cols + x1]!;
      grid[y * cols + x] = (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
    }
  }

  const toGeo = (gx: number, gy: number): GeoPt => {
    const lon = field.west + (gx / (cols - 1)) * (field.east - field.west);
    const my = field.yNorth - (gy / (rows - 1)) * (field.yNorth - field.ySouth);
    return [lon, invMercY(my)];
  };

  const features: RainContourGeoJson['features'] = [];

  const levels: ReadonlyArray<{ tier: 'shower' | 'squall'; mmh: number }> = [
    { tier: 'shower', mmh: SHOWER_CONTOUR_MMH },
    { tier: 'squall', mmh: SQUALL_CONTOUR_MMH }
  ];

  for (const { tier, mmh } of levels) {
    if (field.maxMmh < mmh) continue;
    const rings = contourLines(grid, cols, rows, mmh, toGeo, { minVertices: 4 });
    for (const ring of rings) {
      features.push({
        type: 'Feature',
        properties: { tier, mmh },
        geometry: { type: 'LineString', coordinates: ring }
      });
    }
  }
  return { type: 'FeatureCollection', features };
}
