// Lenschow & Stephens (1980) net thermal climb-rate dome inside the native column's usable lift.

import {
  LENSCHOW_F_MAX,
  LENSCHOW_PEAK_ZETA,
  lenschowNormalizedUpdraft,
  SINK_RATE_MPS,
} from '@av/soaring';
import type { PublishedForecastHour } from './internal-meteo.ts';
import { clamp, convertQuantity, finiteScalar, type UnitSystem } from './windgram-format.ts';
import { contourGridIsobands } from './windgram-isobands.ts';
import { yToHeight, type WindgramScale } from './windgram-vertical.ts';
import { hourX } from './windgram-time-axis.ts';

/**
 * 6-band soaring net-climb scale (modeled Lenschow updraft − 1.2 m/s sink), in m/s:
 * 0.75 / 1.5 / 2.5 / 3.5 / 4.5 m/s ≈ 150 / 295 / 490 / 690 / 885 ft/min (≈ 1.5 / 3 / 5 / 7 / 9 kt).
 */
export const WINDGRAM_CLIMB_BANDS = [
  { className: 'wg-climb-marginal', minMps: 0, maxMps: 0.75, color: '#3b82c4', label: 'Zero-sink' },
  { className: 'wg-climb-light', minMps: 0.75, maxMps: 1.5, color: '#3ec483', label: 'Light' },
  { className: 'wg-climb-moderate', minMps: 1.5, maxMps: 2.5, color: '#f2c12e', label: 'Moderate' },
  { className: 'wg-climb-good', minMps: 2.5, maxMps: 3.5, color: '#f58220', label: 'Good' },
  { className: 'wg-climb-strong', minMps: 3.5, maxMps: 4.5, color: '#e5484d', label: 'Strong Thermal' },
  { className: 'wg-climb-booming', minMps: 4.5, maxMps: Infinity, color: '#b91c5c', label: 'Booming' },
] as const;

/** Resolves effective surface terrain elevation from persistent fine DEM or model ground. */
export function effectiveHourGroundM(
  hour: Pick<PublishedForecastHour, 'fineTerrainM' | 'modelTerrainM'>,
): number | null {
  return hour.fineTerrainM ?? hour.modelTerrainM ?? null;
}

export function climbBandRange(index: number, system: UnitSystem): string {
  const band = WINDGRAM_CLIMB_BANDS[index]!;
  const fmt = (mps: number) => {
    const val = convertQuantity(mps, 'lift', system)!;
    return system === 'metric' ? String(Number(val.toFixed(2))) : String(Math.round(val / 5) * 5);
  };
  if (!Number.isFinite(band.maxMps)) return `≥ ${fmt(band.minMps)}`;
  if (index === 0) return `< ${fmt(band.maxMps)}`;
  return `${fmt(band.minMps)}–${fmt(band.maxMps)}`;
}

interface ConvectiveColumnEnvelope {
  readonly groundM: number;
  readonly floorM: number;
  readonly usableTopM: number;
  readonly convectiveDepthM: number;
  readonly thermalVelocityMps: number;
  readonly peakClimbMps: number;
}

/**
 * The native model column one climb estimate uses: model ground, convective top, w* and cloud cap,
 * with `usableTopM` from the same inputs (`null` when that column has no usable climb).
 */
interface NativeThermalColumn {
  readonly groundM: number;
  readonly thermalTopM: number;
  readonly thermalVelocityMps: number;
  readonly usableTopM: number | null;
  readonly cloudCapM: number | null;
}

/** The hour's native column, or `null` when model ground, thermal top or w* is missing. */
export function nativeThermalColumn(
  hour: Pick<PublishedForecastHour, 'modelTerrainM' | 'thermalTopM' | 'thermalVelocityMps' | 'nativeUsableLiftTopM' | 'effectiveCloudLimitM'>,
): NativeThermalColumn | null {
  const groundM = finiteScalar(hour.modelTerrainM), thermalTopM = finiteScalar(hour.thermalTopM);
  const thermalVelocityMps = finiteScalar(hour.thermalVelocityMps);
  if (groundM === null || thermalTopM === null || thermalVelocityMps === null) return null;
  return {
    groundM, thermalTopM, thermalVelocityMps,
    usableTopM: finiteScalar(hour.nativeUsableLiftTopM),
    cloudCapM: finiteScalar(hour.effectiveCloudLimitM),
  };
}

/** Resolves the usable lift ceiling shown for an hour: fine map lift, else the native column's ceiling when fine lift is unpublished. */
export function effectiveHourUsableLiftTopM(
  hour: Pick<PublishedForecastHour, 'mapLift' | 'nativeUsableLiftTopM'>,
  viewUsableLiftTopM?: number | null,
): number | null {
  const mapTop = viewUsableLiftTopM !== undefined ? viewUsableLiftTopM : hour.mapLift.mslM;
  if (mapTop !== null) return mapTop;
  const status = hour.mapLift.msl?.status;
  if (status && status !== 'unavailable') return null;
  return hour.nativeUsableLiftTopM ?? null;
}

