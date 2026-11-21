// Physical readings at an hour and height, with published diagnostic context.

import { windFromComponents } from '@av/soaring';
import {
  effectiveHourUsableLiftTopM,
  estimateThermalClimbAtHeight,
  omegaToVerticalVelocityMps,
} from './windgram-atmosphere.ts';
import {
  celsiusToFahrenheit,
  clamp,
  mpsToKnots,
  finiteScalar,
} from './windgram-format.ts';
import { sampleField, sampleHeight } from './windgram-sampling.ts';
import type { WindgramView } from './windgram-view.ts';

import type { WindgramReading } from './scene-types.ts';
export type { WindgramReading } from './scene-types.ts';

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
  const nodes = levels
    .filter((l): l is typeof l & { heightM: number; pressureHpa: number } =>
      l.heightM !== null && Number.isFinite(l.heightM) && l.pressureHpa !== null && Number.isFinite(l.pressureHpa) && l.pressureHpa > 0,
    )
    .sort((a, b) => a.heightM - b.heightM)
    .map(l => ({ altitudeM: l.heightM, value: Math.log(l.pressureHpa) }));
  if (!nodes.length) return null;
  const lnP = sampleField(nodes, zM, 'altitudeM');
  return lnP === null ? null : Math.exp(lnP);
}

function clampCloudPercent(value: number | null | undefined): number | null {
  const raw = finiteScalar(value);
  return raw === null ? null : clamp(raw, 0, 100);
}

export function readWindgram(view: WindgramView, hourIndex: number, heightM: number): WindgramReading {
  const index = clamp(Math.round(hourIndex), 0, view.hours.length - 1);
  const sample = view.sampling[index];
  const z = clamp(heightM, view.floorM, view.topM);
  const t = sample ? sampleHeight(sample.temperatureC, z) : null;
  const dewPointC = sample ? sampleHeight(sample.dewPointC, z) : null;
  const u = sample ? sampleHeight(sample.windU, z) : null, v = sample ? sampleHeight(sample.windV, z) : null;
  const wind = windFromComponents(u, v);
  const cloud = view.clouds.find(
    (c) => c.hourIndex === index && (c.kind === 'potential' ? Math.abs(z - c.baseM) < 25 : z >= c.baseM && z <= c.topM),
  );
  const source = view.sourceHours[index];
  const omega = sample ? sampleHeight(sample.verticalVelocityPaS, z) : null;
  const pressureHpa = samplePressureHpaAtHeight(source?.levels, z);
  const waveVelocityMps = omegaToVerticalVelocityMps(omega, t, pressureHpa, z);
  const nativeWind = wind.speedMps !== null && sample?.windU.some(n => Math.abs(n.altitudeM - z) < .00001 && Number.isFinite(n.value));
  const surface = source?.surface;
  const pblDepthM = surface?.pblHeightM ?? null;
  const modelTerrainM = source?.modelTerrainM ?? null;
  const fineTerrainM = source?.mapLift.terrainM ?? null;
  const groundM = fineTerrainM ?? modelTerrainM;
  const usableTopM = source
    ? effectiveHourUsableLiftTopM(source, view.hours[index]?.usableLiftTopM)
    : (view.hours[index]?.usableLiftTopM ?? null);
  const climb = estimateThermalClimbAtHeight(
    z,
    groundM,
    usableTopM,
    source?.thermalTopM ?? null,
    source?.effectiveCloudLimitM ?? null,
    finiteScalar(source?.thermalVelocityMps),
  );

  const cloudLayers = view.cloudLayersByHour?.[index] ?? [];
  const highCloudOnly = view.highCloudOnlyByHour?.[index] ?? false;
  const activeCloudLayer =
    cloudLayers.find(l => l.kind === 'stratiform' && l.saturated && z >= l.baseM - 5 && z <= l.topM + 5) ??
    cloudLayers.find(l => l.kind === 'stratiform' && z >= l.baseM - 5 && z <= l.topM + 5) ??
    cloudLayers.find(l => l.kind !== 'stratiform' && z >= l.baseM - 15 && z <= l.topM + 10) ??
    null;
  const basesAbove = cloudLayers.filter(l => l.baseM > z + 15).map(l => l.baseM);
  const topsBelow = cloudLayers.filter(l => l.topM < z - 15).map(l => l.topM);
  const nearestCloudBaseAboveM = basesAbove.length ? Math.min(...basesAbove) : null;
  const nearestCloudTopBelowM = topsBelow.length ? Math.max(...topsBelow) : null;

  return {
    hourIndex: index,
    validAt: view.hours[index]?.validAt ?? '',
    heightM: z,
    heightAglM: groundM === null || z < groundM ? null : z - groundM,
    heightAglReference: fineTerrainM !== null ? 'terrain' : modelTerrainM !== null ? 'model' : null,
    temperatureF: t === null ? null : celsiusToFahrenheit(t),
    speedKt: wind.speedMps === null ? null : mpsToKnots(wind.speedMps),
    directionDeg: wind.directionDeg,
    gustKt: view.hours[index]?.gustKt ?? null,
    cloud: cloud?.kind ?? null,
    dewPointC,
    relativeHumidityPercent: sample ? sampleHeight(sample.relativeHumidityPercent, z) : null,
    verticalVelocityPaS: omega,
    windSource: wind.speedMps === null ? null : !nativeWind ? 'interpolated'
      : modelTerrainM !== null && Math.abs(z - modelTerrainM - 10) < .00001 ? 'surface-10m' : 'model-level',
    windShear: windShearAtHeight(sample, z),
    verticalVelocitySource: omega === null ? null : sample?.verticalVelocityPaS.some(n => Math.abs(n.altitudeM - z) < .00001) ? 'model-level' : 'interpolated',
    verticalVelocityUnavailableReason: omega === null ? 'Vertical motion unavailable at this height.' : null,
    surfaceWindSpeedMps: finiteScalar(surface?.windSpeedMps),
    surfaceWindDirectionDeg: finiteScalar(surface?.windDirectionDeg),
    precipitationMmHr: finiteScalar(surface?.precipitationMmHr),
    capeJkg: finiteScalar(surface?.capeJkg),
    cloudCoverTotalPercent: clampCloudPercent(surface?.cloudCoverTotalPercent),
    cloudCoverLowPercent: clampCloudPercent(surface?.cloudCoverLowPercent),
    estimatedClimbMps: climb.estimatedClimbMps,
    peakClimbMps: climb.peakClimbMps,
    lapseCPer1000Ft: sample ? sampleHeight(sample.lapseCPer1000Ft, z) : null,
    waveVelocityMps,
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
    nativeThermalTopM: source?.thermalTopM ?? null,
    modelPblTopM: pblDepthM === null || modelTerrainM === null ? null : modelTerrainM + pblDepthM,
    publishedLayerWind: source?.layerWind ?? null,
  };
}
