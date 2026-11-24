// Physical readings at an hour and height, with published diagnostic context.

import { windFromComponents } from '@av/soaring';
import {
  effectiveHourUsableLiftTopM,
  estimateThermalClimbAtHeight,
  isHourNativeLiftFallback,
  omegaToVerticalVelocityMps,
} from './windgram-atmosphere.ts';
import {
  celsiusToFahrenheit,
  clamp,
  mpsToKnots,
  finiteScalar,
} from './windgram-format.ts';
import { sampleHeight } from './windgram-sampling.ts';
import type { WindgramCloud, WindgramView } from './windgram-view.ts';

import type { WindgramReading } from './scene-types.ts';;

function windShearAtHeight(sample: WindgramView['sampling'][number] | undefined, heightM: number): WindgramReading['windShear'] {
  if (!sample || sample.windU.length < 2 || heightM < sample.windU[0].altitudeM || heightM > sample.windU.at(-1)!.altitudeM) return null;
  const upper = sample.windU.findIndex(node => node.altitudeM > heightM);
  const index = upper < 0 ? sample.windU.length - 2 : upper - 1;
  const a = sample.windU[index], b = sample.windU[index + 1], av = sample.windV[index], bv = sample.windV[index + 1];
  if (!a || !b || !av || !bv || b.altitudeM <= a.altitudeM || ![a.value, b.value, av.value, bv.value].every(Number.isFinite)) return null;
  const vectorChangeMps = Math.hypot(b.value - a.value, bv.value - av.value);
  return { lowerM: a.altitudeM, upperM: b.altitudeM, vectorChangeMps, perKmMps: vectorChangeMps * 1000 / (b.altitudeM - a.altitudeM) };
}

function samplePressureHpaAtHeight(levels: WindgramView['sourceHours'][number]['levels'] | undefined, zM: number): number | null {
  if (!levels?.length) return null;
  let loZ = -Infinity, loP = 0, hiZ = Infinity, hiP = 0;
  for (const l of levels) {
    const z = l.heightM, p = l.pressureHpa;
    if (z === null || !Number.isFinite(z) || p === null || !Number.isFinite(p) || p <= 0) continue;
    if (Math.abs(z - zM) < 0.00001) return p;
    if (z <= zM && z > loZ) { loZ = z; loP = p; }
    if (z >= zM && z < hiZ) { hiZ = z; hiP = p; }
  }
  if (!Number.isFinite(loZ) || !Number.isFinite(hiZ)) return null;
  return loZ === hiZ ? loP : loP * Math.pow(hiP / loP, (zM - loZ) / (hiZ - loZ));
}

function clampCloudPercent(value: number | null | undefined): number | null {
  const raw = finiteScalar(value);
  return raw === null ? null : clamp(raw, 0, 100);
}

function surfaceWindVector(surface: WindgramView['sourceHours'][number]['surface']): { u: number; v: number } | null {
  const u = finiteScalar(surface.windU), v = finiteScalar(surface.windV);
  if (u !== null && v !== null) return { u, v };
  const speed = finiteScalar(surface.windSpeedMps), dir = finiteScalar(surface.windDirectionDeg);
  if (speed === null || dir === null) return null;
  const rad = (dir * Math.PI) / 180;
  return { u: -speed * Math.sin(rad), v: -speed * Math.cos(rad) };
}

