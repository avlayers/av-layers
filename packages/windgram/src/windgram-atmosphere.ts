// Atmospheric visualization physics for Windgram Concept 1 ('hybrid-climb'):
// 1. Lenschow & Stephens (1980) net thermal climb-rate dome inside usable lift (ground -> TOL / native fallback).
// 2. Environmental temperature inversion layers (dT/dz > 0) rendered as dark stratified lids.
// 3. Hydrostatic vertical velocity w = -ω R_d T / (p g) for resolved model ascent aloft.
// 4. Multi-layer mixed-phase cloud segmentation: 3-tier RH decks (83% SCT / 89% BKN / 94% OVC), Cu/OD tower depth, resolved cloud-top temperature, and high-cirrus separation.

import {
  LENSCHOW_F_MAX,
  lenschowNormalizedUpdraft,
  SINK_RATE_MPS,
  usableLiftDepthM,
  windFromComponents,
} from '@av/soaring';
import {
  geometricWFromOmegaMps,
} from '@av/thermodynamics';
import type { FieldNode, HourSampling, PublishedForecastHour } from './internal-meteo.ts';
import type { SkyCoverageCode, WindgramCloudLayerSummary } from './scene-types.ts';
import { clamp, convertQuantity, finiteScalar, mpsToKnots, type UnitSystem } from './windgram-format.ts';
import { buildStabilityFieldPaths } from './windgram-geometry.ts';
import { CLOUD_RH_THRESHOLD_PERCENT, sampleHeight, stabilityDisplayNodes } from './windgram-sampling.ts';
import { heightToY, yToHeight, type WindgramScale } from './windgram-scale.ts';
import { hourX } from './windgram-time-axis.ts';

export const WINDGRAM_FIELD_MODES = ['hybrid-climb', 'lapse'] as const;
export type WindgramFieldMode = (typeof WINDGRAM_FIELD_MODES)[number];
export const DEFAULT_WINDGRAM_FIELD_MODE: WindgramFieldMode = 'hybrid-climb';

/** Calm desaturated slate-blue backdrop for non-convective air in hybrid-climb mode. */
export const WINDGRAM_HYBRID_SKY_COLOR = '#4f5c87';

/** Minimum resolved statically stable upward vertical velocity (m/s, ~120 / ~295 ft/min) contoured as model ascent aloft. */
export const WAVE_ASCENT_MIN_MPS = 0.6;
export const WAVE_ASCENT_STRONG_MPS = 1.5;
/** Filter near-adiabatic convective chimneys (<= -2.45 °C/1kft) and light-wind (<12 kt) plumes on background ascent contours. */
export const WAVE_MIN_LAPSE_C_PER_1000FT = -2.45;
export const WAVE_MIN_WIND_KT = 12;

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

/** Cool dark stratified indigo-slate lids for temperature inversions. */
export const WINDGRAM_INVERSION_BANDS = [
  { className: 'wg-inversion-weak', minLapse: 0, maxLapse: 0.5, color: '#2c355d' },
  { className: 'wg-inversion-strong', minLapse: 0.5, maxLapse: Infinity, color: '#171c36' },
] as const;

export const CLOUD_SCT_RH_PERCENT = 83;
export const CLOUD_BKN_RH_PERCENT = 89;

/** 3-tier stratiform RH cloud decks: scattered wisps (83–89%), broken deck (89–94%), and saturated overcast (94–100%). */
export const WINDGRAM_CLOUD_DECK_BANDS = [
  { className: 'wg-cloud-deck-sct', minRh: CLOUD_SCT_RH_PERCENT, maxRh: CLOUD_BKN_RH_PERCENT },
  { className: 'wg-cloud-deck-bkn', minRh: CLOUD_BKN_RH_PERCENT, maxRh: CLOUD_RH_THRESHOLD_PERCENT },
  { className: 'wg-cloud-deck-ovc', minRh: CLOUD_RH_THRESHOLD_PERCENT, maxRh: 100 },
] as const;

/** Standard aviation METAR/ASOS sky-cover category from 0..100% cloud fraction. */
export function skyCoverageCode(percent: number | null | undefined): SkyCoverageCode {
  if (percent === null || percent === undefined || !Number.isFinite(percent) || percent < 6) return 'CLR';
  if (percent <= 25) return 'FEW';
  if (percent <= 50) return 'SCT';
  if (percent <= 87) return 'BKN';
  return 'OVC';
}

/**
 * Aviation WMO 5-knot rounding boundaries (`2.5 + 5n` kt) shared by chart barbs and hover tile
 * so every WMO feather/pennant glyph maps deterministically to a single color across all altitudes.
 */
export const WIND_SPEED_KNOT_THRESHOLDS = {
  calmKt: 2.5,
  greenMaxKt: 12.5,
  whiteMaxKt: 17.5,
  yellowMaxKt: 27.5,
  redMaxKt: 47.5,
} as const;

