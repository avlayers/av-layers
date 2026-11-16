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
  return units === 'imperial' ? Math.round(metres / METRES_PER_FOOT) : metres;
}

export function windStopLabel(metres: number, units: WindUnits): string {
  return String(windStopValue(metres, units)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
