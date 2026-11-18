import { WIND_HEIGHTS } from '@av/contracts/wind-data';

export type WindStyle = 'trails' | 'barbs' | 'hybrid';
export type WindHeight = 'surface' | number | 'lift';
export type WindUnits = 'metric' | 'imperial';
export type WindStatus = 'ready' | 'loading' | 'unavailable';

export interface WindControlState {
  readonly style: WindStyle;
  readonly visible: boolean;
  readonly paused: boolean;
  readonly height: WindHeight;
}

export const WIND_STYLES: readonly WindStyle[] = ['trails', 'barbs', 'hybrid'];
export const WIND_STOPS: readonly number[] = WIND_HEIGHTS;
export const WIND_STYLE_LABELS: Record<WindStyle, string> = {
  trails: 'White trails', barbs: 'XC barbs', hybrid: 'Flow and sparse barbs'
};
export const WIND_STATUS_LABELS: Record<WindStatus, string> = {
  ready: '', loading: 'Loading wind', unavailable: 'Wind unavailable'
};
export const WIND_STORAGE_KEY = 'av.wind-controls.v1';
export const METRES_PER_FOOT = 0.3048;

/**
 * Pilot-friendly nominal imperial AGL altitudes (ft) corresponding to each canonical
 * server `WIND_HEIGHTS` level (`[20, 100, 250, 500, 750, 1000, 1500, 2000, 3000, 4000]` m),
 * giving crisp rail ticks (`100 / 800 / 3k / 13k`) and round drag steps instead of raw conversions.
 */
const IMPERIAL_NOMINAL_FEET: Readonly<Record<number, number>> = {
  20: 100,
  100: 300,
  250: 800,
  500: 1500,
  750: 2500,
  1000: 3000,
  1500: 5000,
  2000: 6500,
  3000: 10000,
  4000: 13000
};

export const isWindStyle = (value: unknown): value is WindStyle => WIND_STYLES.includes(value as WindStyle);

export function snapWindHeight(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? WIND_STOPS.reduce((best, stop) => Math.abs(stop - value) < Math.abs(best - value) ? stop : best)
    : undefined;
}

export function windHeightFromStorage(value: unknown): WindHeight | undefined {
  return value === 'surface' || value === 'lift' ? value : snapWindHeight(value);
}

export interface StoredWindPreferences {
  readonly style?: WindStyle;
  readonly visible?: boolean;
  readonly height?: WindHeight;
  readonly fixedHeight?: number;
}

export function parseWindPreferences(raw: string | null): StoredWindPreferences | null {
  try {
    const parsed = JSON.parse(raw ?? '') as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      style: isWindStyle(parsed.style) ? parsed.style : undefined,
      visible: typeof parsed.visible === 'boolean' ? parsed.visible : undefined,
      height: windHeightFromStorage(parsed.height),
      fixedHeight: snapWindHeight(parsed.fixedHeight)
    };
  } catch {
    return null;
  }
}

export function serializeWindPreferences(state: WindControlState, fixedHeight: number): string {
  return JSON.stringify({ style: state.style, visible: state.visible, height: state.height, fixedHeight });
}

export function windStopValue(metres: number, units: WindUnits): number {
  if (units !== 'imperial') return metres;
  return IMPERIAL_NOMINAL_FEET[metres] ?? Math.round(metres / METRES_PER_FOOT / 100) * 100;
}

export function windStopLabel(metres: number, units: WindUnits): string {
  return String(windStopValue(metres, units)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
