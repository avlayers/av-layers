// Atmospheric field layers for Windgram Concept 1 ('hybrid-climb'):
// 1. Environmental temperature inversion layers (dT/dz > 0) rendered as dark stratified lids.
// 2. Hydrostatic vertical velocity w = -ω R_d T / (p g) for resolved model ascent aloft.
// 3. Contoured 3-tier RH cloud decks.
// The climb dome lives in `windgram-climb.ts`; cloud layers and sky cover in `windgram-clouds.ts`.

import { windFromComponents } from '@av/soaring';
import {
  geometricWFromOmegaMps,
} from '@av/thermodynamics';
import type { FieldNode, HourSampling, PublishedForecastHour } from './internal-meteo.ts';
import { effectiveHourGroundM, effectiveHourUsableLiftTopM } from './windgram-climb.ts';
import { CLOUD_BKN_RH_PERCENT, CLOUD_SCT_RH_PERCENT } from './windgram-clouds.ts';
import { clamp, finiteScalar, mpsToKnots } from './windgram-format.ts';
import { buildStabilityFieldPaths } from './windgram-geometry.ts';
import { contourGridIsobands } from './windgram-isobands.ts';
import {
  CLOUD_RH_THRESHOLD_PERCENT,
  profileHeightGaps,
  sampleHeight,
  stabilityDisplayNodes,
  withHeightGaps,
} from './windgram-sampling.ts';
import { heightToY, yToHeight, type WindgramScale } from './windgram-scale.ts';
import { hourX } from './windgram-time-axis.ts';

export const WINDGRAM_FIELD_MODES = ['hybrid-climb', 'lapse'] as const;
export type WindgramFieldMode = (typeof WINDGRAM_FIELD_MODES)[number];
export const DEFAULT_WINDGRAM_FIELD_MODE: WindgramFieldMode = 'hybrid-climb';

/** Calm desaturated slate-blue backdrop for non-convective air in hybrid-climb mode. */
export const WINDGRAM_HYBRID_SKY_COLOR = '#4f5c87';

/** Minimum resolved statically stable upward vertical velocity (m/s, ~120 / ~295 ft/min) contoured as model ascent aloft. */
export const WAVE_ASCENT_MIN_MPS = 0.6;
const WAVE_ASCENT_STRONG_MPS = 1.5;
/** Filter near-adiabatic convective chimneys (<= -2.45 °C/1kft) and light-wind (<12 kt) plumes on background ascent contours. */
const WAVE_MIN_LAPSE_C_PER_1000FT = -2.45;
export const WAVE_MIN_WIND_KT = 12;

/** Cool dark stratified indigo-slate lids for temperature inversions. */
export const WINDGRAM_INVERSION_BANDS = [
  { className: 'wg-inversion-weak', minLapse: 0, maxLapse: 0.5, color: '#2c355d' },
  { className: 'wg-inversion-strong', minLapse: 0.5, maxLapse: Infinity, color: '#171c36' },
] as const;

/**
 * Hydrostatic conversion from pressure vertical velocity ω (Pa/s, negative = ascent)
 * to geometric vertical velocity w (m/s, positive = ascent), delegating to `@av/thermodynamics`.
 */
export function omegaToVerticalVelocityMps(
  omegaPaS: number | null,
  temperatureC: number | null,
  pressureHpa: number | null,
  altitudeM: number,
): number | null {
  if (omegaPaS === null || !Number.isFinite(omegaPaS)) return null;
  const tempC = temperatureC !== null && Number.isFinite(temperatureC) ? temperatureC : 15 - 0.0065 * altitudeM;
  if (!(tempC + 273.15 > 50)) return null;
  const pHpa = pressureHpa !== null && Number.isFinite(pressureHpa) && pressureHpa > 10
    ? pressureHpa
    : 1013.25 * Math.pow(Math.max(0.1, 1 - (0.0065 * clamp(altitudeM, 0, 11_000)) / 288.15), 5.25588);
  const w = geometricWFromOmegaMps(omegaPaS, pHpa, tempC);
  return Number.isFinite(w) ? w : null;
}

/** Clips an ordered altitude field to `scale` bounds and projects heights into pixel offsets from plot bottom. */
function clipFieldNodesToScale(
  source: readonly FieldNode[],
  scale: WindgramScale,
): { distanceFromBottomPx: number; value: number }[] {
  if (!source.length) return [];
  const { floorM, topM, bottom: plotBottom } = scale;
  const nodes = source.filter(n => n.altitudeM >= floorM && n.altitudeM <= topM);
  if (source[0]!.altitudeM < floorM && source.at(-1)!.altitudeM >= floorM && nodes[0]?.altitudeM !== floorM) {
    nodes.unshift({ altitudeM: floorM, value: sampleHeight(source, floorM) ?? NaN });
  }
  if (nodes.length && nodes.at(-1)!.altitudeM < topM && source.at(-1)!.altitudeM > topM) {
    nodes.push({ altitudeM: topM, value: sampleHeight(source, topM) ?? NaN });
  }
  return nodes.map(n => ({ distanceFromBottomPx: plotBottom - heightToY(scale, n.altitudeM), value: n.value }));
}

