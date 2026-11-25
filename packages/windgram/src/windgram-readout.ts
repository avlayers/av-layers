// Format inspector readings; DOM interaction lives in windgram-interaction.ts.
import { formatMapLiftCell, formatPlaceTime, formatPointMapLift } from '@av/client';
import { MPH_PER_MPS } from '@av/contracts/units';
import { shortTimeZoneNameAt, timeZoneOffsetMinutesAt } from '@av/client/timezone';
import { FEET_PER_MINUTE_TO_MPS } from '@av/soaring';
import { clamp, compass16, compassDegrees, fahrenheitToCelsius, formatQuantity, knotsToMps, METRES_PER_THOUSAND_FEET, type UnitSystem } from './windgram-format.ts';
import { visibleTolM } from './windgram-hit-test.ts';
import { readWindgram } from './windgram-inspector.ts';
import { CLOUD_RH_THRESHOLD_PERCENT } from './windgram-sampling.ts';
import type { WindgramView } from './windgram-view.ts';
import type { WindgramReading } from './scene-types.ts';

type MapLiftSummary = WindgramView['sourceHours'][number]['mapLift'];

const SHORT_WEEKDAYS_UTC = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const barbSpeed = (knots: number, system: UnitSystem) => formatQuantity(knotsToMps(knots), 'wind', undefined, system);
const windSources = {
  'surface-10m': 'Native 10 m wind',
  'model-level': 'Model level',
  interpolated: 'Interpolated',
};
const cloudLabels = {
  humidity: `Inferred cloud layer from profile humidity ≥${CLOUD_RH_THRESHOLD_PERCENT}%`,
  potential: 'Potential cloud base',
};

function formatClimbRate(mps: number, system: UnitSystem): string {
  if (system === 'imperial') {
    const fpm = Math.round((mps / FEET_PER_MINUTE_TO_MPS) / 5) * 5;
    return fpm > 0 ? `+${formatQuantity(fpm / (1 / FEET_PER_MINUTE_TO_MPS), 'lift', 0, 'imperial').replace(' ft/min', '')} fpm` : '0 fpm';
  }
  const rounded = Math.round(mps * 10) / 10;
  return rounded > 0 ? `+${rounded.toFixed(1)} m/s` : '0.0 m/s';
}

function hasAdjacentOffsetTransition(view: WindgramView, hourIndex: number, offsetMinutes: number): boolean {
  for (const neighborIdx of [hourIndex - 1, hourIndex + 1]) {
    const neighbor = view.hours[neighborIdx];
    if (!neighbor) continue;
    const neighborMs = Date.parse(neighbor.validAt);
    if (Number.isFinite(neighborMs) && timeZoneOffsetMinutesAt(neighborMs, view.timeZone) !== offsetMinutes) {
      return true;
    }
  }
  return false;
}

interface HourClockMeta {
  readonly validAt: string;
  readonly timeChip: string;
  readonly compactTime: string;
  readonly accessibleStamp: string;
}

const clockCacheByView = new WeakMap<WindgramView, (HourClockMeta | undefined)[]>();

