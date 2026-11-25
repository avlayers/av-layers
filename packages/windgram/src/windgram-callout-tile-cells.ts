// Hover-tile cell content for quadrants 1-3: wind, climb, and sky for one reading.

import { FEET_PER_MINUTE_TO_MPS } from '@av/soaring';
import type { WindgramReading } from './scene-types.ts';
import { skyCoverageCode } from './windgram-clouds.ts';
import {
  clamp,
  compass16,
  convertQuantity,
  fahrenheitToCelsius,
  knotsToMps,
  mpsToKnots,
  svgNumber as fmt,
  unitLabel,
  type UnitSystem,
} from './windgram-format.ts';
import { resolveSnappedTolClimb } from './windgram-readout.ts';
import { CLOUD_RH_THRESHOLD_PERCENT } from './windgram-sampling.ts';
import { setAttr, setText } from './windgram-svg-dom.ts';
import { classifyParagliderWind, WIND_SPEED_KNOT_THRESHOLDS, type ParagliderWindLevel } from './windgram-wind-tiers.ts';

type ClimbVisualLevel = 'none' | 'mild' | 'good' | 'strong';

export const TILE_VARIO_MAX_PX = 18;

/** Live tile nodes; each is null when the mounted markup lacks it. */
export interface TileElements {
  readonly back: Element | null;
  readonly windBg: Element | null;
  readonly dial: Element | null;
  readonly windArrow: Element | null;
  readonly windCalm: Element | null;
  readonly windSpeed: Element | null;
  readonly windDir: Element | null;
  readonly climbFill: Element | null;
  readonly climbVal: Element | null;
  readonly climbSub: Element | null;
  readonly cloudBg: Element | null;
  readonly oktas: readonly (Element | null)[];
  readonly skyCodeEl: Element | null;
  readonly cloudText: Element | null;
  readonly rainBg: Element | null;
  readonly tempEl: Element | null;
  readonly dewpointEl: Element | null;
  readonly rainIcon: Element | null;
  readonly hazardEl: Element | null;
}

export function classifyClimbLevel(climbMps: number | null): ClimbVisualLevel {
  if (climbMps === null || !Number.isFinite(climbMps) || climbMps < 0.05) return 'none';
  if (climbMps < 1.5) return 'mild';
  if (climbMps < 3.5) return 'good';
  return 'strong';
}

/** Quantizes 0..100% sky cover into 0..5 oktas-style indicator segments. */
export function cloudOktasSegments(cloudPercent: number | null): number {
  if (cloudPercent === null || !Number.isFinite(cloudPercent) || cloudPercent <= 5) return 0;
  return clamp(Math.ceil(clamp(cloudPercent, 0, 100) / 20), 1, 5);
}

function formatCompactClimb(mps: number, system: UnitSystem): string {
  const sign = mps < 0 ? '-' : '+';
  const abs = Math.abs(mps);
  if (system === 'imperial') {
    const fpm = Math.round((abs / FEET_PER_MINUTE_TO_MPS) / 5) * 5;
    return fpm > 0 ? `${sign}${fpm.toLocaleString('en-US')} fpm` : '0 fpm';
  }
  const rounded = Math.round(abs * 10) / 10;
  return rounded > 0 ? `${sign}${rounded.toFixed(1)} m/s` : '0.0 m/s';
}

function formatCompactSpan(metres: number, system: UnitSystem): string {
  const converted = convertQuantity(Math.max(10, metres), 'elevation', system) ?? metres;
  if (system === 'metric') {
    const rounded = converted >= 100 ? Math.round(converted / 10) * 10 : Math.max(10, Math.round(converted / 5) * 5);
    return `${rounded.toLocaleString('en-US')} m`;
  }
  if (converted >= 10_000) {
    return `${(converted / 1000).toFixed(1)}k ft`;
  }
  const roundedFt = Math.max(50, Math.round(converted / 50) * 50);
  return `${roundedFt.toLocaleString('en-US')} ft`;
}