/**
 * Lenschow climb envelope for one native column. `surfaceM` (fine terrain) only clips drawing below
 * the local surface; the profile's ground, depth and ceiling all come from `column`.
 */
export function resolveConvectiveEnvelope(
  column: NativeThermalColumn | null,
  surfaceM: number | null = null,
): ConvectiveColumnEnvelope | null {
  if (!column || column.usableTopM === null) return null;
  const { groundM, thermalTopM, thermalVelocityMps, usableTopM } = column;
  const floorM = Math.max(groundM, surfaceM ?? groundM);
  if (usableTopM <= floorM || thermalVelocityMps <= 0) return null;
  if (thermalVelocityMps * LENSCHOW_F_MAX - SINK_RATE_MPS <= 0) return null;
  const convectiveDepthM = Math.max(thermalTopM, usableTopM) - groundM;
  if (!(convectiveDepthM > 0)) return null;
  const zetaMin = clamp((floorM - groundM) / convectiveDepthM, 0, 1);
  const zetaMax = clamp((usableTopM - groundM) / convectiveDepthM, zetaMin, 1);
  const peakZeta = clamp(LENSCHOW_PEAK_ZETA, zetaMin, zetaMax);
  const peakClimbMps = thermalVelocityMps * lenschowNormalizedUpdraft(peakZeta) - SINK_RATE_MPS;
  if (peakClimbMps <= 0) return null;
  return { groundM, floorM, usableTopM, convectiveDepthM, thermalVelocityMps, peakClimbMps };
}

/**
 * Net paraglider climb rate (m/s) at `zM` MSL in the native column: `null` when its inputs are
 * missing, `0` outside its usable lift or when that column has none.
 */
export function estimateThermalClimbAtHeight(
  zM: number,
  column: NativeThermalColumn | null,
  surfaceM: number | null = null,
): { estimatedClimbMps: number | null; peakClimbMps: number | null } {
  if (!column) return { estimatedClimbMps: null, peakClimbMps: null };
  const env = resolveConvectiveEnvelope(column, surfaceM);
  if (!env) return { estimatedClimbMps: 0, peakClimbMps: null };
  if (zM < env.floorM || zM > env.usableTopM + 0.5) {
    return { estimatedClimbMps: 0, peakClimbMps: env.peakClimbMps };
  }
  const zeta = clamp((zM - env.groundM) / env.convectiveDepthM, 0, 1);
  const netClimb = Math.max(0, env.thermalVelocityMps * lenschowNormalizedUpdraft(zeta) - SINK_RATE_MPS);
  return { estimatedClimbMps: netClimb, peakClimbMps: env.peakClimbMps };
}

/**
 * Generates smooth marching-square isoband SVG paths for the Lenschow net-climb dome of each
 * hour's native column, clipped below the fine terrain surface.
 */