function resolveHourClockMeta(view: WindgramView, hourIndex: number, validAt: string): HourClockMeta {
  let slots = clockCacheByView.get(view);
  if (!slots) {
    slots = new Array<HourClockMeta | undefined>(view.hours.length);
    clockCacheByView.set(view, slots);
  }
  const existing = slots[hourIndex];
  if (existing && existing.validAt === validAt) return existing;

  const validMs = Date.parse(validAt);
  const frameOffsetMinutes = Number.isFinite(validMs)
    ? timeZoneOffsetMinutesAt(validMs, view.timeZone)
    : view.offsetMinutes;
  const isUtcFallback = Boolean(view.isUtcFallback) || view.timeZone === 'UTC' || view.timeZone === 'Etc/UTC';
  const isTransitionHour = Number.isFinite(validMs) && hasAdjacentOffsetTransition(view, hourIndex, frameOffsetMinutes);
  const zoneTag = isUtcFallback
    ? 'UTC'
    : isTransitionHour
      ? shortTimeZoneNameAt(validMs, view.timeZone)
      : '';

  const clockRaw = formatPlaceTime(validMs, frameOffsetMinutes, 'clock');
  const split = clockRaw.indexOf(' (');
  const baseClock = split < 0 ? clockRaw : clockRaw.slice(0, split);
  const timeChip = zoneTag && baseClock !== '—' ? `${baseClock} ${zoneTag}` : baseClock;

  const stampRaw = formatPlaceTime(validMs, frameOffsetMinutes, 'stamp');
  const stampSplit = stampRaw.indexOf(' (');
  const accessibleStamp = zoneTag && stampSplit > 0
    ? `${stampRaw.slice(0, stampSplit)} ${zoneTag}${stampRaw.slice(stampSplit)}`
    : stampRaw;

  let compactTime = '';
  if (Number.isFinite(validMs)) {
    const shifted = new Date(validMs + frameOffsetMinutes * 60_000);
    const h24 = shifted.getUTCHours();
    const mins = shifted.getUTCMinutes();
    const suffix = h24 >= 12 ? 'p' : 'a';
    const h12 = h24 % 12 || 12;
    const hm = mins === 0 ? `${h12}${suffix}` : `${h12}:${String(mins).padStart(2, '0')}${suffix}`;
    const tagged = zoneTag ? `${hm} ${zoneTag}` : hm;
    compactTime = view.dayPanels?.length ? `${SHORT_WEEKDAYS_UTC[shifted.getUTCDay()]!} ${tagged}` : tagged;
  }

  const meta: HourClockMeta = { validAt, timeChip, compactTime, accessibleStamp };
  if (hourIndex >= 0 && hourIndex < slots.length) slots[hourIndex] = meta;
  return meta;
}

export function formatWindgramHourStamp(view: WindgramView, hourIndex: number, validAt: string): string {
  return resolveHourClockMeta(view, hourIndex, validAt).accessibleStamp;
}

function isMapLiftDonorReference(
  lift: MapLiftSummary,
  reading: WindgramReading,
): boolean {
  if (lift.agl?.status !== 'valid' || lift.agl.value === null) return false;
  return reading.fineTerrainM != null && lift.mslM !== null && Math.abs((lift.mslM - lift.agl.value) - reading.fineTerrainM) >= 1;
}

export function formatSnappedMapLiftAgl(
  lift: MapLiftSummary,
  reading: WindgramReading,
  system: UnitSystem,
  options?: { finePointInterpolated?: boolean; includeSiteClearance?: boolean },
): string {
  const base = formatMapLiftCell(lift.agl, system);
  if (!isMapLiftDonorReference(lift, reading)) {
    return `${base} AGL`;
  }
  if (options?.includeSiteClearance && reading.heightAglM !== null) {
    const refLabel = reading.heightAglReference === 'model' ? 'model AGL' : 'site AGL';
    return `${base} donor AGL (${formatQuantity(reading.heightAglM, 'elevation', undefined, system)} ${refLabel})`;
  }
  return `${base} donor AGL`;
}

export interface WindgramTelemetryStrip {
  readonly timeChip: string;
  readonly compactTime?: string;
  readonly altChip: string;
  readonly snappedToTol: boolean;
  readonly canSnapToTol: boolean;
  readonly calloutBadge: string;
  readonly calloutMeteo: string;
  readonly calloutSoar: string;
  readonly hasPositiveClimb: boolean;
}

function isTolCappedBelowThermalTop(
  reading: Pick<WindgramReading, 'cloudCapped' | 'nativeThermalTopM' | 'heightM'>,
): boolean {
  return Boolean(reading.cloudCapped) || (reading.nativeThermalTopM !== null && reading.heightM < reading.nativeThermalTopM - 25);
}

interface SnappedTolClimbChoice {
  readonly climbMps: number;
  readonly stripPrefix: 'Climb' | 'Peak';
  readonly tileCaption: '▲ Cu base' | '▲ At ceiling' | '▲ Peak lift';
}