function detectSurfaceWindShift(
  sourceHours: WindgramView['sourceHours'],
  index: number,
  gustKt: number | null,
): WindgramReading['surfaceWindShift'] {
  if (index <= 0) return null;
  const cur = sourceHours[index], prev = sourceHours[index - 1];
  if (!cur || !prev) return null;
  const dtHours = (Date.parse(cur.validAt) - Date.parse(prev.validAt)) / 3_600_000;
  if (!(dtHours > 0 && dtHours <= 1.5)) return null;
  const w1 = surfaceWindVector(cur.surface), w0 = surfaceWindVector(prev.surface);
  if (!w1 || !w0) return null;
  const s1 = Math.hypot(w1.u, w1.v), s0 = Math.hypot(w0.u, w0.v);
  if (s1 < 3.0 || s0 < 3.0) return null;
  const deltaKt = mpsToKnots(Math.hypot(w1.u - w0.u, w1.v - w0.v));
  if (deltaKt < 10) return null;
  const cosAngle = clamp((w1.u * w0.u + w1.v * w0.v) / (s1 * s0), -1, 1);
  const shiftDeg = (Math.acos(cosAngle) * 180) / Math.PI;
  const peakKt = Math.max(mpsToKnots(s1), gustKt ?? 0);
  if (shiftDeg < 45 || peakKt < 18) return null;
  return { deltaKt: Math.round(deltaKt), shiftDeg: Math.round(shiftDeg) };
}

function hasWarmLayerAboveSubfreezing(
  sample: WindgramView['sampling'][number] | undefined,
  precipMmHr: number | null,
): boolean {
  const nodes = sample?.temperatureC;
  if (!nodes?.length) return false;
  const activePrecip = precipMmHr !== null && Number.isFinite(precipMmHr) && precipMmHr > 0.04;
  const rhNodes = sample?.cloudHumidityPercent ?? sample?.relativeHumidityPercent;
  let lowestSubfreezingM: number | null = null;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    if (!Number.isFinite(node.value)) continue;
    if (node.value <= -0.5 && (lowestSubfreezingM === null || node.altitudeM < lowestSubfreezingM)) {
      lowestSubfreezingM = node.altitudeM;
    }
    if (lowestSubfreezingM !== null && node.altitudeM > lowestSubfreezingM && node.altitudeM <= lowestSubfreezingM + 3500 && node.value > 0.5) {
      const rhVal = rhNodes?.[i]?.value ?? sampleHeight(rhNodes ?? [], node.altitudeM);
      if (activePrecip || (rhVal !== null && Number.isFinite(rhVal) && rhVal >= 80) || (rhVal === null && precipMmHr === null)) {
        return true;
      }
    }
  }
  return false;
}

const NON_OMEGA_MODELS = new Set(['gfs', 'icon-eu']);

interface HourInspectorCache {
  readonly cloudsByHour: readonly (readonly WindgramCloud[])[];
  readonly warmLayerByHour: (boolean | undefined)[];
  readonly windShiftByHour: (WindgramReading['surfaceWindShift'] | undefined)[];
  readonly modelOmitsOmega: boolean;
}

const inspectorCacheByView = new WeakMap<WindgramView, HourInspectorCache>();

function getHourInspectorMeta(view: WindgramView, index: number, gustKt: number | null) {
  let cache = inspectorCacheByView.get(view);
  if (!cache) {
    const grouped: WindgramCloud[][] = Array.from({ length: view.hours.length }, () => []);
    for (const c of view.clouds) {
      if (c.hourIndex >= 0 && c.hourIndex < grouped.length) grouped[c.hourIndex]!.push(c);
    }
    const hasViewOmega = view.modelHasAnyOmega ?? view.sourceHours.some(
      h => h.levels.some(l => l.omegaPaS !== null && Number.isFinite(l.omegaPaS)),
    );
    const modelOmitsOmega =
      !hasViewOmega &&
      (view.model !== undefined
        ? NON_OMEGA_MODELS.has(view.model)
        : view.sourceHours.some(h => h.levels.length > 0));
    cache = {
      cloudsByHour: grouped,
      warmLayerByHour: new Array<boolean | undefined>(view.hours.length),
      windShiftByHour: new Array<WindgramReading['surfaceWindShift'] | undefined>(view.hours.length),
      modelOmitsOmega,
    };
    inspectorCacheByView.set(view, cache);
  }
  let warmLayerAloft = cache.warmLayerByHour[index];
  if (warmLayerAloft === undefined) {
    const precip = finiteScalar(view.sourceHours[index]?.surface.precipitationMmHr);
    warmLayerAloft = hasWarmLayerAboveSubfreezing(view.sampling[index], precip);
    cache.warmLayerByHour[index] = warmLayerAloft;
  }
  let surfaceWindShift = cache.windShiftByHour[index];
  if (surfaceWindShift === undefined) {
    surfaceWindShift = detectSurfaceWindShift(view.sourceHours, index, gustKt);
    cache.windShiftByHour[index] = surfaceWindShift;
  }
  return {
    clouds: cache.cloudsByHour[index] ?? [],
    warmLayerAloft,
    surfaceWindShift,
    modelOmitsOmega: cache.modelOmitsOmega,
  };
}