/** WMO-aligned wind-barb speed coloring (knots -> hex color). */
export function windBarbSpeedColor(speedKt: number): string {
  if (speedKt < WIND_SPEED_KNOT_THRESHOLDS.greenMaxKt) return '#78ff78';   // < 12.5 kt (calm, 5 kt & 10 kt barbs)
  if (speedKt < WIND_SPEED_KNOT_THRESHOLDS.whiteMaxKt) return '#ffffff';   // 12.5–17.5 kt (15 kt barb)
  if (speedKt < WIND_SPEED_KNOT_THRESHOLDS.yellowMaxKt) return '#fde047';  // 17.5–27.5 kt (20 kt & 25 kt barbs)
  if (speedKt < WIND_SPEED_KNOT_THRESHOLDS.redMaxKt) return '#fca5a5';     // 27.5–47.5 kt (30–45 kt barbs)
  return '#e879f9';                                                        // >= 47.5 kt (50+ kt WMO pennant flag)
}

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

/** Resolves effective surface terrain elevation from persistent fine DEM or model ground. */
export function effectiveHourGroundM(
  hour: Pick<PublishedForecastHour, 'fineTerrainM' | 'mapLift' | 'modelTerrainM'>,
): number | null {
  return hour.fineTerrainM ?? hour.mapLift.terrainM ?? hour.modelTerrainM ?? null;
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

export interface ConvectiveColumnEnvelope {
  readonly groundM: number;
  readonly usableTopM: number;
  readonly convectiveDepthM: number;
  readonly thermalVelocityMps: number;
  readonly peakClimbMps: number;
}

/** Resolves effective usable lift top (preferring fine map lift, falling back to native lift when map lift is unavailable). */
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

/** Resolves the Lenschow convective mixed-layer envelope for one forecast hour. */
export function resolveConvectiveEnvelope(
  groundM: number | null,
  usableTopM: number | null,
  thermalTopM: number | null,
  cloudCapM: number | null,
  thermalVelocityMps: number | null,
): ConvectiveColumnEnvelope | null {
  if (
    groundM === null ||
    usableTopM === null ||
    usableTopM <= groundM ||
    thermalVelocityMps === null ||
    thermalVelocityMps <= 0
  ) {
    return null;
  }
  const peakClimbMps = thermalVelocityMps * LENSCHOW_F_MAX - SINK_RATE_MPS;
  if (peakClimbMps <= 0) return null;
  const usableDepthM = usableTopM - groundM;
  const cloudCapped = cloudCapM !== null && usableTopM >= cloudCapM - 2;
  let convectiveDepthM: number;
  if (!cloudCapped) {
    const unitCrit = usableLiftDepthM(1, thermalVelocityMps);
    convectiveDepthM = unitCrit !== null && unitCrit > 0 ? usableDepthM / unitCrit : usableDepthM;
  } else {
    const nativeDepthM = thermalTopM !== null && thermalTopM > groundM ? thermalTopM - groundM : 0;
    convectiveDepthM = Math.max(usableDepthM, nativeDepthM);
  }
  if (!(convectiveDepthM > 0)) return null;
  return { groundM, usableTopM, convectiveDepthM, thermalVelocityMps, peakClimbMps };
}

/** Evaluates net paraglider climb rate (m/s) at `zM` MSL from the Lenschow updraft profile. */
export function estimateThermalClimbAtHeight(
  zM: number,
  groundM: number | null,
  usableTopM: number | null,
  thermalTopM: number | null,
  cloudCapM: number | null,
  thermalVelocityMps: number | null,
): { estimatedClimbMps: number | null; peakClimbMps: number | null } {
  const env = resolveConvectiveEnvelope(groundM, usableTopM, thermalTopM, cloudCapM, thermalVelocityMps);
  if (!env) return { estimatedClimbMps: null, peakClimbMps: null };
  if (zM < env.groundM || zM > env.usableTopM + 0.5) {
    return { estimatedClimbMps: 0, peakClimbMps: env.peakClimbMps };
  }
  const zeta = clamp((zM - env.groundM) / env.convectiveDepthM, 0, 1);
  const netClimb = Math.max(0, env.thermalVelocityMps * lenschowNormalizedUpdraft(zeta) - SINK_RATE_MPS);
  return { estimatedClimbMps: netClimb, peakClimbMps: env.peakClimbMps };
}

export type ConvectiveCloudRegime = 'none' | 'cu' | 'od';

export const HIGH_INSTABILITY_CAPE_JKG = 1000;

/**
 * Classifies convective cloud development at condensation base from `@av/soaring` diagnostics:
 * - `'none'`: blue thermals (parcel top stays below condensation limit) or non-convective
 * - `'cu'`: fair-weather cumulus (`cloudCapped` or parcel reaches LCL)
 * - `'od'`: stratocumulus spreadout (`hour.overdeveloped === true` per `@av/soaring`'s `mixedLayerLclM` & `RH >= 85%` check)
 */
export function classifyConvectiveCloudRegime(hour: PublishedForecastHour): ConvectiveCloudRegime {
  const wStar = finiteScalar(hour.thermalVelocityMps);
  if (wStar === null || wStar <= 0) return 'none';
  const limits = [hour.effectiveCloudLimitM, hour.surfaceLclM, hour.mixedLayerLclM]
    .filter((v): v is number => v !== null && Number.isFinite(v));
  if (!limits.length) return 'none';
  const lclM = Math.min(...limits);
  const liftTopM = effectiveHourUsableLiftTopM(hour);
  const topM = Math.max(
    hour.thermalTopM !== null && Number.isFinite(hour.thermalTopM) ? hour.thermalTopM : -Infinity,
    liftTopM !== null && Number.isFinite(liftTopM) ? liftTopM : -Infinity,
  );
  const hasCuSupport =
    hour.cloudCapped === true ||
    hour.overdeveloped === true ||
    (Number.isFinite(topM) && topM >= lclM - 25);
  if (!hasCuSupport) return 'none';
  if (hour.overdeveloped === true) return 'od';
  return 'cu';
}

/** Clips an ordered altitude field to `scale` bounds and projects heights into pixel offsets from plot bottom. */
export function clipFieldNodesToScale(
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

export interface HourCloudAnalysis {
  readonly layers: readonly WindgramCloudLayerSummary[];
  readonly convectiveLayer: WindgramCloudLayerSummary | null;
  readonly highCloudOnly: boolean;
}

/**
 * Segments discrete mixed-phase stratiform RH cloud decks and convective Cumulus/OD cloud towers
 * across the vertical profile, estimating each layer's base, top, depth, cloud-top temperature,
 * glaciation state, and aviation sky-cover code.
 */
export function analyzeHourCloudLayers(
  hour: PublishedForecastHour | undefined,
  sample: HourSampling | undefined,
  chartTopM?: number,
): HourCloudAnalysis {
  if (!hour) return { layers: [], convectiveLayer: null, highCloudOnly: false };
  const groundM = effectiveHourGroundM(hour) ?? 0;
  const lowPct = finiteScalar(hour.surface.cloudCoverLowPercent);
  const totalPct = finiteScalar(hour.surface.cloudCoverTotalPercent);
  const rhNodes = sample?.cloudHumidityPercent ?? sample?.relativeHumidityPercent ?? [];
  const tempAt = (zM: number): number | null =>
    sample ? finiteScalar(sampleHeight(sample.temperatureC, zM)) : null;

  const bandFor = (baseM: number, topM: number): WindgramCloudLayerSummary['altitudeBand'] => {
    const midAgl = (baseM + topM) / 2 - groundM;
    return midAgl < 2000 ? 'low' : midAgl < 6000 ? 'mid' : 'high';
  };

  // 1) Extract contiguous moist mixed-phase RH intervals (>= 83% RH) across the column
  const rawMoist: Array<{ baseM: number; topM: number; maxRh: number }> = [];
  for (let i = 1; i < rhNodes.length; i++) {
    const a = rhNodes[i - 1]!, b = rhNodes[i]!;
    if (!Number.isFinite(a.value) || !Number.isFinite(b.value)) continue;
    const peak = Math.max(a.value, b.value);
    if (peak < CLOUD_SCT_RH_PERCENT) continue;
    let baseM = a.altitudeM;
    let topM = b.altitudeM;
    if (a.value < CLOUD_SCT_RH_PERCENT && b.value !== a.value) {
      baseM += (b.altitudeM - a.altitudeM) * ((CLOUD_SCT_RH_PERCENT - a.value) / (b.value - a.value));
    }
    if (b.value < CLOUD_SCT_RH_PERCENT && b.value !== a.value) {
      topM = a.altitudeM + (b.altitudeM - a.altitudeM) * ((CLOUD_SCT_RH_PERCENT - a.value) / (b.value - a.value));
    }
    if (topM - baseM < 5) continue;
    const prev = rawMoist.at(-1);
    if (prev && baseM - prev.topM <= 120 && a.value >= 78) {
      prev.topM = topM;
      prev.maxRh = Math.max(prev.maxRh, peak);
    } else {
      rawMoist.push({ baseM, topM, maxRh: peak });
    }
  }

  const stratiformLayers: WindgramCloudLayerSummary[] = rawMoist
    .filter(m => m.topM - m.baseM >= 15 || m.maxRh >= CLOUD_RH_THRESHOLD_PERCENT)
    .map(m => {
      const altitudeBand = bandFor(m.baseM, m.topM);
      const saturated = m.maxRh >= CLOUD_RH_THRESHOLD_PERCENT;
      const rhFrac = clamp(1 - Math.sqrt(clamp((95.5 - m.maxRh) / (95.5 - 78), 0, 1)), 0.15, 1);
      let coverPercent = Math.round(rhFrac * 100);
      if (saturated) {
        coverPercent = Math.max(coverPercent, totalPct !== null && totalPct >= 70 ? Math.round(totalPct) : 90);
      } else if (altitudeBand === 'low' && lowPct !== null && lowPct >= 10) {
        coverPercent = Math.round(0.55 * coverPercent + 0.45 * clamp(lowPct, 0, 100));
      } else if (totalPct !== null && totalPct >= 15) {
        coverPercent = Math.min(Math.max(coverPercent, 25), Math.round(Math.max(coverPercent, totalPct * 0.85)));
      }
      coverPercent = clamp(coverPercent, 10, 100);
      const topTempC = tempAt(m.topM);
      return {
        kind: 'stratiform' as const,
        altitudeBand,
        baseM: m.baseM,
        topM: m.topM,
        depthM: Math.max(1, m.topM - m.baseM),
        coverageCode: skyCoverageCode(coverPercent),
        coverPercent,
        maxRhPercent: Math.round(clamp(m.maxRh, 0, 100)),
        saturated,
        topTempC,
        glaciated: topTempC !== null && topTempC <= -20,
      };
    });

  // 2) Resolve convective Cumulus / Overdeveloped cloud layer with parcel/moist depth and cloud-top glaciation
  const regime = classifyConvectiveCloudRegime(hour);
  let convectiveLayer: WindgramCloudLayerSummary | null = null;
  if (regime !== 'none') {
    const limits = [
      hour.effectiveCloudLimitM,
      hour.surfaceLclM,
      ...(regime === 'od' ? [hour.mixedLayerLclM ?? null] : []),
    ].filter((v): v is number => v !== null && Number.isFinite(v));
    if (limits.length) {
      const baseM = Math.min(...limits);
      const overlappingMoist = stratiformLayers.find(l => l.baseM <= baseM + 180 && l.topM >= baseM - 80);
      const parcelTop = finiteScalar(hour.thermalTopM);
      const cuPot = finiteScalar(hour.cuPotentialM);
      const candidateTop = Math.max(
        parcelTop ?? -Infinity,
        overlappingMoist?.topM ?? -Infinity,
        cuPot !== null && cuPot > 0 ? baseM + cuPot : -Infinity,
      );
      const minCuThickness = regime === 'od' ? 220 : 120;
      const topM = Math.max(baseM + minCuThickness, Number.isFinite(candidateTop) ? candidateTop : baseM + 160);
      const depthM = topM - baseM;
      const maxRhAtBase = overlappingMoist?.maxRhPercent
        ?? (rhNodes.length ? Math.round(clamp(sampleHeight(rhNodes, baseM) ?? 0, 0, 100)) || null : null);
      let coverPercent: number;
      if (regime === 'od') {
        coverPercent = clamp(Math.round(Math.max(lowPct ?? 0, (totalPct ?? 0) * 0.85, 72)), 58, 100);
      } else if (lowPct !== null && lowPct >= 8) {
        coverPercent = clamp(Math.round(lowPct), 10, 86);
      } else if (totalPct !== null && totalPct >= 8 && totalPct <= 60) {
        coverPercent = Math.round(totalPct);
      } else {
        coverPercent = clamp(Math.round(22 + depthM / 32), 20, 50);
      }
      const topTempC = tempAt(topM);
      convectiveLayer = {
        kind: regime === 'od' ? 'overdeveloped' : 'cumulus',
        altitudeBand: bandFor(baseM, topM),
        baseM,
        topM,
        depthM,
        coverageCode: skyCoverageCode(coverPercent),
        coverPercent,
        maxRhPercent: maxRhAtBase,
        saturated: Boolean(overlappingMoist?.saturated),
        topTempC,
        glaciated: topTempC !== null && topTempC <= -20,
      };
    }
  }

  const filteredStratiform = convectiveLayer
    ? stratiformLayers.filter(l => {
        if (l.saturated) return true;
        const overlap = Math.min(l.topM, convectiveLayer!.topM) - Math.max(l.baseM, convectiveLayer!.baseM);
        return overlap < l.depthM * 0.65;
      })
    : stratiformLayers;

  const layers = [...filteredStratiform, ...(convectiveLayer ? [convectiveLayer] : [])]
    .sort((a, b) => a.baseM - b.baseM);

  let inDomainMaxRh = 0;
  for (const node of rhNodes) {
    if (!Number.isFinite(node.value)) continue;
    if (chartTopM === undefined || node.altitudeM <= chartTopM + 50) {
      if (node.value > inDomainMaxRh) inDomainMaxRh = node.value;
    }
  }
  const hasSubstantialInDomainLayer = layers.some(
    l => (chartTopM === undefined || l.baseM <= chartTopM + 50) && (l.coverPercent >= 48 || l.saturated || l.kind === 'overdeveloped'),
  );
  const highCloudOnly =
    totalPct !== null &&
    totalPct >= 50 &&
    (lowPct ?? 0) < 25 &&
    inDomainMaxRh < 86 &&
    !hasSubstantialInDomainLayer &&
    hour.overdeveloped !== true;

  return { layers, convectiveLayer, highCloudOnly };
}

export interface SkyCoverSpan {
  readonly x: number;
  readonly width: number;
  readonly tier: 'bkn' | 'ovc';
  readonly coverPercent: number;
  /** True when heavy sky cover originates strictly above the plotted soaring ceiling (e.g. high cirrus). */
  readonly highLevelOnly?: boolean;
}

/**
 * Builds contiguous top-of-plot sky-cover ceiling spans for Broken (65–84%)
 * or Overcast (>=85%) sky cover, distinguishing high cirrus shade (`highLevelOnly`) from
 * thick low/mid overcast inside the soaring domain.
 */
export function buildSkyCoverSpans(args: {
  sourceHours: readonly PublishedForecastHour[];
  sampling: readonly HourSampling[];
  viewHours: readonly { x: number }[];
  columnWidth: number;
  leftBound: number;
  rightBound: number;
  topM?: number;
}): SkyCoverSpan[] {
  const { sourceHours, sampling, viewHours, columnWidth, leftBound, rightBound, topM } = args;
  if (!viewHours.length) return [];
  const spans: SkyCoverSpan[] = [];

  for (let i = 0; i < viewHours.length; i++) {
    const src = sourceHours[i];
    const totalPct = finiteScalar(src?.surface.cloudCoverTotalPercent);
    const lowPct = finiteScalar(src?.surface.cloudCoverLowPercent);
    const rhNodes = sampling[i]?.cloudHumidityPercent ?? sampling[i]?.relativeHumidityPercent ?? [];
    let maxRh = 0;
    let inDomainMaxRh = 0;
    let highCeilingRh = 0;
    for (const node of rhNodes) {
      if (!Number.isFinite(node.value)) continue;
      if (node.value > maxRh) maxRh = node.value;
      if (topM === undefined || node.altitudeM <= topM + 50) {
        if (node.value > inDomainMaxRh) inDomainMaxRh = node.value;
      }
      if (topM !== undefined && node.altitudeM >= topM * 0.92 && node.value > highCeilingRh) {
        highCeilingRh = node.value;
      }
    }
    const rhFallbackPct = totalPct === null
      ? (maxRh >= CLOUD_RH_THRESHOLD_PERCENT ? 95 : maxRh >= CLOUD_BKN_RH_PERCENT ? 70 : 0)
      : (highCeilingRh >= CLOUD_RH_THRESHOLD_PERCENT ? 95 : 0);
    const pct = clamp(Math.max(totalPct ?? 0, rhFallbackPct), 0, 100);
    const tier: SkyCoverSpan['tier'] | null = pct >= 85 ? 'ovc' : pct >= 65 ? 'bkn' : null;
    if (!tier) continue;
    const highLevelOnly =
      totalPct !== null &&
      lowPct !== null &&
      lowPct < 35 &&
      inDomainMaxRh < 86 &&
      src?.overdeveloped !== true;

    const x0 = Math.max(leftBound, hourX(viewHours, i - 0.5, columnWidth));
    const x1 = Math.min(rightBound, hourX(viewHours, i + 0.5, columnWidth));
    const width = x1 - x0;
    if (width <= 0.2) continue;

    const prev = spans.at(-1);
    if (
      prev &&
      prev.tier === tier &&
      Boolean(prev.highLevelOnly) === highLevelOnly &&
      Math.abs(prev.x + prev.width - x0) < 0.75
    ) {
      spans[spans.length - 1] = {
        x: prev.x,
        width: x1 - prev.x,
        tier,
        coverPercent: Math.max(prev.coverPercent, pct),
        ...(highLevelOnly ? { highLevelOnly: true } : {}),
      };
    } else {
      spans.push({
        x: x0,
        width,
        tier,
        coverPercent: pct,
        ...(highLevelOnly ? { highLevelOnly: true } : {}),
      });
    }
  }
  return spans;
}

/**
 * Generates smooth marching-square isoband SVG paths for the Lenschow net-climb dome,
 * using fine `usableLiftTopM` when available and continuing with `nativeUsableLiftTopM`
 * on forecast days beyond `mapFrameCount`.
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

  const envelopes = viewHours.map((vh, i) => {
    const src = sourceHours[i];
    if (!src) return null;
    const groundM = effectiveHourGroundM(src);
    const effectiveTopM = effectiveHourUsableLiftTopM(src, vh.usableLiftTopM);
    return resolveConvectiveEnvelope(
      groundM,
      effectiveTopM,
      src.thermalTopM ?? null,
      src.effectiveCloudLimitM ?? null,
      finiteScalar(src.thermalVelocityMps),
    );
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

  const rows = Math.max(4, Math.ceil(plotHeight / 2.5));
  const zAtRow = Array.from({ length: rows + 1 }, (_, r) =>
    yToHeight(scale, plotTop + (r / rows) * plotHeight),
  );
  const dzPerRow = Math.max(1, Math.abs((zAtRow[0] ?? 1) - (zAtRow[1] ?? 0)));
  const thresholds = WINDGRAM_CLIMB_BANDS.map(b => b.minMps);
  const classNames = WINDGRAM_CLIMB_BANDS.map(b => b.className);
  const pathsByClass = new Map<string, string[]>();

  for (const [startIdx, endIdx] of runs) {
    const rampLeft = startIdx > 0;
    const rampRight = endIdx < n - 1;
    const tMin = startIdx - (rampLeft ? 0.46 : 0.5);
    const tMax = endIdx + (rampRight ? 0.46 : 0.5);
    const subCols = Math.max(8, Math.ceil((tMax - tMin) * 10));

    const xs: number[] = [];
    const colValues: number[][] = Array.from({ length: rows + 1 }, () => []);

    for (let c = 0; c <= subCols; c++) {
      const t = tMin + ((tMax - tMin) * c) / subCols;
      const x = clamp(hourX(viewHours, t, columnWidth), leftBound, rightBound);
      xs.push(x);

      let groundM: number;
      let usableTopM: number;
      let convectiveDepthM: number;
      let wStar: number;

      if (t < startIdx) {
        const env = envelopes[startIdx]!;
        if (rampLeft) {
          const frac = clamp((t - tMin) / Math.max(1e-6, startIdx - tMin), 0, 1);
          const eased = Math.sqrt(frac);
          groundM = env.groundM;
          usableTopM = env.groundM + (env.usableTopM - env.groundM) * eased;
          convectiveDepthM = Math.max(1, env.convectiveDepthM * eased);
          wStar = env.thermalVelocityMps * (0.75 + 0.25 * frac);
        } else {
          ({ groundM, usableTopM, convectiveDepthM, thermalVelocityMps: wStar } = env);
        }
      } else if (t > endIdx) {
        const env = envelopes[endIdx]!;
        if (rampRight) {
          const frac = clamp((tMax - t) / Math.max(1e-6, tMax - endIdx), 0, 1);
          const eased = Math.sqrt(frac);
          groundM = env.groundM;
          usableTopM = env.groundM + (env.usableTopM - env.groundM) * eased;
          convectiveDepthM = Math.max(1, env.convectiveDepthM * eased);
          wStar = env.thermalVelocityMps * (0.75 + 0.25 * frac);
        } else {
          ({ groundM, usableTopM, convectiveDepthM, thermalVelocityMps: wStar } = env);
        }
      } else {
        const lo = Math.floor(t);
        const hi = Math.min(endIdx, Math.ceil(t));
        const f = t - lo;
        const a = envelopes[lo]!;
        const b = envelopes[hi]!;
        groundM = a.groundM + (b.groundM - a.groundM) * f;
        usableTopM = a.usableTopM + (b.usableTopM - a.usableTopM) * f;
        convectiveDepthM = a.convectiveDepthM + (b.convectiveDepthM - a.convectiveDepthM) * f;
        wStar = a.thermalVelocityMps + (b.thermalVelocityMps - a.thermalVelocityMps) * f;
      }

      for (let r = 0; r <= rows; r++) {
        const z = zAtRow[r]!;
        if (z > usableTopM) {
          colValues[r]!.push(-0.04 * ((z - usableTopM) / dzPerRow));
        } else if (z < groundM) {
          colValues[r]!.push(-0.04 * ((groundM - z) / dzPerRow));
        } else {
          const zeta = clamp((z - groundM) / Math.max(1, convectiveDepthM), 0, 1);
          const netClimb = Math.max(0, wStar * lenschowNormalizedUpdraft(zeta) - SINK_RATE_MPS);
          const edgeRamp = 0.04 * Math.min(1, (usableTopM - z) / dzPerRow, (z - groundM) / dzPerRow);
          colValues[r]!.push(Math.max(edgeRamp, netClimb));
        }
      }
    }

    const bandPaths = contourGridIsobands({
      values: colValues,
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

function contourGridIsobands(args: {
  values: readonly (readonly number[])[];
  xs: readonly number[];
  rows: number;
  cols: number;
  plotTop: number;
  plotBottom: number;
  thresholds: readonly number[];
  classNames: readonly string[];
}): Record<string, string> {
  const { values, xs, rows, cols, plotTop, plotBottom, thresholds, classNames } = args;
  const plotHeight = plotBottom - plotTop;
  const left = xs[0]!;
  const right = xs[cols]!;
  const xOf = (c: number) => {
    if (c <= 0) return left;
    if (c >= cols) return right;
    const lo = Math.floor(c);
    const hi = Math.min(cols, lo + 1);
    return xs[lo]! + (xs[hi]! - xs[lo]!) * (c - lo);
  };
  const yOf = (r: number) => plotTop + (clamp(r, 0, rows) / rows) * plotHeight;
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  const shortNum = (v: number) => Number(v.toFixed(1));

  const thresholdRings = (t: number): [number, number][][] => {
    type Seg = { from: [number, number]; to: [number, number]; used: boolean };
    const allSegments: Seg[] = [];
    const byStart = new Map<string, Seg[]>();
    const ptKey = (p: [number, number]) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`;
    const addSeg = (from: [number, number], to: [number, number]) => {
      const fk = ptKey(from);
      if (fk === ptKey(to)) return;
      const seg: Seg = { from, to, used: false };
      allSegments.push(seg);
      const q = byStart.get(fk);
      if (q) q.push(seg);
      else byStart.set(fk, [seg]);
    };
    const valAt = (r: number, c: number) =>
      r >= 0 && r <= rows && c >= 0 && c <= cols ? values[r]![c]! : -1;
    const insideAt = (r: number, c: number) => valAt(r, c) >= t;
    const frac = (a: number, b: number) => (a === b ? 0.5 : clamp01((t - a) / (b - a)));

    for (let r = -1; r <= rows; r++) {
      for (let c = -1; c <= cols; c++) {
        const tl = insideAt(r, c);
        const tr = insideAt(r, c + 1);
        const br = insideAt(r + 1, c + 1);
        const bl = insideAt(r + 1, c);
        const idx = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0);
        if (idx === 0 || idx === 15) continue;
        const vTL = valAt(r, c);
        const vTR = valAt(r, c + 1);
        const vBR = valAt(r + 1, c + 1);
        const vBL = valAt(r + 1, c);
        const topPt: [number, number] = [xOf(c + frac(vTL, vTR)), yOf(r)];
        const botPt: [number, number] = [xOf(c + frac(vBL, vBR)), yOf(r + 1)];
        const leftPt: [number, number] = [xOf(c), yOf(r + frac(vTL, vBL))];
        const rightPt: [number, number] = [xOf(c + 1), yOf(r + frac(vTR, vBR))];
        const centreIn = (vTL + vTR + vBR + vBL) / 4 >= t;
        switch (idx) {
          case 1: addSeg(leftPt, botPt); break;
          case 2: addSeg(botPt, rightPt); break;
          case 3: addSeg(leftPt, rightPt); break;
          case 4: addSeg(rightPt, topPt); break;
          case 6: addSeg(botPt, topPt); break;
          case 7: addSeg(leftPt, topPt); break;
          case 8: addSeg(topPt, leftPt); break;
          case 9: addSeg(topPt, botPt); break;
          case 11: addSeg(topPt, rightPt); break;
          case 12: addSeg(rightPt, leftPt); break;
          case 13: addSeg(rightPt, botPt); break;
          case 14: addSeg(botPt, leftPt); break;
          case 5:
            if (centreIn) { addSeg(leftPt, topPt); addSeg(rightPt, botPt); }
            else { addSeg(leftPt, botPt); addSeg(rightPt, topPt); }
            break;
          case 10:
            if (centreIn) { addSeg(topPt, rightPt); addSeg(botPt, leftPt); }
            else { addSeg(topPt, leftPt); addSeg(botPt, rightPt); }
            break;
        }
      }
    }

    const takeFrom = (k: string) => {
      const q = byStart.get(k);
      if (!q) return null;
      while (q.length) {
        const cand = q[q.length - 1]!;
        if (!cand.used) return cand;
        q.pop();
      }
      return null;
    };
    const out: [number, number][][] = [];
    for (const first of allSegments) {
      if (first.used) continue;
      const ring: [number, number][] = [first.from];
      let cur: Seg | null = first;
      while (cur) {
        cur.used = true;
        ring.push(cur.to);
        cur = takeFrom(ptKey(cur.to));
      }
      if (ring.length >= 4) out.push(ring);
    }
    return out;
  };

  const ringCache = new Map<number, [number, number][][]>();
  const ringsAt = (t: number) => {
    let cached = ringCache.get(t);
    if (!cached) {
      cached = thresholdRings(t);
      ringCache.set(t, cached);
    }
    return cached;
  };

  const result: Record<string, string> = {};
  for (let i = 0; i < classNames.length; i++) {
    const sets: [number, number][][][] = [ringsAt(thresholds[i]!)];
    if (i + 1 < thresholds.length) sets.push(ringsAt(thresholds[i + 1]!));
    const parts: string[] = [];
    for (const set of sets) {
      for (const ring of set) {
        const rounded: [number, number][] = [];
        for (const pt of ring) {
          const x = shortNum(pt[0]);
          const y = shortNum(pt[1]);
          const last = rounded[rounded.length - 1];
          if (last && last[0] === x && last[1] === y) continue;
          const prev = rounded[rounded.length - 2];
          if (last && prev && Math.abs((last[0] - prev[0]) * (y - prev[1]) - (last[1] - prev[1]) * (x - prev[0])) < 0.3) {
            last[0] = x;
            last[1] = y;
            continue;
          }
          rounded.push([x, y]);
        }
        if (rounded.length >= 3) {
          parts.push(rounded.map(([x, y], idx) => `${idx === 0 ? 'M' : 'L'}${x} ${y}`).join('') + 'Z');
        }
      }
    }
    if (parts.length) result[classNames[i]!] = parts.join('');
  }
  return result;
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
        banding: {
          breakpoints: [0, 0.5],
          classNames: ['', 'wg-inversion-weak', 'wg-inversion-strong'],
        },
      })
    : {};

  // Resolved statically stable model vertical velocity w_ω aloft
  const wProfilesByHour = hours.map((vh, i) => {
    const src = sourceHours?.[i];
    if (!src?.levels.length) return null;
    if (!src.levels.some(l => l.omegaPaS !== null && Number.isFinite(l.omegaPaS))) return null;
    const precip = finiteScalar(src.surface.precipitationMmHr);
    if (precip !== null && precip >= 0.08) return null;
    const lapseNodes = sampling[i]?.lapseCPer1000Ft ?? [];
    const thermalCeilingM = effectiveHourUsableLiftTopM(src, vh.usableLiftTopM) ?? effectiveHourGroundM(src) ?? floorM;
    const nodes = src.levels
      .filter((l): l is typeof l & { heightM: number } => l.heightM !== null && Number.isFinite(l.heightM))
      .sort((a, b) => a.heightM - b.heightM)
      .map(l => {
        if (l.omegaPaS === null || !Number.isFinite(l.omegaPaS) || l.heightM <= thermalCeilingM + 20) {
          return { altitudeM: l.heightM, value: 0 };
        }
        const localLapse = lapseNodes.length ? sampleHeight(lapseNodes, l.heightM) : null;
        if (localLapse !== null && Number.isFinite(localLapse) && localLapse <= WAVE_MIN_LAPSE_C_PER_1000FT) {
          return { altitudeM: l.heightM, value: 0 };
        }
        const levelWind = windFromComponents(finiteScalar(l.uWindMps), finiteScalar(l.vWindMps));
        const speedKt = levelWind.speedMps === null ? null : mpsToKnots(levelWind.speedMps);
        if (speedKt !== null && speedKt < WAVE_MIN_WIND_KT) {
          return { altitudeM: l.heightM, value: 0 };
        }
        const w = omegaToVerticalVelocityMps(l.omegaPaS, l.temperatureC, l.pressureHpa, l.heightM);
        return {
          altitudeM: l.heightM,
          value: w === null ? 0 : w,
        };
      });
    return nodes.length ? nodes : null;
  });

  const hasWaveAscent = wProfilesByHour.some(
    nodes => nodes !== null && nodes.some(n => Number.isFinite(n.value) && n.value >= WAVE_ASCENT_MIN_MPS),
  );
  const waveMap: Record<string, string> = (() => {
    if (!hasWaveAscent || plotBottom <= plotTop) return {};
    const plotH = plotBottom - plotTop;
    const rows = Math.max(6, Math.ceil(plotH / 3.5));
    const zAtRow = Array.from({ length: rows + 1 }, (_, r) => yToHeight(scale, plotTop + (r / rows) * plotH));
    const n = hours.length;
    const lBound = leftBound ?? hourX(hours, -0.5, columnWidth);
    const rBound = rightBound ?? hourX(hours, n - 0.5, columnWidth);
    const subCols = Math.max(8, n * 8);
    const xs: number[] = [];
    const colValues: number[][] = Array.from({ length: rows + 1 }, () => []);
    const sampleHourW = (idx: number, z: number) => {
      const prof = wProfilesByHour[clamp(idx, 0, n - 1)];
      if (!prof) return 0;
      if (z < prof[0]!.altitudeM || z > prof.at(-1)!.altitudeM) return 0;
      return sampleHeight(prof, z) ?? 0;
    };
    for (let c = 0; c <= subCols; c++) {
      const t = -0.5 + (n * c) / subCols;
      xs.push(clamp(hourX(hours, t, columnWidth), lBound, rBound));
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
          wVal = sampleHourW(lo, z) * (1 - f) + sampleHourW(lo + 1, z) * f;
        }
        const rowEdge = Math.min(1, r / 1.5, (rows - r) / 1.5);
        colValues[r]!.push(wVal * rowEdge);
      }
    }
    return contourGridIsobands({
      values: colValues,
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