/** Cloud, inversion, rain, and shear state at the inspected height. */
export function tileConditions(reading: WindgramReading, useTol: boolean) {
  const rawLiquidRh = reading.relativeHumidityPercent !== null && Number.isFinite(reading.relativeHumidityPercent)
    ? clamp(reading.relativeHumidityPercent, 0, 100)
    : null;
  const liquidRhVal = rawLiquidRh !== null ? Math.round(rawLiquidRh) : null;
  const rawCloudRh = reading.cloudHumidityPercent ?? reading.relativeHumidityPercent;
  const clampedCloudRh = rawCloudRh !== null && Number.isFinite(rawCloudRh)
    ? clamp(rawCloudRh, 0, 100)
    : null;
  const cloudRhVal = clampedCloudRh !== null ? Math.round(clampedCloudRh) : null;
  const inLiquidSaturatedCloud = rawLiquidRh !== null && rawLiquidRh >= CLOUD_RH_THRESHOLD_PERCENT;
  const inSaturatedCloud = reading.cloud === 'humidity' || (clampedCloudRh !== null && clampedCloudRh >= CLOUD_RH_THRESHOLD_PERCENT);
  const activeLayer = reading.activeCloudLayer ?? null;
  const inStratiformDeck = activeLayer?.kind === 'stratiform';
  const inConvectiveTower =
    !useTol &&
    activeLayer !== null &&
    activeLayer.kind !== 'stratiform' &&
    activeLayer.depthM >= 50 &&
    reading.heightM > activeLayer.baseM + 20;
  const inAnyCloudAtHeight = inSaturatedCloud || inStratiformDeck || inConvectiveTower;
  const inInversion = reading.lapseCPer1000Ft != null && Number.isFinite(reading.lapseCPer1000Ft) && reading.lapseCPer1000Ft > 0.05;
  const precipMm = reading.precipitationMmHr;
  const hasRain = precipMm !== null && Number.isFinite(precipMm) && precipMm > 0.04;
  const shearedLift =
    reading.buoyancyShearRatio != null &&
    Number.isFinite(reading.buoyancyShearRatio) &&
    reading.buoyancyShearRatio <= 0.35;
  return {
    liquidRhVal,
    cloudRhVal,
    inLiquidSaturatedCloud,
    inSaturatedCloud,
    activeLayer,
    inStratiformDeck,
    inConvectiveTower,
    inAnyCloudAtHeight,
    inInversion,
    precipMm,
    hasRain,
    shearedLift,
  };
}

export type TileConditions = ReturnType<typeof tileConditions>;

