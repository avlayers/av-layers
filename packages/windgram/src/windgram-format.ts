// Unit conversions and formatting shared by the charts and readouts.

export type { UnitSystem } from '@av/client';
import type { UnitSystem } from '@av/client';
import { FEET_PER_MINUTE_TO_MPS, KNOTS_PER_MPS } from '@av/soaring';
import { KPH_PER_MPS, MPH_PER_MPS } from '@av/contracts/units';
import type { SiteForecast } from './internal-meteo.ts';

const METRES_PER_FOOT = 0.3048;
const FEET_PER_METRE = 1 / METRES_PER_FOOT;
export const METRES_PER_THOUSAND_FEET = 1000 * METRES_PER_FOOT;
const FPM_PER_MPS = 1 / FEET_PER_MINUTE_TO_MPS;

export const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));
export const svgNumber = (value: number) => Number(value.toFixed(2));

export const knotsToMps = (knots: number): number => knots / KNOTS_PER_MPS;
export const mpsToKnots = (mps: number): number => mps * KNOTS_PER_MPS;
export const celsiusToFahrenheit = (celsius: number): number => (celsius * 9) / 5 + 32;
export const fahrenheitToCelsius = (fahrenheit: number): number => (fahrenheit - 32) / 1.8;

const COMPASS_16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'] as const;
export const compass16 = (directionDeg: number): string => COMPASS_16[((Math.round(directionDeg / 22.5) % 16) + 16) % 16]!;

export function finiteScalar(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const quantityDefinitions = {
  // Inputs remain physical values: metres, kilometres, Celsius, m/s, mm, hPa,
  // and the source windgram lapse gradient in Celsius per 1,000 feet.
  elevation: { imperial: [FEET_PER_METRE, 0, 'ft', 0], metric: [1, 0, 'm', 0] },
  temperature: { imperial: [1.8, 32, '°F', 0], metric: [1, 0, '°C', 0] },
  wind: { imperial: [MPH_PER_MPS, 0, 'mph', 1], metric: [KPH_PER_MPS, 0, 'km/h', 1] },
  lift: { imperial: [FPM_PER_MPS, 0, 'ft/min', 0], metric: [1, 0, 'm/s', 2] },
  rainRate: { imperial: [1 / 25.4, 0, 'in/h', 2], metric: [1, 0, 'mm/h', 1] },
  pressure: { imperial: [1 / 33.8638866667, 0, 'inHg', 2], metric: [1, 0, 'hPa', 0] },
  lapseRate: { imperial: [1.8, 0, '°F/1,000 ft', 1], metric: [1000 / METRES_PER_THOUSAND_FEET, 0, '°C/km', 1] },
} as const;

type QuantityKind = keyof typeof quantityDefinitions;
export const unitLabel = (kind: QuantityKind, system: UnitSystem): string => quantityDefinitions[kind][system][2];

export function convertQuantity(value: number | null | undefined, kind: QuantityKind, system: UnitSystem): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const [scale, offset] = quantityDefinitions[kind][system];
  return value * scale + offset;
}

const numberFormatters = new Map<number, Intl.NumberFormat>();
function formatEnUsNumber(value: number, fractionDigits: number): string {
  let formatter = numberFormatters.get(fractionDigits);
  if (!formatter) {
    formatter = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    });
    numberFormatters.set(fractionDigits, formatter);
  }
  return formatter.format(value);
}

const ELEVATION_STEPS = [100, 200, 500, 1000, 2000, 5000] as const;
const ELEVATION_LABEL_GAP = 28;

/** Axis altitude, in display units, on the nearest hundred. */
export function roundedElevationLabel(meters: number, system: UnitSystem): string {
  const value = convertQuantity(meters, 'elevation', system);
  if (value === null) return '';
  return formatEnUsNumber(Math.round(value / 100) * 100, 0);
}

/** Regular height steps that fit the plot, in metres. */
export function elevationTickMeters(floorM: number, topM: number, system: UnitSystem, plotHeight: number): number[] {
  const floor = convertQuantity(floorM, 'elevation', system);
  const top = convertQuantity(topM, 'elevation', system);
  if (floor === null || top === null || !(top > floor) || !(plotHeight > 0)) return [];
  const room = Math.max(2, Math.floor(plotHeight / ELEVATION_LABEL_GAP));
  const raw = (top - floor) / room;
  const step = ELEVATION_STEPS.find(candidate => candidate >= raw) ?? ELEVATION_STEPS[ELEVATION_STEPS.length - 1];
  const scale = quantityDefinitions.elevation[system][0];
  const first = Math.ceil(floor / step) * step;
  const last = Math.floor(top / step) * step;
  const ticks: number[] = [];
  for (let index = 0; index <= Math.round((last - first) / step); index++) {
    const value = first + index * step;
    if (value > floor && value < top) ticks.push(value / scale);
  }
  return ticks;
}

export function formatQuantity(value: number | null | undefined, kind: QuantityKind, digits: number | undefined, system: UnitSystem): string {
  const converted = convertQuantity(value, kind, system);
  if (converted === null) return '—';
  const precision = digits ?? quantityDefinitions[kind][system][3];
  return `${formatEnUsNumber(converted, precision)} ${unitLabel(kind, system)}`;
}

/** Noun for a surface gust reading from the document's declaration; defaults to "gust". */
export function gustNoun(semantics: SiteForecast['semantics']['gust']): string {
  if (semantics === 'hourMax') return 'hour-max gust';
  if (semantics === 'instant') return 'gust sample';
  return 'gust';
}
