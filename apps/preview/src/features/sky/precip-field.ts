import { paletteValueLut, RAIN_COLORS, RAIN_EDGES } from '@av/contracts/layers';
import { mercY } from './mercator';

export const MIN_RAIN_MMH = 0.15;

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

let rainRgb555Lut: Float32Array | null = null;
let pow092Lut: Float32Array | null = null;

/** Spawn weight `mmh^0.92` for one cell; 0 for dry cells. */
export function mmhWeight(v: number): number {
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
  // Unmatched colours read as dry (0 mm/h).
  return rainRgb555Lut ??= paletteValueLut(RAIN_COLORS, RAIN_EDGES, 20).map(value => Math.max(0, value));
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
