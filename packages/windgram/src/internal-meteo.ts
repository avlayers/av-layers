import type { PointFrame, pointMapLift } from '@av/client';
import { timeZoneOffsetMinutesAt } from '@av/client/timezone';
import type { UpperAirMoistureReference } from '@av/thermodynamics';
import type { WindgramReading } from './scene-types.ts';
import { METRES_PER_THOUSAND_FEET } from './windgram-format.ts';

export interface FieldNode {
  readonly altitudeM: number;
  readonly value: number;
}

export interface HourSampling {
  readonly validAt: string;
  readonly temperatureC: readonly FieldNode[];
  readonly dewPointC: readonly FieldNode[];
  readonly lapseCPer1000Ft: readonly FieldNode[];
  readonly relativeHumidityPercent: readonly FieldNode[];
  readonly cloudHumidityPercent?: readonly FieldNode[];
  readonly windU: readonly FieldNode[];
  readonly windV: readonly FieldNode[];
  readonly verticalVelocityPaS: readonly FieldNode[];
}

export interface PublishedForecastHour {
  readonly validAt: string;
  readonly modelTerrainM: number | null;
  readonly fineTerrainM?: number | null;
  readonly finePointInterpolated?: boolean;
  readonly upperAirDewpointReference?: UpperAirMoistureReference;
  readonly mapLift: ReturnType<typeof pointMapLift>;
  readonly surface: {
    readonly temperatureC: number | null;
    readonly dewPointC: number | null;
    readonly windSpeedMps: number | null;
    readonly windDirectionDeg: number | null;
    readonly windU: number | null;
    readonly windV: number | null;
    readonly windGustMps: number | null;
    readonly precipitationMmHr: number | null;
    readonly capeJkg: number | null;
    readonly pblHeightM: number | null;
    readonly cloudCoverTotalPercent: number | null;
    readonly cloudCoverLowPercent: number | null;
  };
  readonly levels: Readonly<NonNullable<PointFrame['profile']>['levels']>;
  readonly thermalTopM: number | null;
  readonly nativeUsableLiftTopM?: number | null;
  readonly thermalVelocityMps: number | null;
  readonly surfaceLclM: number | null;
  readonly mixedLayerLclM?: number | null;
  readonly effectiveCloudLimitM: number | null;
  readonly cuPotentialM?: number | null;
  readonly odPotentialM?: number | null;
  readonly buoyancyShearRatio?: number | null;
  readonly overdeveloped?: boolean | null;
  readonly cloudCapped?: boolean | null;
  readonly layerWind: WindgramReading['publishedLayerWind'];
}

export interface SiteForecast {
  readonly model: string;
  readonly site: {
    readonly latitude: number;
    readonly longitude: number;
    readonly timeZone: string;
    readonly isUtcFallback?: boolean;
  };
  readonly semantics: {
    readonly capeLabel?: string;
    readonly gust: 'hourMax' | 'instant' | null;
    readonly precipitation: 'instantRate' | 'windowMeanRate' | null;
  };
  readonly hours: readonly PublishedForecastHour[];
}

/** Environmental temperature gradient in °C per 1,000 ft between two level samples. */
export function lapseRateCPer1000Ft(
  lower: { readonly heightM: number; readonly temperatureC: number },
  upper: { readonly heightM: number; readonly temperatureC: number }
): number | null {
  const dz = upper.heightM - lower.heightM;
  if (!(dz > 0) || !Number.isFinite(lower.temperatureC) || !Number.isFinite(upper.temperatureC)) return null;
  return ((upper.temperatureC - lower.temperatureC) / dz) * METRES_PER_THOUSAND_FEET;
}

const dateFormats = new Map<string, Intl.DateTimeFormat>();
const dateKeyCache = new Map<string, string>();
/** Format an ISO timestamp as YYYY-MM-DD in the given IANA timeZone. */
export function localDateKey(iso: string, timeZone: string): string {
  const cacheKey = `${timeZone}|${iso}`;
  const cached = dateKeyCache.get(cacheKey);
  if (cached !== undefined) return cached;
  let formatter = dateFormats.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    if (dateFormats.size >= 64) dateFormats.clear();
    dateFormats.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(new Date(iso));
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  const result = `${get('year')}-${get('month')}-${get('day')}`;
  if (dateKeyCache.size >= 1024) dateKeyCache.clear();
  dateKeyCache.set(cacheKey, result);
  return result;
}

/** Convert a local clock time to UTC milliseconds. */
export function localInstantMs(dateKey: string, hour: number, timeZone: string): number {
  const [y, m, d] = dateKey.split('-').map(Number);
  const targetUtc = Date.UTC(y!, m! - 1, d!, 0, 0, 0) + hour * 3_600_000;
  if (timeZone === 'UTC' || timeZone === 'Etc/UTC') return targetUtc;
  let guess = targetUtc;
  for (let i = 0; i < 3; i++) {
    const diff = targetUtc - (guess + timeZoneOffsetMinutesAt(guess, timeZone) * 60_000);
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}
