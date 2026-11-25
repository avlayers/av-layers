import { solarFluxFactor, sunriseSunsetInRange } from '@av/solar';
import { DAY_MINUTES, DAY_MS, type NightBounds } from './day-scale';

/** Solar ribbon colours and sunrise/sunset bounds for one local day at the map centre. */
interface RibbonStop { readonly at: number; readonly color: string }

const NIGHT = '#1c3358';
const PEAK = '#fff7d6';
const RADIANCE: readonly [number, string][] = [[0, NIGHT], [0.12, '#243f68'], [0.4, '#d7b15f'], [0.72, '#ffe3a0'], [1, PEAK]];
const FLUX_SAMPLES = 48;

export function monotonicStops(stops: readonly RibbonStop[]): readonly RibbonStop[] {
  const ordered: RibbonStop[] = [];
  for (const stop of stops) {
    const at = Math.min(100, Math.max(ordered.at(-1)?.at ?? 0, stop.at));
    const previous = ordered.at(-1);
    if (previous && at === previous.at) ordered[ordered.length - 1] = { at, color: stop.color };
    else ordered.push({ at, color: stop.color });
  }
  if (ordered[0]?.at !== 0) ordered.unshift({ at: 0, color: ordered[0]?.color ?? NIGHT });
  if (ordered.at(-1)?.at !== 100) ordered.push({ at: 100, color: ordered.at(-1)?.color ?? NIGHT });
  return ordered;
}

function hexChannel(hex: string, index: number): number {
  return Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
}

function mixHex(from: string, to: string, amount: number): string {
  const t = Math.min(1, Math.max(0, amount));
  let out = '#';
  for (let index = 0; index < 3; index++) out += Math.round(hexChannel(from, index) + (hexChannel(to, index) - hexChannel(from, index)) * t).toString(16).padStart(2, '0');
  return out;
}

function radianceColor(relative: number): string {
  const t = Math.pow(Math.min(1, Math.max(0, relative)), 1.35);
  const upper = RADIANCE.findIndex(stop => stop[0] >= t);
  if (upper <= 0) return RADIANCE[0]![1];
  const [fromAt, from] = RADIANCE[upper - 1]!;
  const [toAt, to] = RADIANCE[upper]!;
  return mixHex(from, to, (t - fromAt) / (toAt - fromAt));
}

function channelDistance(left: string, right: string): number {
  let delta = 0;
  for (let index = 0; index < 3; index++) delta += Math.abs(hexChannel(left, index) - hexChannel(right, index));
  return delta;
}

export function solarRibbonStops(latitude: number, longitude: number, startMs: number, endMs: number): readonly RibbonStop[] | null {
  if (![latitude, longitude, startMs, endMs].every(Number.isFinite) || !(endMs > startMs) || Math.abs(latitude) > 90) return null;
  const span = endMs - startMs;
  const fluxes = Array.from({ length: FLUX_SAMPLES + 1 }, (_, index) => {
    const flux = solarFluxFactor(latitude, longitude, startMs + span * index / FLUX_SAMPLES);
    return Number.isFinite(flux) ? Math.max(0, flux) : 0;
  });
  let peakIndex = 0;
  for (let index = 1; index < fluxes.length; index++) if (fluxes[index]! > fluxes[peakIndex]!) peakIndex = index;
  const peak = fluxes[peakIndex]!;
  const peakAt = peakIndex / FLUX_SAMPLES * 100;
  if (peak <= 0) return [{ at: 0, color: NIGHT }, { at: 100, color: NIGHT }];
  const samples = fluxes.map((flux, index) => ({ at: index / FLUX_SAMPLES * 100, color: radianceColor(flux / peak) }));
  const kept: RibbonStop[] = [];
  for (const stop of samples) {
    const previous = kept.at(-1);
    if (!previous || Math.abs(stop.at - peakAt) < 1e-6 || channelDistance(previous.color, stop.color) >= 20) kept.push(stop);
  }
  return monotonicStops(kept);
}

export function ribbonGradient(stops: readonly RibbonStop[]): string {
  return `linear-gradient(90deg, ${stops.map(stop => `${stop.color} ${Math.round(stop.at * 100) / 100}%`).join(', ')})`;
}

/** Sunrise and sunset as minutes after local midnight. Polar days and nights stay linear. */
export function solarMinuteBounds(latitude: number, longitude: number, day: string, offsetMinutes: number): NightBounds | null {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || !day) return null;
  const start = Date.parse(`${day}T00:00:00Z`) - offsetMinutes * 60_000;
  const span = sunriseSunsetInRange(latitude, longitude, start, start + DAY_MS);
  if (!span) return null;
  const minute = (ms: number) => Math.min(DAY_MINUTES, Math.max(0, (ms - start) / 60_000));
  const sunrise = minute(span.sunrise);
  const sunset = minute(span.sunset);
  if (!(sunset > sunrise + 30) || sunrise < 1 && sunset > DAY_MINUTES - 1) return null;
  return { sunrise, sunset };
}
