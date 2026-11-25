// Multi-layer mixed-phase cloud segmentation: 3-tier RH decks (83% SCT / 89% BKN / 94% OVC), Cu/OD tower depth,
// resolved cloud-top temperature, high-cirrus separation, and top-of-plot sky-cover spans.

import { SKY_COVER_TIERS } from '@av/contracts/layers';
import type { HourSampling, PublishedForecastHour } from './internal-meteo.ts';
import type { SkyCoverageCode, WindgramCloudLayerSummary } from './scene-types.ts';
import { effectiveHourGroundM, effectiveHourUsableLiftTopM } from './windgram-climb.ts';
import { clamp, finiteScalar } from './windgram-format.ts';
import { CLOUD_RH_THRESHOLD_PERCENT, sampleHeight } from './windgram-sampling.ts';
import { hourX } from './windgram-time-axis.ts';

export const CLOUD_SCT_RH_PERCENT = 83;
export const CLOUD_BKN_RH_PERCENT = 89;

/** Standard aviation METAR/ASOS sky-cover category from 0..100% cloud fraction. */
export function skyCoverageCode(percent: number | null | undefined): SkyCoverageCode {
  if (percent === null || percent === undefined || !Number.isFinite(percent) || percent < 6) return 'CLR';
  if (percent <= 25) return 'FEW';
  if (percent <= 50) return 'SCT';
  if (percent < SKY_COVER_TIERS.overcast) return 'BKN';
  return 'OVC';
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
      const diagnosedTop = Number.isFinite(candidateTop) && candidateTop > baseM ? candidateTop : null;
      const topM = diagnosedTop ?? baseM;
      const depthM = diagnosedTop !== null ? Math.max(0, diagnosedTop - baseM) : 0;
      const maxRhAtBase = overlappingMoist?.maxRhPercent
        ?? (rhNodes.length ? Math.round(clamp(sampleHeight(rhNodes, baseM) ?? 0, 0, 100)) || null : null);
      let coverPercent: number;
      if (regime === 'od') {
        coverPercent = clamp(Math.round(Math.max(lowPct ?? 0, (totalPct ?? 0) * 0.85, 72)), 58, 100);
      } else if (lowPct !== null && lowPct >= 8) {
        coverPercent = clamp(Math.round(lowPct), 10, 86);
      } else if (totalPct !== null && totalPct >= 8 && totalPct <= 60) {
        coverPercent = Math.round(totalPct);
      } else if (depthM > 0) {
        coverPercent = clamp(Math.round(22 + depthM / 32), 20, 50);
      } else {
        coverPercent = Math.round(clamp(lowPct ?? totalPct ?? 0, 0, 100));
      }
      const topTempC = depthM > 0 ? tempAt(topM) : null;
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
  let inDomainRhSamples = 0;
  for (const node of rhNodes) {
    if (!Number.isFinite(node.value)) continue;
    if (chartTopM === undefined || node.altitudeM <= chartTopM + 50) {
      inDomainRhSamples++;
      if (node.value > inDomainMaxRh) inDomainMaxRh = node.value;
    }
  }
  const hasSubstantialInDomainLayer = layers.some(
    l => (chartTopM === undefined || l.baseM <= chartTopM + 50) && (l.coverPercent >= 48 || l.saturated || l.kind === 'overdeveloped'),
  );
  const highCloudOnly =
    totalPct !== null &&
    totalPct >= 50 &&
    inDomainRhSamples > 0 &&
    (lowPct === null ? inDomainMaxRh < 75 : lowPct < 25) &&
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
 * or Overcast (>=85%) model total cloud (humidity-inferred only where total cloud is missing), distinguishing high cirrus shade (`highLevelOnly`) from
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
    for (const node of rhNodes) {
      if (!Number.isFinite(node.value)) continue;
      if (node.value > maxRh) maxRh = node.value;
      if (topM === undefined || node.altitudeM <= topM + 50) {
        if (node.value > inDomainMaxRh) inDomainMaxRh = node.value;
      }
    }
    // Model total cloud when published; humidity only stands in for it when it is missing.
    const pct = clamp(totalPct ?? (maxRh >= CLOUD_RH_THRESHOLD_PERCENT ? 95 : maxRh >= CLOUD_BKN_RH_PERCENT ? 70 : 0), 0, 100);
    const tier: SkyCoverSpan['tier'] | null = pct >= SKY_COVER_TIERS.overcast ? 'ovc' : pct >= SKY_COVER_TIERS.broken ? 'bkn' : null;
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
