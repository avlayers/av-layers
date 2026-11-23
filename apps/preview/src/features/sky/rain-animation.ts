import type { Map as MapLibreMap } from 'maplibre-gl';
import { RAIN_COLORS, RAIN_EDGES } from '@av/contracts/layers';
import type { RainStyleId, ResolvedChannelStyles } from '../map/channel-styles';
import {
  buildInwardTickSegments,
  buildScallopedPolyline,
  extractOrientedContours,
  type GeoPt
} from './contour-rings';

const LUT_SIZE = 32_768;
const MAX_COLOR_DIST_SQ = 1_200;
const MAX_LAT = 85.05112878;
const DEG = Math.PI / 180;
export const MIN_RAIN_MMH = 0.15;
export const RAIN_CUFF_EDGE_MMH = 0.65;
const SHOWER_CONTOUR_MMH = 0.65;
const SQUALL_CONTOUR_MMH = 8.0;

const CONTOUR_COLS = 80;
const CONTOUR_ROWS = 80;
const MAX_DROPS = 2_500;
const MAX_SPLASHES = 100;
const SLANT_TAN = 0.25;

const SPRITE_TIERS = 4;
const SPRITE_CELL_W = 36;
const SPRITE_CELL_H = 72;

const WEIGHT_LUT_MAX_MMH = 64;
const WEIGHT_LUT_SIZE = 1_280;

