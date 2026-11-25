import { mercY } from './mercator';
import { MIN_RAIN_MMH, mmhWeight, type PrecipBounds, type PrecipField } from './precip-field';

export interface ViewportSpawnDistribution {
  readonly indices: Uint32Array;
  readonly cdf: Float32Array;
  readonly visibleWetFraction: number;
  readonly meanWetMmh: number;
  readonly peakVisibleMmh: number;
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

/** Binary-searches a normalised CDF and returns the matching cell index for uniform `u` in `[0, 1)`. */
export function pickFromCdf(cdf: Float32Array, indices: Uint32Array, u: number): number {
  let lo = 0, hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cdf[mid]! < u) lo = mid + 1;
    else hi = mid;
  }
  return indices[lo]!;
}