/** Quadrant 1 also sets the tile border alert tier. */
export function paintWindCell(
  el: TileElements,
  reading: WindgramReading,
  unitSystem: UnitSystem,
): { readonly effectiveAlert: ParagliderWindLevel; readonly nearSurface: boolean } {
  const { back, windBg, dial, windArrow, windCalm, windSpeed, windDir } = el;
  // Quadrant 1: Wind vector + speed + compass direction + 10 m surface gust
  const speedMps = reading.speedKt === null ? null : knotsToMps(reading.speedKt);
  const pgWind = classifyParagliderWind(speedMps);
  const modelAglM = reading.modelTerrainM !== null && reading.heightM >= reading.modelTerrainM
    ? reading.heightM - reading.modelTerrainM
    : null;
  const nearSurface = reading.heightAglM !== null
    ? reading.heightAglM <= 150
    : (modelAglM !== null && modelAglM <= 150);
  const surfaceWindKt = reading.surfaceWindSpeedMps !== null && Number.isFinite(reading.surfaceWindSpeedMps)
    ? mpsToKnots(reading.surfaceWindSpeedMps)
    : null;
  const gustSpreadGateKt = reading.gustKt !== null && reading.gustKt >= WIND_SPEED_KNOT_THRESHOLDS.whiteMaxKt ? 4 : 5;
  const hasSurfaceGustExcess =
    reading.gustKt !== null &&
    Number.isFinite(reading.gustKt) &&
    surfaceWindKt !== null &&
    reading.gustKt - surfaceWindKt >= gustSpreadGateKt;
  const hasNearSurfaceGust = nearSurface && hasSurfaceGustExcess;
  const gustKt = reading.gustKt !== null && Number.isFinite(reading.gustKt) ? reading.gustKt : null;
  const gustRounded = gustKt !== null
    ? Math.round(convertQuantity(knotsToMps(gustKt), 'wind', unitSystem) ?? 0)
    : 0;
  const gustTag = hasNearSurfaceGust
    ? ` · G${gustRounded}`
    : (!nearSurface && hasSurfaceGustExcess && gustKt !== null && gustKt >= WIND_SPEED_KNOT_THRESHOLDS.whiteMaxKt)
      ? ` · Sfc G${gustRounded}`
      : '';
  const effectiveAlert: ParagliderWindLevel =
    hasNearSurfaceGust && gustKt !== null && gustKt >= WIND_SPEED_KNOT_THRESHOLDS.yellowMaxKt && (pgWind === 'calm' || pgWind === 'ok' || pgWind === 'moderate' || pgWind === 'caution')
      ? 'danger'
      : hasNearSurfaceGust && gustKt !== null && gustKt >= WIND_SPEED_KNOT_THRESHOLDS.whiteMaxKt && (pgWind === 'calm' || pgWind === 'ok' || pgWind === 'moderate')
        ? 'caution'
        : pgWind;
  const borderMod = effectiveAlert === 'pennant'
    ? ' is-pennant'
    : effectiveAlert === 'danger'
      ? ' is-danger'
      : effectiveAlert === 'caution'
        ? ' is-caution'
        : '';
  setAttr(back, 'class', `wg-tile-back${borderMod}`);
  setAttr(windBg, 'class', `wg-tile-cell-tint${borderMod}`);
  setAttr(dial, 'class', `wg-tile-dial is-${pgWind}`);

  if (pgWind === 'missing') {
    setAttr(windArrow, 'visibility', 'hidden');
    setAttr(windCalm, 'visibility', 'hidden');
    setText(windSpeed, '—');
    setAttr(windSpeed, 'class', 'wg-tile-val is-muted');
    setText(windDir, gustTag ? gustTag.slice(3) : '—');
    setAttr(windDir, 'class', 'wg-tile-sub');
  } else if (pgWind === 'calm') {
    const dispSpeed = Math.round(convertQuantity(speedMps, 'wind', unitSystem) ?? 0);
    const cardinal = reading.directionDeg === null ? '—' : compass16(reading.directionDeg);
    setAttr(windArrow, 'visibility', 'hidden');
    setAttr(windCalm, 'visibility', 'visible');
    setText(windSpeed, `${dispSpeed} ${unitLabel('wind', unitSystem)}`);
    setAttr(windSpeed, 'class', 'wg-tile-val is-ok');
    setText(windDir, `${cardinal}${gustTag}`);
    setAttr(windDir, 'class', borderMod ? `wg-tile-sub${borderMod}` : 'wg-tile-sub');
  } else {
    const dispSpeed = Math.round(convertQuantity(speedMps, 'wind', unitSystem) ?? 0);
    const dir = reading.directionDeg;
    const cardinal = dir === null ? '—' : compass16(dir);
    if (dir !== null) {
      const downwindDeg = fmt((dir + 180) % 360);
      setAttr(windArrow, 'transform', `translate(16.5 33) rotate(${downwindDeg})`);
      const arrowMod = pgWind === 'pennant'
        ? ' is-pennant'
        : pgWind === 'danger'
          ? ' is-danger'
          : pgWind === 'caution'
            ? ' is-caution'
            : pgWind === 'moderate'
              ? ' is-moderate'
              : '';
      setAttr(windArrow, 'class', `wg-tile-arrow${arrowMod}`);
      setAttr(windArrow, 'visibility', 'visible');
      setAttr(windCalm, 'visibility', 'hidden');
    } else {
      setAttr(windArrow, 'visibility', 'hidden');
      setAttr(windCalm, 'visibility', 'visible');
    }
    setText(windSpeed, `${dispSpeed} ${unitLabel('wind', unitSystem)}`);
    setAttr(windSpeed, 'class', `wg-tile-val is-${pgWind}`);
    setText(windDir, `${cardinal}${gustTag}`);
    setAttr(windDir, 'class', borderMod ? `wg-tile-sub${borderMod}` : 'wg-tile-sub');
  }
  return { effectiveAlert, nearSurface };
}