export interface PrecipBounds {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

export interface PrecipField {
  readonly key: string;
  readonly cols: number;
  readonly rows: number;
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
  readonly yNorth: number;
  readonly ySouth: number;
  readonly mmh: Float32Array;
  readonly cellWeights?: Float32Array;
  readonly maxMmh: number;
  readonly wetFraction: number;
  readonly wetIndices: Uint32Array;
  readonly wetCdf: Float32Array;
}

export interface ViewportSpawnDistribution {
  readonly indices: Uint32Array;
  readonly cdf: Float32Array;
  readonly visibleWetFraction: number;
  readonly meanWetMmh: number;
  readonly peakVisibleMmh: number;
}

export interface RainContourGeoJson {
  readonly type: 'FeatureCollection';
  readonly features: Array<{
    readonly type: 'Feature';
    readonly properties: { readonly tier: 'shower' | 'squall' | 'tick'; readonly mmh: number };
    readonly geometry: { readonly type: 'LineString'; readonly coordinates: Array<[number, number]> };
  }>;
}

let rainRgb555Lut: Float32Array | null = null;
let pow092Lut: Float32Array | null = null;
let spriteAtlasCanvas: HTMLCanvasElement | OffscreenCanvas | null = null;

function mercY(lat: number): number {
  const clamped = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  return Math.asinh(Math.tan(clamped * DEG));
}

function invMercY(my: number): number {
  return Math.atan(Math.sinh(my)) / DEG;
}

function mmhWeight(v: number): number {
  if (v <= 0) return 0;
  if (!pow092Lut) {
    const lut = new Float32Array(WEIGHT_LUT_SIZE + 1);
    for (let i = 0; i <= WEIGHT_LUT_SIZE; i++) {
      lut[i] = Math.pow((i / WEIGHT_LUT_SIZE) * WEIGHT_LUT_MAX_MMH, 0.92);
    }
    pow092Lut = lut;
  }
  if (v >= WEIGHT_LUT_MAX_MMH) return Math.pow(v, 0.92);
  const idx = ((v * (WEIGHT_LUT_SIZE / WEIGHT_LUT_MAX_MMH)) + 0.5) | 0;
  return pow092Lut[idx]!;
}

function getRainRgb555Lut(): Float32Array {
  if (rainRgb555Lut) return rainRgb555Lut;
  const lut = new Float32Array(LUT_SIZE).fill(0);
  const rgb = RAIN_COLORS.map(hex => {
    const clean = hex.startsWith('#') ? hex.slice(1) : hex;
    return [
      Number.parseInt(clean.slice(0, 2), 16),
      Number.parseInt(clean.slice(2, 4), 16),
      Number.parseInt(clean.slice(4, 6), 16)
    ] as const;
  });
  const midpoints = RAIN_COLORS.map((_, i) => {
    const lo = RAIN_EDGES[i] ?? 0.1;
    const hi = RAIN_EDGES[i + 1] ?? (lo + 20);
    return (lo + hi) * 0.5;
  });
  for (let r5 = 0; r5 < 32; r5++) {
    const r = (r5 << 3) | (r5 >> 2);
    for (let g5 = 0; g5 < 32; g5++) {
      const g = (g5 << 3) | (g5 >> 2);
      for (let b5 = 0; b5 < 32; b5++) {
        const b = (b5 << 3) | (b5 >> 2);
        let bestIdx = -1;
        let bestDist = MAX_COLOR_DIST_SQ + 1;
        for (let i = 0; i < rgb.length; i++) {
          const [cr, cg, cb] = rgb[i]!;
          const dr = r - cr, dg = g - cg, db = b - cb;
          const dist = dr * dr + dg * dg + db * db;
          if (dist < bestDist) { bestDist = dist; bestIdx = i; }
        }
        if (bestIdx >= 0 && bestDist <= MAX_COLOR_DIST_SQ) {
          lut[(r5 << 10) | (g5 << 5) | b5] = midpoints[bestIdx]!;
        }
      }
    }
  }
  rainRgb555Lut = lut;
  return lut;
}

/**
 * Decodes server `precip-rate` RGBA pixels (in Web Mercator Y) into a smoothed `mm/h` field
 * with a precomputed `cellWeights` (`mmh^0.92`) CDF so heavy rain cores concentrate drops realistically.
 */
export function decodePrecipRgbaToField(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  bounds: PrecipBounds,
  key = ''
): PrecipField {
  const cols = Math.max(2, Math.min(224, width));
  const rows = Math.max(2, Math.min(224, height));
  const lut = getRainRgb555Lut();
  const raw = new Float32Array(cols * rows);

  for (let r = 0; r < rows; r++) {
    const sy = Math.min(height - 1, Math.floor(((r + 0.5) / rows) * height));
    const dstRow = r * cols;
    for (let c = 0; c < cols; c++) {
      const sx = Math.min(width - 1, Math.floor(((c + 0.5) / cols) * width));
      const off = (sy * width + sx) * 4;
      const a = pixels[off + 3]!;
      if (a < 24) continue;
      const rgbKey = ((pixels[off]! >> 3) << 10) | ((pixels[off + 1]! >> 3) << 5) | (pixels[off + 2]! >> 3);
      raw[dstRow + c] = lut[rgbKey]! * (a / 255);
    }
  }

  // Two-pass separable 1-2-1 smoothing for organic storm boundaries & smooth inward cuffs
  const tmp = new Float32Array(cols * rows);
  const mmh = new Float32Array(cols * rows);
  let src = raw;
  for (let pass = 0; pass < 2; pass++) {
    for (let r = 0; r < rows; r++) {
      const row = r * cols;
      for (let c = 0; c < cols; c++) {
        const i = row + c;
        const l = c > 0 ? i - 1 : i;
        const rt = c + 1 < cols ? i + 1 : i;
        tmp[i] = (src[l]! + 2 * src[i]! + src[rt]!) * 0.25;
      }
    }
    for (let r = 0; r < rows; r++) {
      const row = r * cols;
      const up = r > 0 ? row - cols : row;
      const dn = r + 1 < rows ? row + cols : row;
      for (let c = 0; c < cols; c++) {
        const i = row + c;
        mmh[i] = (tmp[up + c]! + 2 * tmp[i]! + tmp[dn + c]!) * 0.25;
      }
    }
    src = mmh;
  }

  const cellWeights = new Float32Array(mmh.length);
  let maxMmh = 0;
  let wetCount = 0;
  for (let i = 0; i < mmh.length; i++) {
    const v = mmh[i]!;
    if (v > maxMmh) maxMmh = v;
    if (v >= MIN_RAIN_MMH) {
      wetCount++;
      cellWeights[i] = mmhWeight(v);
    }
  }

  const wetIndices = new Uint32Array(wetCount);
  const wetCdf = new Float32Array(wetCount);
  let totalWeight = 0;
  let cursor = 0;
  for (let i = 0; i < mmh.length; i++) {
    const w = cellWeights[i]!;
    if (w > 0) {
      wetIndices[cursor] = i;
      totalWeight += w;
      wetCdf[cursor] = totalWeight;
      cursor++;
    }
  }
  if (totalWeight > 0) {
    const inv = 1 / totalWeight;
    for (let i = 0; i < wetCount; i++) wetCdf[i] = wetCdf[i]! * inv;
    wetCdf[wetCount - 1] = 1;
  }

  return {
    key,
    cols,
    rows,
    west: bounds.west,
    south: bounds.south,
    east: bounds.east,
    north: bounds.north,
    yNorth: mercY(bounds.north),
    ySouth: mercY(bounds.south),
    mmh,
    cellWeights,
    maxMmh,
    wetFraction: mmh.length > 0 ? wetCount / mmh.length : 0,
    wetIndices,
    wetCdf
  };
}

/**
 * Computes #1 Asymmetric Inner Vignette Cuff RGBA image via a fast 2-pass Chamfer 3-4 distance transform.
 * Dry exterior pixels stay 100% transparent (`alpha = 0`), while wet edge pixels bleed smoothly inward
 * over `cuffCells` and fade completely to transparent in the interior so lift colors remain vivid!
 */
export function renderRainInnerVignetteRgba(
  field: PrecipField,
  styles: ResolvedChannelStyles,
  outData: Uint8ClampedArray
): boolean {
  const { cols, rows, mmh } = field;
  const n = cols * rows;
  if (field.maxMmh < RAIN_CUFF_EDGE_MMH || outData.length < n * 4) {
    outData.fill(0);
    return false;
  }

  const INF = 30_000;
  const dist = new Uint16Array(n);
  let anyWet = false;
  let anyDry = false;
  for (let i = 0; i < n; i++) {
    if (mmh[i]! >= RAIN_CUFF_EDGE_MMH) {
      dist[i] = INF;
      anyWet = true;
    } else {
      dist[i] = 0;
      anyDry = true;
    }
  }
  if (!anyWet || !anyDry) {
    outData.fill(0);
    return false;
  }

  // Forward Chamfer 3-4 pass
  for (let y = 0; y < rows; y++) {
    const row = y * cols;
    for (let x = 0; x < cols; x++) {
      const i = row + x;
      let d = dist[i]!;
      if (d === 0) continue;
      if (x > 0 && dist[i - 1]! + 3 < d) d = dist[i - 1]! + 3;
      if (y > 0) {
        const up = i - cols;
        if (dist[up]! + 3 < d) d = dist[up]! + 3;
        if (x > 0 && dist[up - 1]! + 4 < d) d = dist[up - 1]! + 4;
        if (x + 1 < cols && dist[up + 1]! + 4 < d) d = dist[up + 1]! + 4;
      }
      dist[i] = d;
    }
  }

  // Backward Chamfer 3-4 pass
  for (let y = rows - 1; y >= 0; y--) {
    const row = y * cols;
    for (let x = cols - 1; x >= 0; x--) {
      const i = row + x;
      let d = dist[i]!;
      if (d === 0) continue;
      if (x + 1 < cols && dist[i + 1]! + 3 < d) d = dist[i + 1]! + 3;
      if (y + 1 < rows) {
        const dn = i + cols;
        if (dist[dn]! + 3 < d) d = dist[dn]! + 3;
        if (x + 1 < cols && dist[dn + 1]! + 4 < d) d = dist[dn + 1]! + 4;
        if (x > 0 && dist[dn - 1]! + 4 < d) d = dist[dn - 1]! + 4;
      }
      dist[i] = d;
    }
  }

  const [cr, cg, cb] = styles.rainEdge.cuffRgb;
  const style = styles.rainStyle;
  const cuffCells = style === 'vignette-cuff' ? 13.5 : style === 'wet-lens' ? 7.5 : 8.5;
  const maxAlpha = style === 'vignette-cuff'
    ? styles.rainEdge.cuffMaxAlpha
    : Math.round(styles.rainEdge.cuffMaxAlpha * 0.68);

  let maxPlacedAlpha = 0;
  for (let i = 0; i < n; i++) {
    const off = i * 4;
    const dRaw = dist[i]!;
    if (dRaw === 0) {
      outData[off] = 0;
      outData[off + 1] = 0;
      outData[off + 2] = 0;
      outData[off + 3] = 0;
      continue;
    }
    const dCells = (dRaw - 3) / 3;
    const t = Math.max(0, 1 - dCells / cuffCells);
    const cuffFade = t * t * (1.2 - 0.2 * t);
    const alpha = Math.min(132, Math.round(maxAlpha * cuffFade));
    if (alpha > maxPlacedAlpha) maxPlacedAlpha = alpha;

    outData[off] = cr;
    outData[off + 1] = cg;
    outData[off + 2] = cb;
    outData[off + 3] = alpha;
  }
  return maxPlacedAlpha > 0;
}

/**
 * Builds a viewport-clipped importance-sampling CDF so 100% of raindrops concentrate inside
 * currently visible rain cells, weighted strongly by local `mm/h` intensity (`mmh^0.92`).
 */
export function buildViewportSpawnDistribution(
  field: PrecipField,
  view: PrecipBounds
): ViewportSpawnDistribution {
  if (field.wetIndices.length === 0) {
    return { indices: new Uint32Array(0), cdf: new Float32Array(0), visibleWetFraction: 0, meanWetMmh: 0, peakVisibleMmh: 0 };
  }
  const spanLon = Math.max(1e-5, field.east - field.west);
  const spanMy = Math.max(1e-5, field.yNorth - field.ySouth);
  const c0 = Math.max(0, Math.floor(((view.west - field.west) / spanLon) * field.cols));
  const c1 = Math.min(field.cols - 1, Math.ceil(((view.east - field.west) / spanLon) * field.cols));
  const r0 = Math.max(0, Math.floor(((field.yNorth - mercY(view.north)) / spanMy) * field.rows));
  const r1 = Math.min(field.rows - 1, Math.ceil(((field.yNorth - mercY(view.south)) / spanMy) * field.rows));

  if (c1 < c0 || r1 < r0) {
    return { indices: new Uint32Array(0), cdf: new Float32Array(0), visibleWetFraction: 0, meanWetMmh: 0, peakVisibleMmh: 0 };
  }

  const totalVisibleCells = Math.max(1, (c1 - c0 + 1) * (r1 - r0 + 1));
  const weights = field.cellWeights;
  const tempIdx: number[] = [];
  let sumMmh = 0;
  let peak = 0;
  let totalWeight = 0;

  for (let r = r0; r <= r1; r++) {
    const row = r * field.cols;
    for (let c = c0; c <= c1; c++) {
      const idx = row + c;
      const v = field.mmh[idx]!;
      if (v >= MIN_RAIN_MMH) {
        const w = weights ? weights[idx]! : mmhWeight(v);
        tempIdx.push(idx);
        sumMmh += v;
        if (v > peak) peak = v;
        totalWeight += w;
      }
    }
  }

  const count = tempIdx.length;
  if (count === 0 || totalWeight <= 0) {
    return { indices: new Uint32Array(0), cdf: new Float32Array(0), visibleWetFraction: 0, meanWetMmh: 0, peakVisibleMmh: 0 };
  }

  const indices = new Uint32Array(tempIdx);
  const cdf = new Float32Array(count);
  let acc = 0;
  const inv = 1 / totalWeight;
  for (let i = 0; i < count; i++) {
    const idx = indices[i]!;
    acc += weights ? weights[idx]! : mmhWeight(field.mmh[idx]!);
    cdf[i] = acc * inv;
  }
  cdf[count - 1] = 1;

  return {
    indices,
    cdf,
    visibleWetFraction: count / totalVisibleCells,
    meanWetMmh: sumMmh / count,
    peakVisibleMmh: peak
  };
}

/**
 * Computes intensity-coupled raindrop visual parameters (`tier`, `speed`, `scale`, `alpha`)
 * from local rainfall rate (`mm/h`) so light drizzle stays airy over local labels while squalls pour.
 */
export function rainVisualProfileForMmh(mmh: number): {
  readonly tier: 0 | 1 | 2 | 3;
  readonly speedPxPerSec: number;
  readonly scale: number;
  readonly alpha: number;
} {
  if (mmh < 1.0) {
    const t = Math.max(0, (mmh - MIN_RAIN_MMH) / (1.0 - MIN_RAIN_MMH));
    return {
      tier: 0,
      speedPxPerSec: 170 + t * 80,
      scale: 0.46 + t * 0.20,
      alpha: 0.42 + t * 0.22
    };
  }
  if (mmh < 4.0) {
    const t = (mmh - 1.0) / 3.0;
    return {
      tier: 1,
      speedPxPerSec: 265 + t * 115,
      scale: 0.70 + t * 0.22,
      alpha: 0.68 + t * 0.18
    };
  }
  if (mmh < 10.0) {
    const t = (mmh - 4.0) / 6.0;
    return {
      tier: 2,
      speedPxPerSec: 390 + t * 125,
      scale: 0.94 + t * 0.24,
      alpha: 0.88 + t * 0.08
    };
  }
  const t = Math.min(1, (mmh - 10.0) / 22.0);
  return {
    tier: 3,
    speedPxPerSec: 525 + t * 130,
    scale: 1.20 + t * 0.28,
    alpha: 0.98
  };
}

/** Bilinearly samples precipitation intensity (`mm/h`) at `(lon, lat)` from a Mercator `PrecipField`. */
export function samplePrecipMmh(field: PrecipField, lon: number, lat: number, precomputedMy?: number): number {
  if (field.maxMmh < MIN_RAIN_MMH || lat < field.south || lat > field.north) return 0;
  const spanLon = field.east - field.west;
  if (spanLon <= 0) return 0;
  let dLon = lon - field.west;
  if (spanLon < 359.5) {
    dLon = ((dLon % 360) + 360) % 360;
    if (dLon > spanLon) return 0;
  } else {
    dLon = ((dLon % 360) + 360) % 360;
  }
  const u = Math.max(0, Math.min(1, dLon / spanLon));
  const my = precomputedMy ?? mercY(lat);
  const v = Math.max(0, Math.min(1, (field.yNorth - my) / Math.max(1e-6, field.yNorth - field.ySouth)));
  const gx = u * (field.cols - 1);
  const gy = v * (field.rows - 1);
  const x0 = gx | 0, y0 = gy | 0;
  const x1 = x0 + 1 < field.cols ? x0 + 1 : x0;
  const y1 = y0 + 1 < field.rows ? y0 + 1 : y0;
  const fx = gx - x0, fy = gy - y0;
  const v00 = field.mmh[y0 * field.cols + x0]!;
  const v10 = field.mmh[y0 * field.cols + x1]!;
  const v01 = field.mmh[y1 * field.cols + x0]!;
  const v11 = field.mmh[y1 * field.cols + x1]!;
  return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
}

/**
 * Extracts oriented storm-cell perimeter contours for the active `RainStyleId`:
 * - `'vignette-cuff'` (#1 default) & `'wet-lens'` (#4): smooth crisp dry-halo perimeter + squall core
 * - `'sigwx-scallop'` (#2): outward-bulging aviation SIGWX scalloped cloud arcs
 * - `'inward-comb'` (#3): perimeter contour + inward-pointing slanted rain-tick hachures
 */
export function buildRainContourGeoJson(
  field: PrecipField,
  rainStyle: RainStyleId = 'vignette-cuff',
  viewSpanDeg = Math.max(0.2, field.east - field.west)
): RainContourGeoJson {
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
  const scaleDeg = Math.max(0.015, viewSpanDeg);

  const levels: ReadonlyArray<{ tier: 'shower' | 'squall'; mmh: number }> = [
    { tier: 'shower', mmh: SHOWER_CONTOUR_MMH },
    { tier: 'squall', mmh: SQUALL_CONTOUR_MMH }
  ];

  for (const { tier, mmh } of levels) {
    if (field.maxMmh < mmh) continue;
    const rings = extractOrientedContours(grid, cols, rows, mmh, toGeo, 4);
    for (const ring of rings) {
      if (rainStyle === 'sigwx-scallop') {
        const step = tier === 'squall' ? scaleDeg * 0.018 : scaleDeg * 0.026;
        const bulge = tier === 'squall' ? step * 0.34 : step * 0.30;
        features.push({
          type: 'Feature',
          properties: { tier, mmh },
          geometry: { type: 'LineString', coordinates: buildScallopedPolyline(ring, step, bulge) }
        });
        continue;
      }

      features.push({
        type: 'Feature',
        properties: { tier, mmh },
        geometry: { type: 'LineString', coordinates: ring }
      });

      if (rainStyle === 'inward-comb') {
        const spacing = tier === 'squall' ? scaleDeg * 0.013 : scaleDeg * 0.018;
        const tickLen = tier === 'squall' ? scaleDeg * 0.011 : scaleDeg * 0.0085;
        for (const [base, tip] of buildInwardTickSegments(ring, spacing, tickLen)) {
          features.push({
            type: 'Feature',
            properties: { tier: 'tick', mmh },
            geometry: { type: 'LineString', coordinates: [base, tip] }
          });
        }
      }
    }
  }
  return { type: 'FeatureCollection', features };
}

function getRainSpriteAtlas(): HTMLCanvasElement | OffscreenCanvas | null {
  if (spriteAtlasCanvas) return spriteAtlasCanvas;
  const totalW = SPRITE_TIERS * SPRITE_CELL_W;
  const totalH = 2 * SPRITE_CELL_H;
  const canvas = typeof OffscreenCanvas === 'function'
    ? new OffscreenCanvas(totalW, totalH)
    : (typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: totalW, height: totalH }) : null);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) return null;

  const tierSpecs: ReadonlyArray<{ len: number; headR: number; caseW: number }> = [
    { len: 20, headR: 1.4, caseW: 1.4 },
    { len: 33, headR: 1.9, caseW: 1.75 },
    { len: 45, headR: 2.35, caseW: 2.05 },
    { len: 56, headR: 2.85, caseW: 2.35 }
  ];

  for (let darkRow = 0; darkRow < 2; darkRow++) {
    const isDark = darkRow === 1;
    for (let t = 0; t < SPRITE_TIERS; t++) {
      const spec = tierSpecs[t]!;
      const ox = t * SPRITE_CELL_W;
      const oy = darkRow * SPRITE_CELL_H;

      const x1 = ox + SPRITE_CELL_W * 0.64;
      const y1 = oy + SPRITE_CELL_H - 9;
      const x0 = x1 - spec.len * SLANT_TAN;
      const y0 = y1 - spec.len;

      const dx = x1 - x0, dy = y1 - y0;
      const invLen = 1 / Math.hypot(dx, dy);
      const nx = -dy * invLen, ny = dx * invLen;

      const caseGrad = ctx.createLinearGradient(x0, y0, x1, y1);
      caseGrad.addColorStop(0, 'rgba(8, 15, 28, 0)');
      caseGrad.addColorStop(0.30, isDark ? 'rgba(2, 6, 18, 0.24)' : 'rgba(15, 23, 42, 0.20)');
      caseGrad.addColorStop(0.88, isDark ? 'rgba(2, 6, 18, 0.78)' : 'rgba(12, 20, 36, 0.68)');
      caseGrad.addColorStop(1, isDark ? 'rgba(2, 6, 18, 0.84)' : 'rgba(12, 20, 36, 0.74)');

      const cr = spec.headR + spec.caseW;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1 + nx * cr, y1 + ny * cr);
      ctx.arc(x1, y1, cr, Math.atan2(ny, nx), Math.atan2(-ny, -nx), false);
      ctx.closePath();
      ctx.fillStyle = caseGrad;
      ctx.fill();

      const bodyGrad = ctx.createLinearGradient(x0, y0, x1, y1);
      bodyGrad.addColorStop(0, isDark ? 'rgba(186, 230, 253, 0)' : 'rgba(248, 252, 255, 0)');
      bodyGrad.addColorStop(0.34, isDark ? 'rgba(186, 230, 253, 0.28)' : 'rgba(241, 247, 255, 0.30)');
      bodyGrad.addColorStop(0.84, isDark ? 'rgba(224, 242, 254, 0.88)' : 'rgba(252, 254, 255, 0.92)');
      bodyGrad.addColorStop(1, 'rgba(255, 255, 255, 0.99)');

      const hr = spec.headR;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1 + nx * hr, y1 + ny * hr);
      ctx.arc(x1, y1, hr, Math.atan2(ny, nx), Math.atan2(-ny, -nx), false);
      ctx.closePath();
      ctx.fillStyle = bodyGrad;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(x1 - dx * 0.03, y1 - dy * 0.03, Math.max(0.9, hr * 0.68), 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    }
  }

  spriteAtlasCanvas = canvas;
  return canvas;
}