export function readWindgram(view: WindgramView, hourIndex: number, heightM: number): WindgramReading {
  const index = clamp(Math.round(hourIndex), 0, view.hours.length - 1);
  const sample = view.sampling[index];
  const z = clamp(heightM, view.floorM, view.topM);
  const gustKt = view.hours[index]?.gustKt ?? null;
  const hourMeta = getHourInspectorMeta(view, index, gustKt);
  const t = sample ? sampleHeight(sample.temperatureC, z) : null;
  const dewPointC = sample ? sampleHeight(sample.dewPointC, z) : null;
  const u = sample ? sampleHeight(sample.windU, z) : null, v = sample ? sampleHeight(sample.windV, z) : null;
  const wind = windFromComponents(u, v);
  const cloud = hourMeta.clouds.find(
    (c) => c.kind === 'potential' ? Math.abs(z - c.baseM) < 25 : z >= c.baseM && z <= c.topM,
  );
  const source = view.sourceHours[index];
  const omega = sample ? sampleHeight(sample.verticalVelocityPaS, z) : null;
  const pressureHpa = samplePressureHpaAtHeight(source?.levels, z);
  const waveVelocityMps = omegaToVerticalVelocityMps(omega, t, pressureHpa, z);
  const nativeWind = wind.speedMps !== null && sample?.windU.some(n => Math.abs(n.altitudeM - z) < .00001 && Number.isFinite(n.value));
  const surface = source?.surface;
  const pblDepthM = surface?.pblHeightM ?? null;
  const modelTerrainM = source?.modelTerrainM ?? null;
  const fineTerrainM = source?.fineTerrainM ?? null;
  const terrainDeltaM = fineTerrainM !== null && modelTerrainM !== null ? fineTerrainM - modelTerrainM : null;
  const groundM = fineTerrainM ?? modelTerrainM;
  const usableTopM = source
    ? effectiveHourUsableLiftTopM(source, view.hours[index]?.usableLiftTopM)
    : (view.hours[index]?.usableLiftTopM ?? null);
  const isNativeFallback = source
    ? isHourNativeLiftFallback(source, view.hours[index]?.usableLiftTopM)
    : false;
  const climb = estimateThermalClimbAtHeight(
    z,
    groundM,
    usableTopM,
    source?.thermalTopM ?? null,
    source?.effectiveCloudLimitM ?? null,
    finiteScalar(source?.thermalVelocityMps),
    { modelTerrainM, isNativeFallback },
  );

  const precipMmHr = finiteScalar(surface?.precipitationMmHr);

  const cloudLayers = view.cloudLayersByHour?.[index] ?? [];
  const highCloudOnly = view.highCloudOnlyByHour?.[index] ?? false;
  const activeCloudLayer =
    cloudLayers.find(l => l.kind === 'stratiform' && l.saturated && z >= l.baseM - 5 && z <= l.topM + 5) ??
    cloudLayers.find(l => l.kind === 'stratiform' && z >= l.baseM - 5 && z <= l.topM + 5) ??
    cloudLayers.find(l => l.kind !== 'stratiform' && z >= l.baseM - 15 && z <= l.topM + 10) ??
    null;
  let nearestCloudBaseAboveM: number | null = null;
  let nearestCloudTopBelowM: number | null = null;
  for (const l of cloudLayers) {
    if (l.baseM > z + 15 && (nearestCloudBaseAboveM === null || l.baseM < nearestCloudBaseAboveM)) nearestCloudBaseAboveM = l.baseM;
    if (l.topM < z - 15 && (nearestCloudTopBelowM === null || l.topM > nearestCloudTopBelowM)) nearestCloudTopBelowM = l.topM;
  }

  const liquidRhPercent = sample ? sampleHeight(sample.relativeHumidityPercent, z) : null;
  const cloudHumidityPercent = sample
    ? sampleHeight(sample.cloudHumidityPercent ?? sample.relativeHumidityPercent, z)
    : null;

  return {
    hourIndex: index,
    validAt: view.hours[index]?.validAt ?? '',
    heightM: z,
    heightAglM: groundM === null || z < groundM ? null : z - groundM,
    heightAglReference: fineTerrainM !== null ? 'terrain' : modelTerrainM !== null ? 'model' : null,
    temperatureF: t === null ? null : celsiusToFahrenheit(t),
    speedKt: wind.speedMps === null ? null : mpsToKnots(wind.speedMps),
    directionDeg: wind.directionDeg,
    gustKt,
    cloud: cloud?.kind ?? null,
    dewPointC,
    relativeHumidityPercent: liquidRhPercent,
    cloudHumidityPercent,
    verticalVelocityPaS: omega,
    windSource: wind.speedMps === null ? null : !nativeWind ? 'interpolated'
      : modelTerrainM !== null && Math.abs(z - modelTerrainM - 10) < .00001 ? 'surface-10m' : 'model-level',
    windShear: windShearAtHeight(sample, z),
    verticalVelocitySource: omega === null ? null : sample?.verticalVelocityPaS.some(n => Math.abs(n.altitudeM - z) < .00001) ? 'model-level' : 'interpolated',
    verticalVelocityUnavailableReason: omega === null
      ? (hourMeta.modelOmitsOmega
          ? 'Vertical motion unavailable (not published for this model).'
          : source?.levels.some(l => l.omegaPaS !== null && Number.isFinite(l.omegaPaS))
            ? 'Vertical motion unavailable at this height.'
            : 'Vertical motion unavailable for the selected frame and height.')
      : null,
    surfaceWindSpeedMps: finiteScalar(surface?.windSpeedMps),
    surfaceWindDirectionDeg: finiteScalar(surface?.windDirectionDeg),
    precipitationMmHr: precipMmHr,
    capeJkg: finiteScalar(surface?.capeJkg),
    cloudCoverTotalPercent: clampCloudPercent(surface?.cloudCoverTotalPercent),
    cloudCoverLowPercent: clampCloudPercent(surface?.cloudCoverLowPercent),
    estimatedClimbMps: climb.estimatedClimbMps,
    peakClimbMps: climb.peakClimbMps,
    lapseCPer1000Ft: sample ? sampleHeight(sample.lapseCPer1000Ft, z) : null,
    waveVelocityMps,
    warmLayerAloft: hourMeta.warmLayerAloft,
    surfaceWindShift: hourMeta.surfaceWindShift,
    buoyancyShearRatio: finiteScalar(source?.buoyancyShearRatio),
    cloudLayers,
    activeCloudLayer,
    nearestCloudBaseAboveM,
    nearestCloudTopBelowM,
    highCloudOnly,
    cloudBaseM: source?.surfaceLclM ?? null,
    effectiveCloudLimitM: source?.effectiveCloudLimitM ?? null,
    overdeveloped: source?.overdeveloped ?? null,
    cloudCapped: source?.cloudCapped ?? null,
    modelTerrainM,
    fineTerrainM,
    terrainDeltaM,
    nativeThermalTopM: source?.thermalTopM ?? null,
    modelPblTopM: pblDepthM === null || modelTerrainM === null ? null : modelTerrainM + pblDepthM,
    publishedLayerWind: source?.layerWind ?? null,
  };
}