export function resolveSnappedTolClimb(
  reading: Pick<WindgramReading, 'cloudCapped' | 'nativeThermalTopM' | 'heightM' | 'estimatedClimbMps' | 'peakClimbMps'>,
): SnappedTolClimbChoice | null {
  if (isTolCappedBelowThermalTop(reading) && reading.estimatedClimbMps !== null && reading.estimatedClimbMps >= 0.08) {
    return {
      climbMps: reading.estimatedClimbMps,
      stripPrefix: 'Climb',
      tileCaption: reading.cloudCapped ? '▲ Cu base' : '▲ At ceiling',
    };
  }
  if (reading.peakClimbMps !== null && reading.peakClimbMps > 0) {
    return {
      climbMps: reading.peakClimbMps,
      stripPrefix: 'Peak',
      tileCaption: '▲ Peak lift',
    };
  }
  return null;
}

export function buildWindgramTelemetry(
  view: WindgramView,
  reading: WindgramReading,
  lift: MapLiftSummary,
  snappedToTol: boolean,
  hasTolAtHour: boolean,
): WindgramTelemetryStrip {
  const system = view.unitSystem;
  const { timeChip, compactTime } = resolveHourClockMeta(view, reading.hourIndex, reading.validAt);

  const finePointInterpolated = view.sourceHours[reading.hourIndex]?.finePointInterpolated;
  const aglSuffix = reading.heightAglReference === 'model' ? 'model AGL' : 'AGL';
  const aglDisplay = snappedToTol && hasTolAtHour
    ? formatSnappedMapLiftAgl(lift, reading, system, { finePointInterpolated, includeSiteClearance: true })
    : reading.heightAglM !== null
      ? `${formatQuantity(reading.heightAglM, 'elevation', undefined, system)} ${aglSuffix}`
      : `${formatQuantity(reading.heightM, 'elevation', undefined, system)} MSL`;
  const altChip = snappedToTol
    ? (hasTolAtHour ? `★ TOL ${aglDisplay}` : '')
    : hasTolAtHour
      ? `${aglDisplay} ↺ TOL`
      : aglDisplay;

  const windPart = reading.speedKt == null
    ? null
    : reading.speedKt < 0.1
      ? 'Calm'
      : `${barbSpeed(reading.speedKt, system)}${reading.directionDeg == null ? '' : ` ${compass16(reading.directionDeg)}`}`;
  const tempPart = reading.temperatureF == null
    ? null
    : formatQuantity(fahrenheitToCelsius(reading.temperatureF), 'temperature', 1, system);
  const calloutMeteo = [windPart, tempPart].filter((v): v is string => v !== null).join(' · ');

  let climbPart: string | null = null;
  let hasPositiveClimb = false;
  if (snappedToTol) {
    const snappedClimb = resolveSnappedTolClimb(reading);
    if (snappedClimb) {
      climbPart = `${snappedClimb.stripPrefix} ${formatClimbRate(snappedClimb.climbMps, system)}`;
      hasPositiveClimb = true;
    }
  } else if (reading.estimatedClimbMps !== null) {
    hasPositiveClimb = reading.estimatedClimbMps >= 0.05;
    climbPart = `Climb ${formatClimbRate(hasPositiveClimb ? reading.estimatedClimbMps : 0, system)}`;
  } else if (reading.waveVelocityMps != null && reading.waveVelocityMps >= 0.35) {
    hasPositiveClimb = true;
    climbPart = `Ascent ${formatClimbRate(reading.waveVelocityMps, system)}`;
  }

  const totalCloud = reading.cloudCoverTotalPercent === null
    ? null
    : Math.round(clamp(reading.cloudCoverTotalPercent, 0, 100));
  const cloudRh = reading.cloudHumidityPercent ?? reading.relativeHumidityPercent;
  const cloudPart = reading.cloud === 'humidity'
    ? (totalCloud !== null ? `Cloud ${totalCloud}% (in layer)` : `In cloud (RH ${Math.round(cloudRh ?? CLOUD_RH_THRESHOLD_PERCENT)}%)`)
    : totalCloud !== null
      ? `Cloud ${totalCloud}%`
      : reading.relativeHumidityPercent !== null
        ? `RH ${Math.round(reading.relativeHumidityPercent)}%`
        : null;
  const calloutSoar = [climbPart, cloudPart].filter((v): v is string => v !== null).join(' · ');
  const calloutBadge = snappedToTol ? '★ TOP OF LIFT' : 'ALTITUDE';

  return {
    timeChip,
    compactTime,
    altChip,
    snappedToTol,
    canSnapToTol: !snappedToTol && hasTolAtHour,
    calloutBadge,
    calloutMeteo,
    calloutSoar,
    hasPositiveClimb,
  };
}