interface RainDrop {
  lon: number;
  lat: number;
  my: number;
  mmh: number;
  tier: 0 | 1 | 2 | 3;
  age: number;
  life: number;
  speed: number;
  scale: number;
  alpha: number;
  depth: number;
}

interface RainSplash {
  lon: number;
  lat: number;
  my: number;
  age: number;
  life: number;
  maxRx: number;
  doubleRing: boolean;
}

interface FastMercatorProjector {
  readonly cx: number;
  readonly cy: number;
  readonly cLon: number;
  readonly cMy: number;
  readonly kx: number;
  readonly ky: number;
}

function calibrateMercatorProjector(map: MapLibreMap, centerLon: number, centerLat: number): FastMercatorProjector | null {
  const clampedLat = Math.max(-80, Math.min(80, centerLat));
  const cMy = mercY(clampedLat);
  const dLon = 0.25;
  const dMy = 0.04;
  const nLat = invMercY(cMy + dMy);
  const p0 = map.project([centerLon, clampedLat]);
  const pX = map.project([centerLon + dLon, clampedLat]);
  const pY = map.project([centerLon, nLat]);
  if (Math.abs(pX.y - p0.y) > 0.35 || Math.abs(pY.x - p0.x) > 0.35) return null;

  const kx = (pX.x - p0.x) / dLon;
  const ky = (p0.y - pY.y) / dMy;
  if (!Number.isFinite(kx) || !Number.isFinite(ky) || kx <= 0 || ky <= 0) return null;

  // Probe diagonal midpoint to catch globe curvature or linear-latitude test mocks cleanly.
  const testMy = cMy - dMy * 1.5;
  const testLat = invMercY(testMy);
  const testLon = centerLon - dLon * 1.5;
  const pDiag = map.project([testLon, testLat]);
  const estX = p0.x + (testLon - centerLon) * kx;
  const estY = p0.y + (cMy - testMy) * ky;
  if (Math.abs(pDiag.x - estX) > 0.45 || Math.abs(pDiag.y - estY) > 0.45) return null;

  return { cx: p0.x, cy: p0.y, cLon: centerLon, cMy, kx, ky };
}

