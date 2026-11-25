import { MODEL_OPTIONS } from '@av/contracts/model-options';
import { WIND_STYLE_LABELS, type WindStyle } from '../wind/wind-model';

const THEME_INFO_STORAGE_KEY = 'av.preview.themeInfoOpen';

export const WIND_ENCODING_OPTIONS: ReadonlyArray<{ readonly id: WindStyle; readonly label: string; readonly summary: string }> = [
  { id: 'trails', label: 'Flow', summary: WIND_STYLE_LABELS.trails },
  { id: 'barbs', label: 'Barbs', summary: WIND_STYLE_LABELS.barbs },
  { id: 'hybrid', label: 'Mix', summary: WIND_STYLE_LABELS.hybrid }
];

export function modelApproxKm(modelId: string | null | undefined): number | null {
  if (!modelId) return null;
  const option = MODEL_OPTIONS.find(item => item.modelId === modelId);
  if (!option || !Number.isFinite(option.nominalDxMeters) || option.nominalDxMeters <= 0) return null;
  const step = option.nominalDxMeters < 5000 ? 500 : 1000;
  return Math.max(0.5, Math.round(option.nominalDxMeters / step) * (step / 1000));
}

export function formatModelResolutionKm(modelId: string | null | undefined): string | null {
  const km = modelApproxKm(modelId);
  return km !== null ? `${km} km` : null;
}

type ConfiguredModelId = (typeof MODEL_OPTIONS)[number]['modelId'];

const MODEL_REGION_SUBTITLES: Readonly<Record<ConfiguredModelId, string>> = {
  gfs: 'Global',
  'icon-eu': 'Europe',
  rrfs: 'North America',
  'av-wrf': 'Caucasus',
  'wrf-va-1km': 'Northern Virginia',
  hrdps: 'Canada'
};

export function modelRegionSubtitle(modelId: string | null | undefined): string | undefined {
  return modelId && modelId in MODEL_REGION_SUBTITLES ? MODEL_REGION_SUBTITLES[modelId as ConfiguredModelId] : undefined;
}

export function cleanModelDisplayLabel(label: string): string {
  return label
    .replace(/\s+\d+(?:\.\d+)?\s*km\b/i, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim();
}

export function readThemeInfoOpen(): boolean {
  try {
    return globalThis.localStorage?.getItem(THEME_INFO_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeThemeInfoOpen(open: boolean): void {
  try {
    globalThis.localStorage?.setItem(THEME_INFO_STORAGE_KEY, open ? '1' : '0');
  } catch {
    // Ignore restricted storage environments.
  }
}