function surfaceDetails(view: WindgramView, reading: WindgramReading): string[] {
  const system = view.unitSystem;
  const rainLabel = view.precipitationSemantics === 'instantRate' ? 'Precipitation rate sample'
    : view.precipitationSemantics === 'windowMeanRate' ? 'Mean precipitation rate (preceding interval)' : 'Precipitation rate (timing unspecified)';
  const layer = reading.publishedLayerWind;
  const wind = (speed: number | null, direction: number | null) => speed === null ? 'unavailable'
    : `${formatQuantity(speed, 'wind', undefined, system)}${direction === null || speed === 0 ? '' : ` from ${compassDegrees(direction)}`}`;
  const fineTerrainDetail =
    reading.fineTerrainM != null && reading.terrainDeltaM != null && Math.abs(reading.terrainDeltaM) >= 5
      ? `Fine surface elevation ${formatQuantity(reading.fineTerrainM, 'elevation', undefined, system)} MSL (${reading.terrainDeltaM > 0 ? '+' : ''}${formatQuantity(reading.terrainDeltaM, 'elevation', undefined, system)} vs model ground)`
      : reading.fineTerrainM != null
        ? `Fine surface elevation ${formatQuantity(reading.fineTerrainM, 'elevation', undefined, system)} MSL`
        : null;
  const shift = reading.surfaceWindShift;
  const shiftDetail = shift
    ? `1h surface wind shift (${formatQuantity(knotsToMps(shift.deltaKt), 'wind', undefined, system)}, ${shift.shiftDeg}°)`
    : null;
  return [
    `Model surface wind ${wind(reading.surfaceWindSpeedMps, reading.surfaceWindDirectionDeg)}`,
    reading.gustKt === null ? null : `${view.gustLabel} ${barbSpeed(reading.gustKt, system)}`,
    shiftDetail,
    reading.precipitationMmHr === null ? 'Precipitation rate unavailable' : `${rainLabel} ${formatQuantity(reading.precipitationMmHr, 'rainRate', undefined, system)}`,
    reading.warmLayerAloft ? 'Warm layer aloft (>0.5 °C above sub-freezing layer)' : null,
    `${view.capeLabel} ${reading.capeJkg === null ? 'unavailable' : `${Math.round(reading.capeJkg)} J/kg`}`,
    fineTerrainDetail,
    ...([['Model ground', reading.modelTerrainM], ['Native potential cloud base (surface LCL)', reading.cloudBaseM],
      ['Native effective cloud limit', reading.effectiveCloudLimitM],
      ['Native thermal top (parcel)', reading.nativeThermalTopM],
      ['Model boundary-layer top', reading.modelPblTopM]] as const)
      .map(([label, height]) => height === null ? null : `${label} ${formatQuantity(height, 'elevation', undefined, system)} MSL`),
    ...(layer ? [
      `Layer mean wind ${wind(layer.meanSpeedMps, layer.meanDirectionDeg)}`,
      `Layer top wind ${wind(layer.topSpeedMps, layer.topDirectionDeg)}`,
      `Surface-to-layer-top shear ${layer.surfaceToTopShearMps === null ? 'unavailable' : formatQuantity(layer.surfaceToTopShearMps, 'wind', undefined, system)}`,
      ...(layer.maxDepartureFromSurfaceMps != null
        ? [`Maximum wind difference from surface within layer ${formatQuantity(layer.maxDepartureFromSurfaceMps, 'wind', undefined, system)}`]
        : []),
    ] : []),
  ].filter((text): text is string => text !== null);
}