function pickFromCdf(cdf: Float32Array, indices: Uint32Array, u: number): number {
  let lo = 0, hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cdf[mid]! < u) lo = mid + 1;
    else hi = mid;
  }
  return indices[lo]!;
}

/**
 * Screen-space 60 fps particle renderer for tapered optical raindrops and downpour splash ripples.
 */
export class RainAnimator {
  private readonly canvas: HTMLCanvasElement | null;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly drops: RainDrop[] = [];
  private readonly splashes: RainSplash[] = [];
  private readonly projScratch: [number, number] = [0, 0];
  private field: PrecipField | null = null;
  private spawnDist: ViewportSpawnDistribution | null = null;
  private activeDropCount = 0;
  private darkChrome: boolean;
  private opacity: number;
  private visible: boolean;
  private rafId: number | null = null;
  private lastTickMs = 0;
  private rngState = 0x9e3779b9;
  private splashCursor = 0;
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private disposed = false;

  private readonly onResize = (): void => {
    this.syncCanvasSize();
    this.rebuildViewportDistribution(true);
    if (!this.rafId && this.shouldRenderStatic()) this.drawFrame(0);
  };

  private readonly onCameraMove = (): void => {
    if (!this.rafId && this.shouldRenderStatic()) this.drawFrame(0);
  };