/** Returns the climb rate shown in quadrant 2, or null when none applies. */
export function paintClimbCell(
  el: TileElements,
  reading: WindgramReading,
  conditions: TileConditions,
  useTol: boolean,
  unitSystem: UnitSystem,
): number | null {
  const { climbFill, climbVal, climbSub } = el;
  const { inInversion, shearedLift, hasRain, inConvectiveTower, activeLayer } = conditions;
  // Quadrant 2: Variometer Climb Rate & Neutral Model Vertical Motion
  let displayClimbMps: number | null = null;
  let climbCaption = inInversion && !useTol ? 'Inversion lid' : 'No thermal';
  let climbSubClass = 'wg-tile-sub';
  let waveMode: 'none' | 'up' | 'down' = 'none';
  if (useTol) {
    const snappedClimb = resolveSnappedTolClimb(reading);
    if (snappedClimb) {
      displayClimbMps = snappedClimb.climbMps;
      climbCaption = snappedClimb.tileCaption;
    }
  } else if (reading.estimatedClimbMps !== null && reading.estimatedClimbMps >= 0.05) {
    displayClimbMps = reading.estimatedClimbMps;
    if (shearedLift) {
      climbCaption = '▲ Sheared lift';
      climbSubClass = 'wg-tile-sub is-caution';
    } else {
      climbCaption = '▲ Thermal';
    }
  } else if (!hasRain && reading.waveVelocityMps != null && reading.waveVelocityMps >= 0.5) {
    displayClimbMps = reading.waveVelocityMps;
    climbCaption = '▲ Model ascent';
    climbSubClass = 'wg-tile-sub is-wave';
    waveMode = 'up';
  } else if (!hasRain && reading.waveVelocityMps != null && reading.waveVelocityMps <= -0.6) {
    displayClimbMps = reading.waveVelocityMps;
    climbCaption = '▼ Model descent';
    climbSubClass = 'wg-tile-sub is-caution';
    waveMode = 'down';
  } else if (inConvectiveTower) {
    displayClimbMps = 0;
    climbCaption = activeLayer?.kind === 'overdeveloped' ? '☁ In OD layer' : '☁ In Cu tower';
    climbSubClass = 'wg-tile-sub is-cloud';
  } else if (reading.estimatedClimbMps !== null) {
    displayClimbMps = 0;
    climbCaption = inInversion ? 'Inversion lid' : reading.peakClimbMps === null ? 'No thermal' : 'Above lift';
  } else if (!inInversion) {
    climbCaption = 'No thermal data';
  }
  const climbTier = classifyClimbLevel(displayClimbMps);
  const barFrac = displayClimbMps !== null && displayClimbMps > 0 ? clamp(displayClimbMps / 5.0, 0.08, 1) : 0;
  const barH = fmt(barFrac * TILE_VARIO_MAX_PX);
  setAttr(climbFill, 'y', String(fmt(42.5 - barFrac * TILE_VARIO_MAX_PX)));
  setAttr(climbFill, 'height', String(barH));
  setAttr(
    climbFill,
    'class',
    waveMode === 'up'
      ? 'wg-tile-vario-fill is-wave'
      : climbTier === 'strong'
        ? 'wg-tile-vario-fill is-strong'
        : 'wg-tile-vario-fill',
  );
  if (displayClimbMps === null) {
    setText(climbVal, '—');
    setAttr(climbVal, 'class', 'wg-tile-val is-muted');
    setText(climbSub, climbCaption);
    setAttr(climbSub, 'class', climbSubClass);
  } else {
    setText(climbVal, formatCompactClimb(displayClimbMps, unitSystem));
    const valClass = waveMode === 'up'
      ? 'wg-tile-val is-wave'
      : waveMode === 'down'
        ? 'wg-tile-val is-sink'
        : climbTier === 'none'
          ? 'wg-tile-val is-muted'
          : `wg-tile-val is-${climbTier}`;
    setAttr(climbVal, 'class', valClass);
    setText(climbSub, climbCaption);
    setAttr(climbSub, 'class', climbSubClass);
  }
  return displayClimbMps;
}

