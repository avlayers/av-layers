// Format inspector readings; DOM interaction lives in windgram-dom.ts.
import { formatMapLiftCell, formatPlaceTime } from '@av/client';
import { shortTimeZoneNameAt, timeZoneOffsetMinutesAt } from '@av/client/timezone';
import { FEET_PER_MINUTE_TO_MPS } from '@av/soaring';
import { clamp, compass16, fahrenheitToCelsius, formatQuantity, knotsToMps, type UnitSystem } from './windgram-format.ts';
import { CLOUD_RH_THRESHOLD_PERCENT } from './windgram-sampling.ts';
import type { WindgramView } from './windgram-view.ts';
import type { WindgramReading } from './scene-types.ts';

type MapLiftSummary = WindgramView['sourceHours'][number]['mapLift'];

const SHORT_WEEKDAYS_UTC = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const barbSpeed = (knots: number, system: UnitSystem) => formatQuantity(knotsToMps(knots), 'wind', undefined, system);
const degrees = (direction: number) => `${compass16(direction)} ${Math.round(direction) % 360}°`;
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

  const meta: HourClockMeta = { validAt, timeChip, compactTime };
  if (hourIndex >= 0 && hourIndex < slots.length) slots[hourIndex] = meta;
  return meta;
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

export function buildWindgramTelemetry(
  view: WindgramView,
  reading: WindgramReading,
  lift: MapLiftSummary,
  snappedToTol: boolean,
  hasTolAtHour: boolean,
): WindgramTelemetryStrip {
  const system = view.unitSystem;
  const { timeChip, compactTime } = resolveHourClockMeta(view, reading.hourIndex, reading.validAt);

  const aglSuffix = reading.heightAglReference === 'model' ? 'model AGL' : 'AGL';
  const aglDisplay = snappedToTol && hasTolAtHour
    ? `${formatMapLiftCell(lift.agl, system)} AGL`
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
    if (reading.estimatedClimbMps !== null && reading.estimatedClimbMps >= 0.08) {
      climbPart = `Climb ${formatClimbRate(reading.estimatedClimbMps, system)}`;
      hasPositiveClimb = true;
    } else if (reading.peakClimbMps !== null && reading.peakClimbMps > 0) {
      climbPart = `Peak ${formatClimbRate(reading.peakClimbMps, system)}`;
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
    : `${formatQuantity(speed, 'wind', undefined, system)}${direction === null || speed === 0 ? '' : ` from ${degrees(direction)}`}`;
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
        : `${barbSpeed(reading.speedKt, system)}${reading.directionDeg == null ? '' : ` from ${degrees(reading.directionDeg)}`}`,
    reading.windSource === null ? null : windSources[reading.windSource],
    reading.windShear === null ? 'Layer wind shear unavailable' : `Layer wind shear ${reading.windShear.perKmMps.toFixed(1)} m/s per km (${formatQuantity(reading.windShear.lowerM, 'elevation', undefined, system)}–${formatQuantity(reading.windShear.upperM, 'elevation', undefined, system)} MSL)`,
    reading.dewPointC === null ? 'Dew point unavailable' : `Dew point ${formatQuantity(reading.dewPointC, 'temperature', 1, system)}`,
    reading.relativeHumidityPercent === null ? 'RH unavailable' : `RH ${Math.round(reading.relativeHumidityPercent)}%`,
    reading.verticalVelocityPaS === null ? reading.verticalVelocityUnavailableReason : `Vertical motion ${reading.verticalVelocityPaS.toFixed(2)} Pa/s (${reading.verticalVelocityPaS < 0 ? 'ascent' : reading.verticalVelocityPaS > 0 ? 'descent' : 'neutral'}; ${reading.verticalVelocitySource === 'model-level' ? 'model level' : 'interpolated'})`,
    reading.cloud === null ? null : cloudLabels[reading.cloud],
    ...surfaceDetails(view, reading),
  ].filter((value): value is string => value !== null);
}