export function formatWindgramReading(view: WindgramView, reading: WindgramReading, scope: 'surface' | 'height'): string[] {
  if (scope === 'surface') return surfaceDetails(view, reading);
  const system = view.unitSystem;
  return [
    reading.temperatureF == null ? 'Temperature unavailable' : `${formatQuantity(fahrenheitToCelsius(reading.temperatureF), 'temperature', 1, system)}`,
    reading.speedKt == null
      ? 'Wind unavailable'
      : reading.speedKt < 0.1
        ? 'Calm'
        : `${barbSpeed(reading.speedKt, system)}${reading.directionDeg == null ? '' : ` from ${compassDegrees(reading.directionDeg)}`}`,
    reading.windSource === null ? null : windSources[reading.windSource],
    reading.windShear === null
      ? 'Layer wind shear unavailable'
      : system === 'imperial'
        ? `Layer wind shear ${((reading.windShear.perKmMps * MPH_PER_MPS * METRES_PER_THOUSAND_FEET) / 1000).toFixed(1)} mph/1,000 ft (${formatQuantity(reading.windShear.lowerM, 'elevation', undefined, system)}–${formatQuantity(reading.windShear.upperM, 'elevation', undefined, system)} MSL)`
        : `Layer wind shear ${reading.windShear.perKmMps.toFixed(1)} m/s per km (${formatQuantity(reading.windShear.lowerM, 'elevation', undefined, system)}–${formatQuantity(reading.windShear.upperM, 'elevation', undefined, system)} MSL)`,
    reading.dewPointC === null ? 'Dew point unavailable' : `Dew point ${formatQuantity(reading.dewPointC, 'temperature', 1, system)}`,
    reading.relativeHumidityPercent === null
      ? (reading.cloudHumidityPercent != null ? `Model RH ${Math.round(reading.cloudHumidityPercent)}% (liquid RH unavailable)` : 'RH unavailable')
      : `RH ${Math.round(reading.relativeHumidityPercent)}%`,
    reading.verticalVelocityPaS === null
      ? reading.verticalVelocityUnavailableReason
      : `Vertical motion ${reading.verticalVelocityPaS.toFixed(2)} Pa/s (${reading.verticalVelocityPaS < 0 ? 'ascent' : reading.verticalVelocityPaS > 0 ? 'descent' : 'neutral'}${reading.waveVelocityMps != null && Number.isFinite(reading.waveVelocityMps) ? `, ~${formatClimbRate(Math.abs(reading.waveVelocityMps), system).replace(/^\+/, '')}` : ''}; ${reading.verticalVelocitySource === 'model-level' ? 'model level' : 'interpolated'})`,
    reading.cloud === null ? null : cloudLabels[reading.cloud],
    ...surfaceDetails(view, reading),
  ].filter((value): value is string => value !== null);
}

/** One-line readout of an hour at Top of Lift when it lies inside the scale, else 90 m above ground. */
export function formatHourReadout(view: WindgramView, hourIndex: number, system: UnitSystem): string {
  const hour = view.hours[hourIndex]!;
  const sourceHour = view.sourceHours[hourIndex]!;
  const when = formatWindgramHourStamp(view, hourIndex, hour.validAt);
  const minFloorM = Math.max(view.floorM, sourceHour.mapLift.terrainM ?? sourceHour.modelTerrainM ?? view.floorM);
  const tolM = visibleTolM(view, hourIndex);
  const inspectM = tolM ?? clamp(minFloorM + 90, minFloorM, view.topM);
  const reading = readWindgram(view, hourIndex, inspectM);
  return `${when} · ${formatPointMapLift(sourceHour.mapLift, system)} · ${formatWindgramReading(view, reading, tolM !== null ? 'height' : 'surface').join(' · ')}`;
}