export function paintSkyCell(
  el: TileElements,
  reading: WindgramReading,
  conditions: TileConditions,
  useTol: boolean,
  unitSystem: UnitSystem,
) {
  const { cloudBg, oktas, skyCodeEl, cloudText } = el;
  const {
    liquidRhVal,
    cloudRhVal,
    inLiquidSaturatedCloud,
    inSaturatedCloud,
    activeLayer,
    inStratiformDeck,
    inConvectiveTower,
    inAnyCloudAtHeight,
  } = conditions;
  // Quadrant 3: 5-Segment Sky Oktas + Aviation Sky Cover + Inferred Cloud State
  const tempC = reading.temperatureF == null ? null : fahrenheitToCelsius(reading.temperatureF);
  const cloudPct = reading.cloudCoverTotalPercent === null
    ? null
    : Math.round(clamp(reading.cloudCoverTotalPercent, 0, 100));
  const layers = reading.cloudLayers ?? [];
  const maxLayerCover = layers.length ? Math.max(...layers.map(l => l.coverPercent)) : null;
  const suppliedDisagreesWithLayer = cloudPct !== null && maxLayerCover !== null && maxLayerCover - cloudPct >= 25;
  const effectiveCoverPct = cloudPct !== null && maxLayerCover !== null
    ? (suppliedDisagreesWithLayer ? cloudPct : Math.max(cloudPct, maxLayerCover))
    : (cloudPct ?? maxLayerCover ?? (inSaturatedCloud ? 100 : null));
  const localRhKnown = liquidRhVal !== null || cloudRhVal !== null;
  const localCloudKnown = localRhKnown || layers.length > 0;
  const highOnly = Boolean(reading.highCloudOnly) && !inAnyCloudAtHeight && localRhKnown;
  const litCount = inSaturatedCloud && !suppliedDisagreesWithLayer
    ? Math.max(4, cloudOktasSegments(effectiveCoverPct))
    : inAnyCloudAtHeight && !suppliedDisagreesWithLayer
      ? Math.max(2, cloudOktasSegments(activeLayer?.coverPercent ?? effectiveCoverPct))
      : cloudOktasSegments(effectiveCoverPct);

  setAttr(cloudBg, 'class', inAnyCloudAtHeight ? 'wg-tile-cell-tint is-cloud' : 'wg-tile-cell-tint');
  for (let i = 0; i < oktas.length; i++) {
    const lit = i < litCount;
    const oktaCls = !lit
      ? 'wg-tile-okta'
      : inAnyCloudAtHeight
        ? 'wg-tile-okta is-cloud'
        : highOnly
          ? 'wg-tile-okta is-high'
          : 'wg-tile-okta is-lit';
    setAttr(oktas[i], 'class', oktaCls);
  }

  let skyCode = '—';
  let skyCodeClass = 'wg-tile-sky-code';
  if (suppliedDisagreesWithLayer) {
    skyCode = `SKY ${cloudPct}%`;
    if (inAnyCloudAtHeight) skyCodeClass = 'wg-tile-sky-code is-cloud';
    else if (cloudPct < 5) skyCodeClass = 'wg-tile-sky-code is-muted';
  } else if (inSaturatedCloud) {
    skyCode = activeLayer ? `${activeLayer.coverageCode} ${activeLayer.coverPercent}%` : 'OVC';
    skyCodeClass = 'wg-tile-sky-code is-cloud';
  } else if (inStratiformDeck && activeLayer) {
    skyCode = `${activeLayer.coverageCode} ${activeLayer.coverPercent}%`;
    skyCodeClass = 'wg-tile-sky-code is-cloud';
  } else if (inConvectiveTower && activeLayer) {
    skyCode = `${activeLayer.coverageCode} ${activeLayer.kind === 'overdeveloped' ? 'OD' : 'Cu'}`;
    skyCodeClass = 'wg-tile-sky-code is-cloud';
  } else if (highOnly && cloudPct !== null) {
    skyCode = `HI ${cloudPct}%`;
    skyCodeClass = 'wg-tile-sky-code is-muted';
  } else if (layers.length >= 2) {
    skyCode = `${layers.length} LYR`;
  } else if (!localCloudKnown && cloudPct !== null) {
    skyCode = cloudPct < 5 ? 'CLR' : `SKY ${cloudPct}%`;
    if (cloudPct < 5) skyCodeClass = 'wg-tile-sky-code is-muted';
  } else if (effectiveCoverPct !== null) {
    const code = skyCoverageCode(effectiveCoverPct);
    skyCode = code === 'CLR' ? 'CLR' : `${code} ${effectiveCoverPct}%`;
    if (code === 'CLR') skyCodeClass = 'wg-tile-sky-code is-muted';
  }
  setText(skyCodeEl, skyCode);
  setAttr(skyCodeEl, 'class', skyCodeClass);

  const cuLayer = layers.find(l => l.kind !== 'stratiform') ?? (activeLayer?.kind !== 'stratiform' ? activeLayer : null);
  const outsidePrefix = suppliedDisagreesWithLayer ? 'Moist RH' : 'Clear';
  if (inSaturatedCloud) {
    const satDepth = activeLayer?.depthM ?? null;
    const cloudPrefix = !inLiquidSaturatedCloud && tempC !== null && tempC < 0
      ? '☁ Cold cloud'
      : suppliedDisagreesWithLayer
        ? '☁ Moist RH'
        : '☁ In cloud';
    const label = satDepth !== null && satDepth >= 40
      ? `${cloudPrefix} · ${formatCompactSpan(satDepth, unitSystem)}`
      : cloudRhVal !== null
        ? `${cloudPrefix} · RH ${cloudRhVal}%`
        : cloudPrefix;
    setText(cloudText, label);
    setAttr(cloudText, 'class', 'wg-tile-sub is-cloud');
  } else if (inStratiformDeck && activeLayer) {
    const deckPrefix = suppliedDisagreesWithLayer ? '☁ Moist layer' : `☁ ${activeLayer.coverageCode} deck`;
    setText(cloudText, `${deckPrefix} · ${formatCompactSpan(activeLayer.depthM, unitSystem)}`);
    setAttr(cloudText, 'class', 'wg-tile-sub is-cloud');
  } else if (inConvectiveTower && activeLayer) {
    const tag = activeLayer.kind === 'overdeveloped' ? 'OD' : 'Cu';
    setText(cloudText, `☁ In ${tag} · ${formatCompactSpan(activeLayer.depthM, unitSystem)} deep`);
    setAttr(cloudText, 'class', 'wg-tile-sub is-cloud');
  } else if (useTol && reading.cloudCapped) {
    const label = cuLayer && cuLayer.depthM >= 50
      ? `Cu base · ${formatCompactSpan(cuLayer.depthM, unitSystem)} deep`
      : liquidRhVal !== null
        ? `At Cu base · RH ${liquidRhVal}%`
        : 'At Cu base';
    setText(cloudText, label);
    setAttr(cloudText, 'class', 'wg-tile-sub is-cloud');
  } else if (reading.nearestCloudBaseAboveM != null && reading.nearestCloudBaseAboveM - reading.heightM <= 4000) {
    const clearanceM = reading.nearestCloudBaseAboveM - reading.heightM;
    setText(cloudText, `${outsidePrefix} · Base +${formatCompactSpan(clearanceM, unitSystem)}`);
    setAttr(cloudText, 'class', 'wg-tile-sub');
  } else if (highOnly) {
    setText(cloudText, 'Clear · High cirrus');
    setAttr(cloudText, 'class', 'wg-tile-sub');
  } else if (reading.nearestCloudTopBelowM != null && reading.heightM - reading.nearestCloudTopBelowM <= 2500) {
    const aboveM = reading.heightM - reading.nearestCloudTopBelowM;
    setText(cloudText, `${outsidePrefix} · Top -${formatCompactSpan(aboveM, unitSystem)}`);
    setAttr(cloudText, 'class', 'wg-tile-sub');
  } else if (liquidRhVal !== null) {
    setText(cloudText, `${outsidePrefix} · RH ${liquidRhVal}%`);
    setAttr(cloudText, 'class', 'wg-tile-sub');
  } else if (cloudRhVal !== null) {
    setText(cloudText, `Model RH ${cloudRhVal}%`);
    setAttr(cloudText, 'class', 'wg-tile-sub');
  } else if (cloudPct !== null) {
    setText(cloudText, cloudPct < 5 ? `Sky ${cloudPct}%` : `Local RH — · Sky ${cloudPct}%`);
    setAttr(cloudText, 'class', 'wg-tile-sub');
  } else {
    setText(cloudText, 'Sky —');
    setAttr(cloudText, 'class', 'wg-tile-sub');
  }
  return { tempC, layers, cuLayer };
}