  private readonly onCameraMoveEnd = (): void => {
    this.rebuildViewportDistribution(false);
    if (!this.rafId && this.shouldRenderStatic()) this.drawFrame(0);
  };

  private readonly onVisibilityChange = (): void => {
    this.syncLoop();
  };

  constructor(
    private readonly map: MapLibreMap,
    options: { darkChrome: boolean; opacity: number; visible: boolean }
  ) {
    this.darkChrome = options.darkChrome;
    this.opacity = options.opacity;
    this.visible = options.visible;

    const host = (
      (typeof (map as { getCanvasContainer?: () => HTMLElement }).getCanvasContainer === 'function'
        ? (map as { getCanvasContainer: () => HTMLElement }).getCanvasContainer()
        : null)
      ?? (typeof map.getContainer === 'function' ? map.getContainer() : null)
    );

    if (typeof document !== 'undefined' && host && typeof host.appendChild === 'function' && typeof map.project === 'function') {
      const el = document.createElement('canvas');
      el.className = 'av-rain-canvas';
      el.setAttribute('aria-hidden', 'true');
      host.appendChild(el);
      this.canvas = el;
      this.ctx = el.getContext('2d');
      this.syncCanvasSize();
      map.on('resize', this.onResize);
      map.on('move', this.onCameraMove);
      map.on('moveend', this.onCameraMoveEnd);
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    } else {
      this.canvas = null;
      this.ctx = null;
    }

    for (let i = 0; i < MAX_DROPS; i++) {
      this.drops.push({
        lon: 0, lat: 0, my: 0, mmh: 0, tier: 1,
        age: 0, life: 0.45, speed: 300, scale: 0.85, alpha: 0.85, depth: 1
      });
    }
    for (let i = 0; i < MAX_SPLASHES; i++) {
      this.splashes.push({ lon: 0, lat: 0, my: 0, age: 1, life: 0.3, maxRx: 6, doubleRing: false });
    }
  }