/** Projects one hour's interval lapse-rate nodes onto `scale` pixel coordinates. */
export function stabilityPixelNodesForHour(
  sample: HourSampling,
  scale: WindgramScale,
): { distanceFromBottomPx: number; value: number }[] {
  if (!sample.lapseCPer1000Ft.some(n => Number.isFinite(n.value))) return [];
  return clipFieldNodesToScale(stabilityDisplayNodes(sample.lapseCPer1000Ft), scale);
}

/**
 * Builds dark stratified inversion-lid paths (dT/dz > 0), statically stable model
 * ascent paths aloft (w_ω >= 0.6 m/s above thermal ceiling in dry, >= 12 kt flow),
 * and contoured 3-tier mixed-phase RH cloud-deck paths.
 */
export function buildInversionAndCloudDeckPaths(args: {
  sourceHours?: readonly PublishedForecastHour[];
  sampling: readonly HourSampling[];
  hours: readonly { x: number; usableLiftTopM?: number | null }[];
  scale: WindgramScale;
  columnWidth: number;
  leftBound?: number;
  rightBound?: number;
}): {
  inversionFields: { className: string; path: string }[];
  waveFields: { className: string; path: string }[];
  cloudDeckFields: { className: string; path: string }[];
} {
  const { sourceHours, sampling, hours, scale, columnWidth, leftBound, rightBound } = args;
  if (!hours.length) return { inversionFields: [], waveFields: [], cloudDeckFields: [] };
  const { floorM, top: plotTop, bottom: plotBottom } = scale;

  const stabilityPixelNodes = sampling.map(s => stabilityPixelNodesForHour(s, scale));

  const inversionMap = stabilityPixelNodes.some(n => n.length)
    ? buildStabilityFieldPaths({
        nodesByHour: stabilityPixelNodes,
        hours,
        columnWidth,
        plotTop,
        plotBottom,
        leftBound,
        rightBound,
        banding: {
          breakpoints: [0, 0.5],
          classNames: ['', 'wg-inversion-weak', 'wg-inversion-strong'],
        },
      })
    : {};

  // Resolved statically stable model vertical velocity w_ω aloft (preserving missing-height gaps)
  const wProfilesByHour = hours.map((vh, i) => {
    const src = sourceHours?.[i];
    if (!src?.levels.length) return null;
    if (!src.levels.some(l => l.omegaPaS !== null && Number.isFinite(l.omegaPaS))) return null;
    const precip = finiteScalar(src.surface.precipitationMmHr);
    if (precip !== null && precip >= 0.08) return null;
    const lapseNodes = sampling[i]?.lapseCPer1000Ft ?? [];
    const thermalCeilingM = effectiveHourUsableLiftTopM(src, vh.usableLiftTopM) ?? effectiveHourGroundM(src) ?? floorM;
    const gaps = profileHeightGaps(src.levels);
    const rawNodes = src.levels
      .filter((l): l is typeof l & { heightM: number } => l.heightM !== null && Number.isFinite(l.heightM))
      .sort((a, b) => a.heightM - b.heightM)
      .map(l => {
        if (l.omegaPaS === null || !Number.isFinite(l.omegaPaS)) {
          return { altitudeM: l.heightM, value: NaN };
        }
        if (l.heightM <= thermalCeilingM + 20) {
          return { altitudeM: l.heightM, value: 0 };
        }
        const localLapse = lapseNodes.length ? sampleHeight(lapseNodes, l.heightM) : null;
        if (localLapse === null || !Number.isFinite(localLapse) || localLapse <= WAVE_MIN_LAPSE_C_PER_1000FT) {
          return { altitudeM: l.heightM, value: 0 };
        }
        const levelWind = windFromComponents(finiteScalar(l.uWindMps), finiteScalar(l.vWindMps));
        const speedKt = levelWind.speedMps === null ? null : mpsToKnots(levelWind.speedMps);
        if (speedKt === null || speedKt < WAVE_MIN_WIND_KT) {
          return { altitudeM: l.heightM, value: 0 };
        }
        const w = omegaToVerticalVelocityMps(l.omegaPaS, l.temperatureC, l.pressureHpa, l.heightM);
        return {
          altitudeM: l.heightM,
          value: w === null ? NaN : w,
        };
      });
    const nodes = withHeightGaps(rawNodes, gaps, altitudeM => ({ altitudeM, value: NaN }));
    return nodes.length ? { nodes, gaps } : null;
  });

  const hasWaveAscent = wProfilesByHour.some(
    prof => prof !== null && prof.nodes.some(n => Number.isFinite(n.value) && n.value >= WAVE_ASCENT_MIN_MPS),
  );
  const waveMap: Record<string, string> = (() => {
    if (!hasWaveAscent || plotBottom <= plotTop) return {};
    const plotH = plotBottom - plotTop;
    const rows = Math.max(6, Math.ceil(plotH / 4));
    const zAtRow = new Float64Array(rows + 1);
    for (let r = 0; r <= rows; r++) zAtRow[r] = yToHeight(scale, plotTop + (r / rows) * plotH);
    const n = hours.length;
    const lBound = leftBound ?? hourX(hours, -0.5, columnWidth);
    const rBound = rightBound ?? hourX(hours, n - 0.5, columnWidth);
    const subCols = Math.max(6, n * 6);
    const stride = subCols + 1;
    const xs = new Float64Array(stride);
    const gridValues = new Float32Array((rows + 1) * stride);
    const sampleHourW = (idx: number, z: number) => {
      const prof = wProfilesByHour[clamp(idx, 0, n - 1)];
      if (!prof) return 0;
      const { nodes, gaps } = prof;
      if (z < nodes[0]!.altitudeM || z > nodes.at(-1)!.altitudeM) return 0;
      for (let g = 0; g < gaps.length; g++) {
        if (z > gaps[g]![0] && z < gaps[g]![1]) return NaN;
      }
      const sampled = sampleHeight(nodes, z);
      return sampled === null ? NaN : sampled;
    };
    for (let c = 0; c <= subCols; c++) {
      const t = -0.5 + (n * c) / subCols;
      xs[c] = clamp(hourX(hours, t, columnWidth), lBound, rBound);
      for (let r = 0; r <= rows; r++) {
        const z = zAtRow[r]!;
        let wVal: number;
        if (t <= 0) {
          const edge = clamp((t + 0.5) / 0.5, 0, 1);
          wVal = sampleHourW(0, z) * (0.65 + 0.35 * edge);
        } else if (t >= n - 1) {
          const edge = clamp((n - 0.5 - t) / 0.5, 0, 1);
          wVal = sampleHourW(n - 1, z) * (0.65 + 0.35 * edge);
        } else {
          const lo = Math.floor(t);
          const f = t - lo;
          const a = sampleHourW(lo, z);
          const b = sampleHourW(lo + 1, z);
          wVal = !Number.isFinite(a) && !Number.isFinite(b)
            ? NaN
            : !Number.isFinite(a)
              ? (f >= 0.5 ? b : NaN)
              : !Number.isFinite(b)
                ? (f <= 0.5 ? a : NaN)
                : a * (1 - f) + b * f;
        }
        const rowEdge = Math.min(1, r / 1.5, (rows - r) / 1.5);
        gridValues[r * stride + c] = wVal * rowEdge;
      }
    }
    return contourGridIsobands({
      values: gridValues,
      xs,
      rows,
      cols: subCols,
      plotTop,
      plotBottom,
      thresholds: [WAVE_ASCENT_MIN_MPS, WAVE_ASCENT_STRONG_MPS],
      classNames: ['wg-wave-lift', 'wg-wave-strong'],
    });
  })();

  const rhPixelNodes = sampling.map(s => {
    const rh = s.cloudHumidityPercent ?? s.relativeHumidityPercent;
    return rh.some(n => Number.isFinite(n.value)) ? clipFieldNodesToScale(rh, scale) : [];
  });

  const cloudDeckMap = rhPixelNodes.some(n => n.length)
    ? buildStabilityFieldPaths({
        nodesByHour: rhPixelNodes,
        hours,
        columnWidth,
        plotTop,
        plotBottom,
        leftBound,
        rightBound,
        banding: {
          breakpoints: [CLOUD_SCT_RH_PERCENT, CLOUD_BKN_RH_PERCENT, CLOUD_RH_THRESHOLD_PERCENT],
          classNames: ['', 'wg-cloud-deck-sct', 'wg-cloud-deck-bkn', 'wg-cloud-deck-ovc'],
        },
      })
    : {};

  return {
    inversionFields: Object.entries(inversionMap).map(([className, path]) => ({ className, path })),
    waveFields: Object.entries(waveMap).map(([className, path]) => ({ className, path })),
    cloudDeckFields: Object.entries(cloudDeckMap).map(([className, path]) => ({ className, path })),
  };
}
