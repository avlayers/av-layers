// Format inspector readings; DOM interaction lives in windgram-dom.ts.
import { formatMapLiftCell, formatPlaceTime } from '@av/client';
import { FEET_PER_MINUTE_TO_MPS } from '@av/soaring';
import { clamp, fahrenheitToCelsius, formatQuantity, knotsToMps, type UnitSystem } from './windgram-format.ts';
import { CLOUD_RH_THRESHOLD_PERCENT } from './windgram-sampling.ts';
import type { WindgramView } from './windgram-view.ts';
import type { WindgramReading } from './scene-types.ts';

type MapLiftSummary = WindgramView['sourceHours'][number]['mapLift'];

const barbSpeed = (knots: number, system: UnitSystem) => formatQuantity(knotsToMps(knots), 'wind', undefined, system);
const compass16 = (direction: number) =>
  ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(direction / 22.5) % 16]!;
const degrees = (direction: number) => `${compass16(direction)} ${Math.round(direction) % 360}°`;
const windSources = {
  'surface-10m': 'Native 10 m wind',
  'model-level': 'Model level', interpolated: 'Interpolated',
};
const cloudLabels = {
  humidity: `Likely cloud layer from interpolated RH ≥${CLOUD_RH_THRESHOLD_PERCENT}%`, potential: 'Potential cloud base',
};

function formatClimbRate(mps: number, system: UnitSystem): string {
  if (system === 'imperial') {
    const fpm = Math.round((mps / FEET_PER_MINUTE_TO_MPS) / 5) * 5;
    return fpm > 0 ? `+${fpm.toLocaleString('en-US')} fpm` : '0 fpm';
  }
  const rounded = Math.round(mps * 10) / 10;
  return rounded > 0 ? `+${rounded.toFixed(1)} m/s` : '0.0 m/s';
}

export interface WindgramTelemetryStrip {
  readonly timeChip: string;
  readonly altChip: string;
  readonly snappedToTol: boolean;
  readonly canSnapToTol: boolean;
  readonly calloutBadge: string;
  readonly calloutMeteo: string;
  readonly calloutSoar: string;
  readonly hasPositiveClimb: boolean;
  readonly chips: readonly string[];
}

export function buildWindgramTelemetry(
  view: WindgramView,
  reading: WindgramReading,
  lift: MapLiftSummary,
  snappedToTol: boolean,
  hasTolAtHour: boolean,
): WindgramTelemetryStrip {
  const system = view.unitSystem;
  const clockRaw = formatPlaceTime(Date.parse(reading.validAt), view.offsetMinutes, 'clock');
  const split = clockRaw.indexOf(' (');
  const timeChip = split < 0 ? clockRaw : clockRaw.slice(0, split);

  const aglDisplay = snappedToTol && hasTolAtHour
    ? `${formatMapLiftCell(lift.agl, system)} AGL`
    : reading.heightAglM !== null
      ? `${formatQuantity(reading.heightAglM, 'elevation', undefined, system)} AGL`
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
  }

  const totalCloud = reading.cloudCoverTotalPercent === null
    ? null
    : Math.round(clamp(reading.cloudCoverTotalPercent, 0, 100));
  const cloudPart = reading.cloud === 'humidity'
    ? (totalCloud !== null ? `Cloud ${totalCloud}% (in layer)` : `In cloud (RH ${Math.round(reading.relativeHumidityPercent ?? CLOUD_RH_THRESHOLD_PERCENT)}%)`)
    : totalCloud !== null
      ? `Cloud ${totalCloud}%`
      : reading.relativeHumidityPercent !== null
        ? `RH ${Math.round(reading.relativeHumidityPercent)}%`
        : null;
  const calloutSoar = [climbPart, cloudPart].filter((v): v is string => v !== null).join(' · ');
  const calloutBadge = snappedToTol ? '★ TOP OF LIFT' : 'ALTITUDE';

  const chips: string[] = [];
  if (reading.surfaceWindSpeedMps !== null) {
    const sfcDir = reading.surfaceWindDirectionDeg === null || reading.surfaceWindSpeedMps === 0 ? '' : ` ${compass16(reading.surfaceWindDirectionDeg)}`;
    const gust = reading.gustKt === null ? '' : ` (G${Math.round(Number.parseFloat(barbSpeed(reading.gustKt, system)) || 0)})`;
    chips.push(`Sfc ${formatQuantity(reading.surfaceWindSpeedMps, 'wind', undefined, system)}${sfcDir}${gust}`);
  }
  if (totalCloud !== null) {
    chips.push(`Cloud ${totalCloud}%`);
  }
  if (reading.cloudBaseM !== null) {
    chips.push(`LCL ${formatQuantity(reading.cloudBaseM, 'elevation', undefined, system)}`);
  }
  if (reading.windShear !== null) {
    chips.push(`Shear ${reading.windShear.perKmMps.toFixed(1)} /km`);
  }
  if (reading.capeJkg !== null && reading.capeJkg > 0) {
    chips.push(`CAPE ${Math.round(reading.capeJkg)}`);
  }
  if (reading.precipitationMmHr !== null && reading.precipitationMmHr > 0) {
    chips.push(`Rain ${formatQuantity(reading.precipitationMmHr, 'rainRate', undefined, system)}`);
  }

  return {
    timeChip,
    altChip,
    snappedToTol,
    canSnapToTol: !snappedToTol && hasTolAtHour,
    calloutBadge,
    calloutMeteo,
    calloutSoar,
    hasPositiveClimb,
    chips,
  };
}

function surfaceDetails(view: WindgramView, reading: WindgramReading): string[] {
  const system = view.unitSystem;
  const rainLabel = view.precipitationSemantics === 'instantRate' ? 'Rain rate sample'
    : view.precipitationSemantics === 'windowMeanRate' ? 'Mean rain rate (preceding interval)' : 'Rain rate (timing unspecified)';
  const layer = reading.publishedLayerWind;
  const wind = (speed: number | null, direction: number | null) => speed === null ? 'unavailable'
    : `${formatQuantity(speed, 'wind', undefined, system)}${direction === null || speed === 0 ? '' : ` from ${degrees(direction)}`}`;
  return [
    `Model surface wind ${wind(reading.surfaceWindSpeedMps, reading.surfaceWindDirectionDeg)}`,
    reading.gustKt === null ? null : `${view.gustLabel} ${barbSpeed(reading.gustKt, system)}`,
    reading.precipitationMmHr === null ? 'Rain rate unavailable' : `${rainLabel} ${formatQuantity(reading.precipitationMmHr, 'rainRate', undefined, system)}`,
    `${view.capeLabel} ${reading.capeJkg === null ? 'unavailable' : `${Math.round(reading.capeJkg)} J/kg`}`,
    ...([['Model ground', reading.modelTerrainM], ['Native potential cloud base (surface LCL)', reading.cloudBaseM],
      ['Native effective cloud limit', reading.effectiveCloudLimitM],
      ['Native thermal top (parcel)', reading.nativeThermalTopM],
      ['Model boundary-layer top', reading.modelPblTopM]] as const)
      .map(([label, height]) => height === null ? null : `${label} ${formatQuantity(height, 'elevation', undefined, system)} MSL`),
    ...(layer ? [`Layer mean wind ${wind(layer.meanSpeedMps, layer.meanDirectionDeg)}`,
      `Layer top wind ${wind(layer.topSpeedMps, layer.topDirectionDeg)}`,
      `Surface-to-layer-top shear ${layer.surfaceToTopShearMps === null ? 'unavailable' : formatQuantity(layer.surfaceToTopShearMps, 'wind', undefined, system)}`] : []),
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