  setField(field: PrecipField | null): void {
    if (this.disposed || this.field === field) return;
    this.field = field;
    this.rebuildViewportDistribution(true);
    if (!field || field.wetIndices.length === 0) {
      this.clearCanvas();
    }
    this.syncLoop();
  }

  setDarkChrome(darkChrome: boolean): void {
    if (this.darkChrome === darkChrome || this.disposed) return;
    this.darkChrome = darkChrome;
    if (!this.rafId && this.shouldRenderStatic()) this.drawFrame(0);
  }

  setOpacity(opacity: number): void {
    if (this.opacity === opacity) return;
    this.opacity = opacity;
    if (!this.rafId && this.shouldRenderStatic()) this.drawFrame(0);
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible || this.disposed) return;
    this.visible = visible;
    if (!visible) this.clearCanvas();
    this.syncLoop();
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopLoop();
    if (this.canvas) {
      this.map.off('resize', this.onResize);
      this.map.off('move', this.onCameraMove);
      this.map.off('moveend', this.onCameraMoveEnd);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibilityChange);
      this.canvas.remove();
    }
  }

  private rand(): number {
    let x = this.rngState | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rngState = x;
    return (x >>> 0) * (1 / 4294967296);
  }

  private prefersReducedMotion(): boolean {
    return typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  private hasActiveRain(): boolean {
    return Boolean(
      this.ctx && this.visible && this.opacity > 0.02
      && this.field && this.field.wetIndices.length > 0
      && this.spawnDist && this.spawnDist.indices.length > 0
    );
  }

  private shouldRenderStatic(): boolean {
    return this.hasActiveRain() && this.prefersReducedMotion();
  }

  private currentViewBounds(): PrecipBounds {
    if (typeof this.map.getBounds !== 'function') {
      return this.field ?? { west: -180, south: -60, east: 180, north: 60 };
    }
    const b = this.map.getBounds();
    const west = b.getWest();
    let east = b.getEast();
    if (east <= west) east += 360;
    return {
      west,
      east,
      south: Math.max(-MAX_LAT, b.getSouth()),
      north: Math.min(MAX_LAT, b.getNorth())
    };
  }

  private computeTargetDropCount(dist: ViewportSpawnDistribution): number {
    if (dist.indices.length === 0) return 0;
    const screenArea = Math.max(120_000, this.cssW * this.cssH);
    const wetScreenPx = dist.visibleWetFraction * screenArea;
    const intensityDensity = 0.16 + Math.min(2.6, Math.pow(dist.meanWetMmh, 0.72) * 0.36 + Math.max(0, dist.peakVisibleMmh - 0.8) * 0.08);
    const areaDriven = (wetScreenPx / 520) * intensityDensity;
    const minCluster = dist.peakVisibleMmh >= 5 ? 120 : dist.peakVisibleMmh >= 1.5 ? 64 : 26;
    const maxViewportCap = Math.min(MAX_DROPS, Math.round(screenArea / 460));
    return Math.max(minCluster, Math.min(maxViewportCap, Math.round(areaDriven)));
  }

  private rebuildViewportDistribution(reseedAll: boolean): void {
    const field = this.field;
    if (!field || field.wetIndices.length === 0) {
      this.spawnDist = null;
      this.activeDropCount = 0;
      return;
    }
    const view = this.currentViewBounds();
    const dist = buildViewportSpawnDistribution(field, view);
    const prevCount = this.activeDropCount;
    this.spawnDist = dist;
    this.activeDropCount = this.computeTargetDropCount(dist);

    if (dist.indices.length > 0) {
      const start = reseedAll ? 0 : prevCount;
      for (let i = start; i < this.activeDropCount; i++) {
        this.respawnDrop(this.drops[i]!, field, dist, true);
      }
      if (reseedAll) {
        for (const s of this.splashes) s.age = s.life;
      }
    }
  }

  private respawnDrop(
    drop: RainDrop,
    field: PrecipField,
    dist: ViewportSpawnDistribution,
    randomPhase: boolean
  ): void {
    const cellIdx = pickFromCdf(dist.cdf, dist.indices, this.rand());
    const r = (cellIdx / field.cols) | 0;
    const c = cellIdx - r * field.cols;
    const u = (c + this.rand()) / field.cols;
    const v = (r + this.rand()) / field.rows;
    const lon = field.west + u * (field.east - field.west);
    const my = field.yNorth - v * (field.yNorth - field.ySouth);
    const lat = invMercY(my);
    const mmh = Math.max(MIN_RAIN_MMH, samplePrecipMmh(field, lon, lat, my));
    const profile = rainVisualProfileForMmh(mmh);
    const isForeground = this.rand() < 0.42;
    const depth = isForeground ? (1.02 + this.rand() * 0.22) : (0.70 + this.rand() * 0.22);

    drop.lon = lon;
    drop.lat = lat;
    drop.my = my;
    drop.mmh = mmh;
    drop.tier = profile.tier;
    drop.depth = depth;
    drop.speed = profile.speedPxPerSec * depth * (0.90 + this.rand() * 0.20);
    drop.scale = profile.scale * depth * (0.88 + this.rand() * 0.24);
    drop.alpha = profile.alpha * (isForeground ? 1 : 0.74);
    drop.life = (0.28 + (1 - Math.min(1, mmh / 20)) * 0.22 + this.rand() * 0.14) / Math.max(0.75, depth * 0.9);
    drop.age = randomPhase ? this.rand() * drop.life : 0;
  }

  private spawnSplash(lon: number, lat: number, my: number, mmh: number): void {
    const s = this.splashes[this.splashCursor]!;
    this.splashCursor = (this.splashCursor + 1) % MAX_SPLASHES;
    s.lon = lon;
    s.lat = lat;
    s.my = my;
    s.age = 0;
    s.life = 0.24 + this.rand() * 0.14;
    s.maxRx = 3.6 + Math.min(6.4, Math.sqrt(mmh) * 1.05);
    s.doubleRing = mmh >= 11;
  }

  private syncCanvasSize(): void {
    const canvas = this.canvas;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = typeof window !== 'undefined' ? Math.min(2, Math.max(1, window.devicePixelRatio || 1)) : 1;
    const w = Math.max(1, Math.round(rect.width || this.map.getCanvas?.()?.clientWidth || 1));
    const h = Math.max(1, Math.round(rect.height || this.map.getCanvas?.()?.clientHeight || 1));
    this.cssW = w;
    this.cssH = h;
    this.dpr = dpr;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
  }

  private clearCanvas(): void {
    if (!this.ctx || !this.canvas) return;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private syncLoop(): void {
    if (!this.hasActiveRain() || (typeof document !== 'undefined' && document.hidden)) {
      this.stopLoop();
      if (!this.visible || !this.hasActiveRain()) this.clearCanvas();
      return;
    }
    if (this.prefersReducedMotion()) {
      this.stopLoop();
      this.drawFrame(0);
      return;
    }
    if (this.rafId !== null || typeof requestAnimationFrame !== 'function') return;
    this.lastTickMs = performance.now();
    const tick = (now: number): void => {
      this.rafId = null;
      if (this.disposed || !this.hasActiveRain() || (typeof document !== 'undefined' && document.hidden)) return;
      const dt = Math.min(0.055, Math.max(0.004, (now - this.lastTickMs) * 0.001));
      this.lastTickMs = now;
      this.drawFrame(dt);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopLoop(): void {
    if (this.rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.rafId);
    }
    this.rafId = null;
  }

  private drawFrame(dt: number): void {
    const ctx = this.ctx, field = this.field, dist = this.spawnDist;
    if (!ctx || !field || !dist || dist.indices.length === 0) return;
    if (this.cssW <= 1 || this.cssH <= 1) this.syncCanvasSize();
    const atlas = getRainSpriteAtlas();
    if (!atlas) return;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);

    const dark = this.darkChrome;
    const masterAlpha = Math.min(1, 0.50 + this.opacity * 0.50);
    const center = this.map.getCenter();
    const centerLon = center.lng;
    const fastProj = calibrateMercatorProjector(this.map, centerLon, center.lat);
    const casingStroke = dark ? '#020814' : '#0c1424';
    const coreStroke = dark ? '#e0f2fe' : '#ffffff';
    const casingBaseAlpha = dark ? 0.72 : 0.58;
    const coreBaseAlpha = dark ? 0.94 : 0.95;

    // 1. Expanding puddle splash ripples under moderate-to-heavy cores (>= 3.2 mm/h)
    ctx.lineCap = 'round';
    for (let i = 0; i < MAX_SPLASHES; i++) {
      const s = this.splashes[i]!;
      if (s.age >= s.life) continue;
      if (dt > 0) {
        s.age += dt;
        if (s.age >= s.life) continue;
      }
      const wrappedLon = s.lon + 360 * Math.floor((centerLon - s.lon) / 360 + 0.5);
      let px: number, py: number;
      if (fastProj) {
        px = fastProj.cx + (wrappedLon - fastProj.cLon) * fastProj.kx;
        py = fastProj.cy + (fastProj.cMy - s.my) * fastProj.ky;
      } else {
        this.projScratch[0] = wrappedLon;
        this.projScratch[1] = s.lat;
        const pt = this.map.project(this.projScratch);
        px = pt.x;
        py = pt.y;
      }
      if (px < -24 || px > this.cssW + 24 || py < -24 || py > this.cssH + 24) continue;

      const t = s.age / s.life;
      const rx = 1.4 + (s.maxRx - 1.4) * Math.sqrt(t);
      const ry = rx * 0.40;
      const fade = (1 - t) * masterAlpha;

      ctx.beginPath();
      ctx.ellipse(px, py, rx, ry, 0, 0, Math.PI * 2);
      if (s.doubleRing && t > 0.22) {
        const rx2 = rx * 0.56;
        ctx.moveTo(px + rx2, py);
        ctx.ellipse(px, py, rx2, ry * 0.56, 0, 0, Math.PI * 2);
      }
      ctx.strokeStyle = casingStroke;
      ctx.globalAlpha = casingBaseAlpha * fade;
      ctx.lineWidth = 2.3;
      ctx.stroke();

      ctx.strokeStyle = coreStroke;
      ctx.globalAlpha = coreBaseAlpha * fade;
      ctx.lineWidth = 1.05;
      ctx.stroke();
    }

    // 2. Multi-depth tapered optical raindrop sprites scaled by local mm/h
    const atlasRowY = dark ? SPRITE_CELL_H : 0;
    const count = this.activeDropCount;

    for (let i = 0; i < count; i++) {
      const drop = this.drops[i]!;
      if (dt > 0) {
        drop.age += dt;
        if (drop.age >= drop.life) {
          if (drop.mmh >= 3.2 && this.rand() < Math.min(0.65, 0.14 + drop.mmh * 0.032)) {
            this.spawnSplash(drop.lon, drop.lat, drop.my, drop.mmh);
          }
          this.respawnDrop(drop, field, dist, false);
        }
      }

      const wrappedLon = drop.lon + 360 * Math.floor((centerLon - drop.lon) / 360 + 0.5);
      let px: number, py: number;
      if (fastProj) {
        px = fastProj.cx + (wrappedLon - fastProj.cLon) * fastProj.kx;
        py = fastProj.cy + (fastProj.cMy - drop.my) * fastProj.ky;
      } else {
        this.projScratch[0] = wrappedLon;
        this.projScratch[1] = drop.lat;
        const pt = this.map.project(this.projScratch);
        px = pt.x;
        py = pt.y;
      }
      if (px < -48 || px > this.cssW + 48 || py < -64 || py > this.cssH + 64) continue;

      const phase = drop.age / Math.max(0.05, drop.life);
      const env = phase < 0.16 ? phase / 0.16 : phase > 0.88 ? (1 - phase) / 0.12 : 1;
      const travel = (phase - 0.5) * drop.speed * drop.life * 0.58;
      const tipX = px + travel * SLANT_TAN;
      const tipY = py + travel;

      const dw = SPRITE_CELL_W * 0.52 * drop.scale;
      const dh = SPRITE_CELL_H * 0.52 * drop.scale;
      ctx.globalAlpha = Math.min(1, drop.alpha * env * masterAlpha);
      ctx.drawImage(
        atlas as CanvasImageSource,
        drop.tier * SPRITE_CELL_W,
        atlasRowY,
        SPRITE_CELL_W,
        SPRITE_CELL_H,
        tipX - dw * 0.64,
        tipY - dh + 4.5 * drop.scale,
        dw,
        dh
      );
    }
    ctx.globalAlpha = 1;
  }
}