export function buildClimbDomeFieldPaths(args: {
  sourceHours: readonly PublishedForecastHour[];
  viewHours: readonly { x: number; usableLiftTopM: number | null }[];
  scale: WindgramScale;
  columnWidth: number;
  leftBound: number;
  rightBound: number;
}): { className: string; path: string }[] {
  const { sourceHours, viewHours, scale, columnWidth, leftBound, rightBound } = args;
  const n = viewHours.length;
  if (n === 0) return [];

  const envelopes = viewHours.map((_vh, i) => {
    const src = sourceHours[i];
    return src ? resolveConvectiveEnvelope(nativeThermalColumn(src), src.fineTerrainM ?? null) : null;
  });

  const runs: [number, number][] = [];
  let runStart = -1;
  for (let i = 0; i < n; i++) {
    if (envelopes[i]) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      runs.push([runStart, i - 1]);
      runStart = -1;
    }
  }
  if (runStart >= 0) runs.push([runStart, n - 1]);
  if (!runs.length) return [];

  const plotTop = scale.top;
  const plotBottom = scale.bottom;
  const plotHeight = plotBottom - plotTop;
  if (plotHeight <= 0) return [];

  const rows = Math.max(4, Math.ceil(plotHeight / 3.5));
  const zAtRow = new Float64Array(rows + 1);
  for (let r = 0; r <= rows; r++) zAtRow[r] = yToHeight(scale, plotTop + (r / rows) * plotHeight);
  const dzPerRow = Math.max(1, Math.abs(zAtRow[0]! - (zAtRow[1] ?? 0)));
  const thresholds = WINDGRAM_CLIMB_BANDS.map(b => b.minMps);
  const classNames = WINDGRAM_CLIMB_BANDS.map(b => b.className);
  const pathsByClass = new Map<string, string[]>();

  for (const [startIdx, endIdx] of runs) {
    const rampLeft = startIdx > 0;
    const rampRight = endIdx < n - 1;
    const tMin = startIdx - (rampLeft ? 0.46 : 0.5);
    const tMax = endIdx + (rampRight ? 0.46 : 0.5);
    const subCols = Math.max(6, Math.ceil((tMax - tMin) * 7));
    const stride = subCols + 1;
    const xs = new Float64Array(stride);
    const gridValues = new Float32Array((rows + 1) * stride);

    for (let c = 0; c <= subCols; c++) {
      const t = tMin + ((tMax - tMin) * c) / subCols;
      xs[c] = clamp(hourX(viewHours, t, columnWidth), leftBound, rightBound);

      let solverGroundM: number;
      let floorM: number;
      let usableTopM: number;
      let convectiveDepthM: number;
      let wStar: number;

      if (t < startIdx) {
        const env = envelopes[startIdx]!;
        if (rampLeft) {
          const frac = clamp((t - tMin) / Math.max(1e-6, startIdx - tMin), 0, 1);
          const eased = Math.sqrt(frac);
          solverGroundM = env.groundM;
          floorM = env.floorM;
          usableTopM = env.floorM + (env.usableTopM - env.floorM) * eased;
          convectiveDepthM = Math.max(1, env.convectiveDepthM * (env.floorM === env.groundM ? eased : 0.6 + 0.4 * eased));
          wStar = env.thermalVelocityMps * (0.75 + 0.25 * frac);
        } else {
          ({ groundM: solverGroundM, floorM, usableTopM, convectiveDepthM, thermalVelocityMps: wStar } = env);
        }
      } else if (t > endIdx) {
        const env = envelopes[endIdx]!;
        if (rampRight) {
          const frac = clamp((tMax - t) / Math.max(1e-6, tMax - endIdx), 0, 1);
          const eased = Math.sqrt(frac);
          solverGroundM = env.groundM;
          floorM = env.floorM;
          usableTopM = env.floorM + (env.usableTopM - env.floorM) * eased;
          convectiveDepthM = Math.max(1, env.convectiveDepthM * (env.floorM === env.groundM ? eased : 0.6 + 0.4 * eased));
          wStar = env.thermalVelocityMps * (0.75 + 0.25 * frac);
        } else {
          ({ groundM: solverGroundM, floorM, usableTopM, convectiveDepthM, thermalVelocityMps: wStar } = env);
        }
      } else {
        const lo = Math.floor(t);
        const hi = Math.min(endIdx, Math.ceil(t));
        const f = t - lo;
        const a = envelopes[lo]!;
        const b = envelopes[hi]!;
        solverGroundM = a.groundM + (b.groundM - a.groundM) * f;
        floorM = a.floorM + (b.floorM - a.floorM) * f;
        usableTopM = a.usableTopM + (b.usableTopM - a.usableTopM) * f;
        convectiveDepthM = a.convectiveDepthM + (b.convectiveDepthM - a.convectiveDepthM) * f;
        wStar = a.thermalVelocityMps + (b.thermalVelocityMps - a.thermalVelocityMps) * f;
      }

      const invDepth = 1 / Math.max(1, convectiveDepthM);
      for (let r = 0; r <= rows; r++) {
        const z = zAtRow[r]!;
        let v: number;
        if (z > usableTopM) {
          v = -0.04 * ((z - usableTopM) / dzPerRow);
        } else if (z < floorM) {
          v = -0.04 * ((floorM - z) / dzPerRow);
        } else {
          const zeta = clamp((z - solverGroundM) * invDepth, 0, 1);
          const netClimb = Math.max(0, wStar * lenschowNormalizedUpdraft(zeta) - SINK_RATE_MPS);
          const edgeRamp = 0.04 * Math.min(1, (usableTopM - z) / dzPerRow, (z - floorM) / dzPerRow);
          v = Math.max(edgeRamp, netClimb);
        }
        gridValues[r * stride + c] = v;
      }
    }

    const bandPaths = contourGridIsobands({
      values: gridValues,
      xs,
      rows,
      cols: subCols,
      plotTop,
      plotBottom,
      thresholds,
      classNames,
    });
    for (const [cls, path] of Object.entries(bandPaths)) {
      const list = pathsByClass.get(cls);
      if (list) list.push(path);
      else pathsByClass.set(cls, [path]);
    }
  }

  return classNames.flatMap(className => {
    const parts = pathsByClass.get(className);
    return parts?.length ? [{ className, path: parts.join('') }] : [];
  });
}
